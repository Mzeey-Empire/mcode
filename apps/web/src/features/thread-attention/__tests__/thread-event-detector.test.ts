import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadAttention, TurnOutcome } from "@mcode/contracts";
import { mockTransport, createMockThread } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";
import { useUiStore } from "@/stores/uiStore";
import { threadAttentionStore } from "../thread-attention-store";
import { startThreadEventDetector } from "../thread-event-detector";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

const ENDED = new Date(2026, 9, 10, 14, 32).toISOString();
const ASKED = new Date(2026, 9, 10, 14, 35).toISOString();
let stop: (() => void) | undefined;

function turn(threadId: string, sequence: number, outcome: TurnOutcome = "completed", seen: number | null = null): ThreadAttention {
  return {
    threadId, waiting: null, lastTurn: { outcome, endedAt: ENDED, sequence, changedFileCount: null },
    seen: { sequence: seen, at: null },
  };
}

function toasts(): { kind: string; title: string; meta?: string; dedupeKey?: string }[] {
  return useToastStore.getState().toasts.map(({ kind, title, meta, dedupeKey }) => ({ kind, title, meta, dedupeKey }));
}

function setRunning(...threadIds: string[]): void {
  useThreadStore.setState({ runningThreadIds: new Set(threadIds) });
}

const push = (attention: ThreadAttention): void => threadAttentionStore.getState().apply(attention);
const finishedA = { kind: "finished", title: "Refactor auth", meta: "Finished · 14:32", dedupeKey: "a" };

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.setState({ toasts: [] });
  useThreadStore.setState({ records: new Map(), runningThreadIds: new Set(), pendingStopCounts: {} });
  useUiStore.setState({ primarySurface: "pullRequests" });
  useWorkspaceStore.setState({
    activeWorkspaceId: "w2", activeThreadId: "b", pendingStartupByThreadId: {},
    threads: [
      createMockThread({ id: "a", workspace_id: "w1", title: "Refactor auth" }),
      createMockThread({ id: "b", workspace_id: "w2", title: "Fix flaky test" }),
    ],
  });
  threadAttentionStore.setState({ byThreadId: { a: turn("a", 2, "completed", 2) }, onScreenThreadId: "b" });
});

afterEach(() => {
  stop?.(); stop = undefined;
  vi.useRealTimers();
});

describe("thread event toasts", () => {
  it("toasts a turn that finishes off screen and stays quiet for the thread on screen", () => {
    stop = startThreadEventDetector();
    push(turn("b", 5));
    expect(toasts()).toEqual([]);
    push(turn("a", 4));
    expect(toasts()).toEqual([finishedA]);
  });

  it("toasts a failed turn and never an interrupted one", () => {
    stop = startThreadEventDetector();
    push(turn("a", 4, "interrupted"));
    expect(toasts()).toEqual([]);
    push(turn("a", 6, "errored"));
    expect(toasts()).toEqual([{ kind: "failed", title: "Refactor auth", meta: "Failed · 14:32", dedupeKey: "a" }]);
  });

  it("shows an approval wait and takes it back when the wait resolves", () => {
    stop = startThreadEventDetector();
    push({ ...turn("a", 2, "completed", 2), waiting: { kind: "approval", since: ASKED } });
    expect(toasts()).toEqual([{ kind: "needs-you", title: "Refactor auth", meta: "Approval required · 14:35", dedupeKey: "a" }]);
    push(turn("a", 2, "completed", 2));
    expect(toasts()).toEqual([]);
  });

  it("keeps one entry per thread when its state changes", () => {
    stop = startThreadEventDetector();
    push({ ...turn("a", 2, "completed", 2), waiting: { kind: "approval", since: ASKED } });
    push(turn("a", 4));
    expect(toasts()).toEqual([finishedA]);
  });

  it("does not replay a reconnect snapshot or duplicate a toast it already showed", () => {
    stop = startThreadEventDetector();
    push(turn("a", 4));
    const observed = threadAttentionStore.getState().byThreadId;
    threadAttentionStore.getState().hydrate([turn("a", 4), turn("b", 7, "errored"), turn("c", 3)], observed);
    expect(toasts()).toEqual([finishedA]);
  });

  it("does not toast a snapshot turn once a stale running state clears", () => {
    setRunning("a");
    stop = startThreadEventDetector();
    threadAttentionStore.getState().hydrate([turn("a", 4)], threadAttentionStore.getState().byThreadId);
    setRunning();
    expect(toasts()).toEqual([]);
  });

  it("toasts a turn that ends before its run stops, once the run stops", () => {
    setRunning("a");
    stop = startThreadEventDetector();
    push(turn("a", 4));
    expect(toasts()).toEqual([]);
    setRunning();
    expect(toasts()).toEqual([finishedA]);
    setRunning("a");
    setRunning();
    expect(toasts()).toEqual([]);
  });

  it("toasts a live turn that a reconnect snapshot kept in place", () => {
    setRunning("a");
    stop = startThreadEventDetector();
    const observed = threadAttentionStore.getState().byThreadId;
    push(turn("a", 4));
    threadAttentionStore.getState().hydrate([turn("a", 2, "completed", 2)], observed);
    setRunning();
    expect(toasts()).toEqual([finishedA]);
  });

  it("does not bring back a toast that expired", () => {
    stop = startThreadEventDetector();
    push(turn("a", 4));
    vi.advanceTimersByTime(8_000);
    setRunning("b");
    push(turn("a", 4));
    expect(toasts()).toEqual([]);
  });

  it("takes the toast back when its thread is deleted", () => {
    stop = startThreadEventDetector();
    push(turn("a", 6, "errored"));
    useWorkspaceStore.setState((state) => ({ threads: state.threads.filter((thread) => thread.id !== "a") }));
    expect(toasts()).toEqual([]);
  });

  it("takes the toast back when another client sees the turn", () => {
    stop = startThreadEventDetector();
    push(turn("a", 4));
    push(turn("a", 4, "completed", 4));
    expect(toasts()).toEqual([]);
  });

  it("takes the toast back when the thread comes on screen", () => {
    stop = startThreadEventDetector();
    push(turn("a", 4));
    threadAttentionStore.setState({ onScreenThreadId: "a" });
    expect(toasts()).toEqual([]);
  });

  it("opens the thread in its project when the toast is clicked", () => {
    stop = startThreadEventDetector();
    push(turn("a", 4));
    useToastStore.getState().toasts[0]?.onOpen?.();
    const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
    expect({ activeWorkspaceId, activeThreadId, surface: useUiStore.getState().primarySurface })
      .toEqual({ activeWorkspaceId: "w1", activeThreadId: "a", surface: "chat" });
  });
});
