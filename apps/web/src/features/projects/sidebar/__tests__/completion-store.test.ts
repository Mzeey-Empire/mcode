// @vitest-environment jsdom
import { createMockThread } from "@mcode/contracts/testing";
import type { ThreadCompletionResult } from "@mcode/contracts/ws/methods";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useCompletionStore } from "../completion-store";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

const active = createMockThread({ id: "thread-1", workspace_id: "ws-1", user_completed_at: null });
const completed = { ...active, user_completed_at: "2026-10-27T10:00:03.000Z" };

/** The server's hold: the reply arrives when `ms` of fake time have passed. */
function replyAfter(ms: number, result: ThreadCompletionResult): Promise<ThreadCompletionResult> {
  return new Promise((resolve) => setTimeout(() => resolve(result), ms));
}

function entry() {
  return useCompletionStore.getState().entries.get("thread-1");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(mockTransport.completeThread).mockReset();
  vi.mocked(mockTransport.reopenThread).mockReset().mockResolvedValue(active);
  useWorkspaceStore.setState({ threads: [active], error: null });
  useCompletionStore.setState({ entries: new Map(), hoveredThreadId: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("completion store", () => {
  it("sends thread.complete with a 3 s hold at click", () => {
    vi.mocked(mockTransport.completeThread).mockReturnValue(replyAfter(3000, { ok: true, thread: completed }));

    useCompletionStore.getState().complete("thread-1");

    expect(mockTransport.completeThread).toHaveBeenCalledWith("thread-1", 3000);
    expect(entry()?.phase).toBe("holding");
  });

  it("reopens on Undo at 2.9 s and keeps the row once the cancelled reply lands", async () => {
    vi.mocked(mockTransport.completeThread).mockReturnValue(replyAfter(3000, { ok: false, refusal: "cancelled" }));
    useCompletionStore.getState().complete("thread-1");

    await vi.advanceTimersByTimeAsync(2900);
    useCompletionStore.getState().undo("thread-1");

    expect(mockTransport.reopenThread).toHaveBeenCalledWith("thread-1");
    expect(entry()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(entry()).toBeUndefined();
    expect(useWorkspaceStore.getState().threads[0]?.user_completed_at).toBeNull();
  });

  it("fails with the refusal reason and retries from there", async () => {
    vi.mocked(mockTransport.completeThread).mockReturnValueOnce(replyAfter(3000, { ok: false, refusal: "running" }));
    useCompletionStore.getState().complete("thread-1");
    await vi.advanceTimersByTimeAsync(3000);

    expect(entry()).toEqual({ phase: "failed", failure: { kind: "refused", refusal: "running", message: "The thread is running" } });

    vi.mocked(mockTransport.completeThread).mockReturnValueOnce(replyAfter(3000, { ok: true, thread: completed }));
    useCompletionStore.getState().retry("thread-1");
    expect(mockTransport.completeThread).toHaveBeenLastCalledWith("thread-1", 3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(entry()).toBeUndefined();
    expect(useWorkspaceStore.getState().threads[0]?.user_completed_at).toBe(completed.user_completed_at);
  });

  it("fails as retryable when the connection drops during the hold", async () => {
    vi.mocked(mockTransport.completeThread).mockReturnValue(
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("socket closed")), 1000)),
    );
    useCompletionStore.getState().complete("thread-1");
    await vi.advanceTimersByTimeAsync(1000);

    expect(entry()).toEqual({ phase: "failed", failure: { kind: "retryable", message: "socket closed" } });
  });

  it("releases the thread's terminals only when the server confirms", async () => {
    const clearTerminal = vi.spyOn(useTerminalStore.getState(), "clearThread");
    vi.mocked(mockTransport.completeThread).mockReturnValue(replyAfter(3000, { ok: true, thread: completed }));
    useCompletionStore.getState().complete("thread-1");

    await vi.advanceTimersByTimeAsync(2999);
    expect(clearTerminal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(clearTerminal).toHaveBeenCalledTimes(1);
    expect(clearTerminal).toHaveBeenCalledWith("thread-1");
  });

  it("keeps the row in place while the pointer rests on it when the hold ends", async () => {
    vi.mocked(mockTransport.completeThread).mockReturnValue(replyAfter(3000, { ok: true, thread: completed }));
    useCompletionStore.getState().pointerEntered("thread-1");
    useCompletionStore.getState().complete("thread-1");
    await vi.advanceTimersByTimeAsync(3000);

    expect(entry()?.phase).toBe("lingering");
    useCompletionStore.getState().pointerLeft("thread-1");
    expect(entry()).toBeUndefined();
  });
});
