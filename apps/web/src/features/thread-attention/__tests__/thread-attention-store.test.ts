import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcknowledgeSeenResult, ThreadAttention } from "@mcode/contracts";
import { mockTransport, createMockMessage, createMockThread } from "@/__tests__/mocks/transport";
import { useThreadStore } from "@/stores/threadStore";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { snapshotBuilder } from "@/features/conversation/hydration/snapshot-builder";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { threadAttentionStore } from "../thread-attention-store";
import { startThreadAttentionTracking } from "../thread-attention-tracking";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

const BEFORE = "2026-10-10T10:00:00.000Z";
const NOW = "2026-10-10T10:01:00.000Z";
const attention: ThreadAttention = {
  threadId: "a", waiting: null, lastTurn: { outcome: "completed", endedAt: NOW, sequence: 8, changedFileCount: null },
  seen: { sequence: 2, at: BEFORE },
};
let focused = true;
let stop: (() => void) | undefined;

function renderSettled(sequence: number, threadId = "a"): void {
  useThreadStore.setState((state) => ({ records: new Map(state.records).set(threadId, {
    ...createEmptyThreadRecord(), ...snapshotBuilder.build({ hasMore: false,
      messages: [createMockMessage({ id: `message-${sequence}`, thread_id: threadId, role: "assistant", sequence, outcome: "completed" })] }),
  }) }));
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); vi.clearAllMocks();
  focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  threadAttentionStore.getState().refreshOnScreen(null, null);
  threadAttentionStore.setState({ byThreadId: { a: attention }, visitBaselines: {} });
  useWorkspaceStore.setState({ activeThreadId: "a", threads: [createMockThread({ id: "a", status: "completed" })] });
  useThreadStore.setState({ records: new Map() });
  vi.mocked(mockTransport.acknowledgeSeen).mockImplementation(async (_thread, sequence) => ({
    previous: { sequence: 2, at: BEFORE }, current: { sequence, at: NOW },
  }));
});

afterEach(() => {
  stop?.(); stop = undefined;
  threadAttentionStore.getState().refreshOnScreen(null, null);
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe("on-screen thread acknowledgements", () => {
  it("uses the server sequence after a client-only error row and on the following turn", async () => {
    useThreadStore.setState({ currentThreadId: "a", runningThreadIds: new Set(["a"]), records: new Map([["a", {
      ...createEmptyThreadRecord(), runtimePhase: "running", turnExecutionId: "execution-1",
      messages: [createMockMessage({ id: "prompt-1", thread_id: "a", role: "user", sequence: 4 })],
    }]]) });
    stop = startThreadAttentionTracking();
    useThreadStore.getState().handleAgentEvent({ type: "error", threadId: "a", turnExecutionId: "execution-1", error: "Provider failed", failure: { kind: "fatal" } });
    expect(useThreadStore.getState().records.get("a")?.messages.map(({ role, sequence }) => ({ role, sequence })))
      .toEqual([{ role: "user", sequence: 4 }, { role: "system", sequence: 5 }]);
    threadAttentionStore.getState().apply({ ...attention, lastTurn: { outcome: "errored", endedAt: NOW, sequence: 3, changedFileCount: null } });
    await vi.advanceTimersByTimeAsync(150);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([]);
    useThreadStore.getState().handleTurnPersisted({ threadId: "a", messageId: null,
      settledMessage: { id: "prompt-1", sequence: 3 }, outcome: "errored", executionId: "execution-1", toolCallCount: 0, filesChanged: [] });
    await vi.advanceTimersByTimeAsync(150);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([["a", 3]]);
    expect(useThreadStore.getState().records.get("a")?.messages[0]).toMatchObject({ sequence: 4, serverSequence: 3 });

    useThreadStore.getState().addMessage(createMockMessage({ id: "assistant-2", thread_id: "a", role: "assistant", sequence: 7, outcome: "completed" }));
    await vi.advanceTimersByTimeAsync(150);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([["a", 3]]);
    useThreadStore.getState().handleTurnPersisted({ threadId: "a", messageId: "assistant-2",
      settledMessage: { id: "assistant-2", sequence: 5 }, outcome: "completed", toolCallCount: 0, filesChanged: [] });
    await vi.advanceTimersByTimeAsync(150);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([["a", 3], ["a", 5]]);
    expect(useThreadStore.getState().records.get("a")?.messages.map((message) => message.sequence)).toEqual([4, 5, 7]);
    expect(useThreadStore.getState().records.get("a")?.messages[2]).toMatchObject({ id: "assistant-2", serverSequence: 5 });
  });

  it("acknowledges a reloaded empty ending only after its actual server prompt is rendered", async () => {
    threadAttentionStore.getState().apply({ ...attention, lastTurn: { outcome: "errored", endedAt: NOW, sequence: 3, changedFileCount: null } });
    stop = startThreadAttentionTracking();
    useThreadStore.getState().handleTurnPersisted({ threadId: "a", messageId: null,
      settledMessage: { id: "unloaded-prompt", sequence: 3 }, outcome: "errored", toolCallCount: 0, filesChanged: [] });
    await vi.advanceTimersByTimeAsync(150);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([]);
    useThreadStore.setState({ records: new Map([["a", { ...createEmptyThreadRecord(),
      ...snapshotBuilder.build({ hasMore: false, messages: [createMockMessage({ id: "unloaded-prompt", thread_id: "a", role: "user", sequence: 3 })] }),
    }]]) });
    await vi.advanceTimersByTimeAsync(150);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([["a", 3]]);
  });

  it("acknowledges a turn settled only through a saved canonical batch", async () => {
    const message = createMockMessage({ id: "assistant-8", thread_id: "a", role: "assistant", sequence: 8, outcome: "completed" });
    const record = createEmptyThreadRecord();
    useThreadStore.setState({ records: new Map([["a", { ...record, canonicalAgent: { ...record.canonicalAgent, durableState: {
      ...record.canonicalAgent.durableState, items: { [message.id]: { id: message.id, threadId: "a", turnId: "turn-1", kind: "message",
        providerIdentities: [], payload: { projection: "message", message }, createdAt: NOW, updatedAt: NOW } },
    } } }]]) });
    stop = startThreadAttentionTracking();
    await vi.advanceTimersByTimeAsync(150);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([["a", 8]]);
  });

  it("waits 150ms and acknowledges loaded settled sequence 4, not server sequence 8", async () => {
    renderSettled(4); stop = startThreadAttentionTracking();
    await vi.advanceTimersByTimeAsync(149);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([]);
    expect(useWorkspaceStore.getState().threads[0]?.status).toBe("completed");
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([["a", 4]]);
    expect(threadAttentionStore.getState().byThreadId.a?.seen).toEqual({ sequence: 4, at: NOW });
    expect(useWorkspaceStore.getState().threads[0]?.status).toBe("paused");
  });

  it("does not acknowledge a turn ending while unfocused until focus returns", async () => {
    focused = false; stop = startThreadAttentionTracking();
    renderSettled(8);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([]);
    expect(threadAttentionStore.getState().byThreadId.a?.seen.sequence).toBe(2);
    focused = true; window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(150);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([["a", 8]]);
  });

  it("cancels dwell on blur and ignores hidden documents, hover loads, and fast thread switches", async () => {
    renderSettled(4); stop = startThreadAttentionTracking();
    await vi.advanceTimersByTimeAsync(100);
    focused = false; window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(100);
    focused = true;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    renderSettled(8, "hovered");
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([]);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(100);
    useWorkspaceStore.setState({ activeThreadId: "b" });
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([]);
  });

  it("hands off the previous sequence before applying the server mark and retains the visit baseline", async () => {
    let resolveResponse: ((result: AcknowledgeSeenResult) => void) | undefined;
    const response = new Promise<AcknowledgeSeenResult>((resolve) => { resolveResponse = resolve; });
    vi.mocked(mockTransport.acknowledgeSeen).mockReturnValueOnce(response);
    renderSettled(8); stop = startThreadAttentionTracking();
    await vi.advanceTimersByTimeAsync(150);
    expect(threadAttentionStore.getState().visitBaselines).toEqual({});
    expect(threadAttentionStore.getState().byThreadId.a?.seen.sequence).toBe(8);
    if (!resolveResponse) throw new Error("The acknowledgement response is not ready");
    resolveResponse({ previous: { sequence: 2, at: BEFORE }, current: { sequence: 8, at: "2026-10-10T10:01:01.000Z" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(threadAttentionStore.getState().visitBaselines).toEqual({ a: 2 });
    expect(threadAttentionStore.getState().byThreadId.a?.seen.at).toBe("2026-10-10T10:01:01.000Z");
    vi.mocked(mockTransport.acknowledgeSeen).mockResolvedValueOnce({ previous: { sequence: 8, at: NOW }, current: { sequence: 10, at: NOW } });
    renderSettled(10); await vi.advanceTimersByTimeAsync(150);
    expect(threadAttentionStore.getState().visitBaselines).toEqual({ a: 2 });
    expect(threadAttentionStore.getState().byThreadId.a?.seen.sequence).toBe(10);
  });

  it.each(["offline", "sequence_ahead"])("keeps an optimistic mark and does not retry %s", async (code) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(mockTransport.acknowledgeSeen).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    renderSettled(8); stop = startThreadAttentionTracking();
    await vi.advanceTimersByTimeAsync(150);
    focused = false; window.dispatchEvent(new Event("blur"));
    focused = true; window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(mockTransport.acknowledgeSeen).mock.calls).toEqual([["a", 8]]);
    expect(threadAttentionStore.getState().byThreadId.a?.seen.sequence).toBe(8);
    expect(warning.mock.calls.map(([message]) => message)).toEqual(["[thread-attention] acknowledgement failed"]);
  });

  it("keeps a newer push over an in-flight reconnect snapshot and never regresses an optimistic mark", () => {
    const observed = threadAttentionStore.getState().byThreadId;
    threadAttentionStore.getState().apply({ ...attention, waiting: { kind: "approval", since: NOW }, seen: { sequence: 8, at: NOW } });
    threadAttentionStore.getState().hydrate([], observed);
    expect(threadAttentionStore.getState().byThreadId.a?.waiting).toEqual({ kind: "approval", since: NOW });
    threadAttentionStore.getState().apply(attention);
    expect(threadAttentionStore.getState().byThreadId.a?.seen).toEqual({ sequence: 8, at: NOW });
  });
});
