import type { AgentEvent } from "@mcode/contracts";
import {
  resetThreadStoreForTests,
  getTestThreadStreaming,
  getTestThreadThoughtSegments,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";

/**
 * `session.assistantMessageBoundary` carries the authoritative per-message
 * classification derived from the Anthropic `stop_reason`. The tests below
 * exercise the two branches the handler must distinguish.
 */
describe("threadStore assistantMessageBoundary", () => {
  beforeEach(() => {
    resetThreadStoreForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops the open thought segment when isFinalResponse is true (tool-free turn)", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const tid = "thread-final";
    // Provider could not lookahead so it streamed deltas without
    // isFinalResponse=true — they landed in the thought segment buffer.
    useThreadStore.getState().handleAgentEvent({ type: "textDelta", threadId: tid, delta: "Autoclave is a sealed " } satisfies AgentEvent);
    useThreadStore.getState().handleAgentEvent({ type: "textDelta", threadId: tid, delta: "pressure vessel." } satisfies AgentEvent);

    // Boundary arrives with stop_reason=end_turn → the deltas were the final
    // response, not a thought.
    useThreadStore.getState().handleAgentEvent({ type: "assistantMessageBoundary", threadId: tid, isFinalResponse: true } satisfies AgentEvent);

    expect(getTestThreadThoughtSegments(tid) ?? []).toEqual([]);
    expect(getTestThreadStreaming(tid)).toBe(
      "Autoclave is a sealed pressure vessel.",
    );
  });

  it("closes the open thought segment when isFinalResponse is false (preamble before tool)", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const tid = "thread-preamble";
    useThreadStore.getState().handleAgentEvent({ type: "textDelta", threadId: tid, delta: "Let me look at the file." } satisfies AgentEvent);

    useThreadStore.getState().handleAgentEvent({ type: "assistantMessageBoundary", threadId: tid, isFinalResponse: false } satisfies AgentEvent);

    const segs = getTestThreadThoughtSegments(tid) ?? [];
    expect(segs).toHaveLength(1);
    expect(segs[0]?.text).toBe("Let me look at the file.");
    expect(segs[0]?.endedAt).toBeTypeOf("number");
  });

  it("is a no-op when there is no open thought segment", () => {
    const tid = "thread-empty";
    useThreadStore.getState().handleAgentEvent({ type: "assistantMessageBoundary", threadId: tid, isFinalResponse: true } satisfies AgentEvent);
    expect(getTestThreadThoughtSegments(tid) ?? []).toEqual([]);
  });

  it("leaves an already-closed thought segment alone", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const tid = "thread-closed";
    // Seed a closed thought segment directly.
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          tid,
          {
            ...createEmptyThreadRecord(),
            thoughtSegments: [{ text: "old thought", startedAt: 1, endedAt: 2 }],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent({ type: "assistantMessageBoundary", threadId: tid, isFinalResponse: true } satisfies AgentEvent);

    const segs = getTestThreadThoughtSegments(tid) ?? [];
    expect(segs).toEqual([{ text: "old thought", startedAt: 1, endedAt: 2 }]);
  });  it("closes and later promotes the exact keyed item while preserving identical earlier narration", () => {
    const tid = "owned-items";
    resetThreadStoreForTests({ currentThreadId: tid });
    const first = `assistant-text:${"1".repeat(64)}`;
    const final = `assistant-text:${"2".repeat(64)}`;
    for (const textItemId of [first, final]) {
      useThreadStore.getState().handleAgentEvent({ type: "textDelta", threadId: tid, textItemId, delta: "Same", isFinalResponse: false });
      useThreadStore.getState().handleAgentEvent({ type: "assistantMessageBoundary", threadId: tid, textItemId, content: "Same", isFinalResponse: false });
    }
    expect(getTestThreadThoughtSegments(tid)).toMatchObject([{ id: first, endedAt: expect.any(Number) }, { id: final, endedAt: expect.any(Number) }]);
    useThreadStore.getState().handleAgentEvent({ type: "assistantMessageBoundary", threadId: tid, textItemId: final, content: "Same", isFinalResponse: true });
    expect(getTestThreadThoughtSegments(tid)).toMatchObject([{ id: first, text: "Same" }]);
  });

  it("closes final text on item completion while execution stays running", () => {
    const tid = "owned-final";
    resetThreadStoreForTests({ currentThreadId: tid });
    const textItemId = `assistant-text:${"3".repeat(64)}`;
    useThreadStore.getState().handleAgentEvent({ type: "turnStarted", threadId: tid });
    useThreadStore.getState().handleAgentEvent({ type: "textDelta", threadId: tid, textItemId, delta: "Final", isFinalResponse: true });
    useThreadStore.getState().handleAgentEvent({ type: "assistantMessageBoundary", threadId: tid, textItemId, content: "Final", isFinalResponse: true });
    useThreadStore.getState().handleAgentEvent({ type: "message", threadId: tid, content: "Final", tokens: null });
    const record = useThreadStore.getState().records.get(tid);
    expect(record?.responseTextIsStreaming).toBe(false);
    expect(record?.runtimePhase).toBe("running");
    expect(useThreadStore.getState().runningThreadIds.has(tid)).toBe(true);
    expect(record?.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    useThreadStore.getState().handleAgentEvent({ type: "turnComplete", threadId: tid, reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 });
    expect(useThreadStore.getState().runningThreadIds.has(tid)).toBe(false);
  });

  it("preserves keyed item boundaries while a background conversation defers its narration", () => {
    const tid = "background-items";
    resetThreadStoreForTests({ currentThreadId: "foreground" });
    const first = `assistant-text:${"4".repeat(64)}`;
    const second = `assistant-text:${"5".repeat(64)}`;
    for (const textItemId of [first, second]) {
      useThreadStore.getState().handleAgentEvent({ type: "textDelta", threadId: tid, textItemId, delta: "small", isFinalResponse: false });
      useThreadStore.getState().handleAgentEvent({ type: "assistantMessageBoundary", threadId: tid, textItemId, content: "small", isFinalResponse: false });
    }
    useThreadStore.setState({ currentThreadId: tid });
    useThreadStore.getState().handleAgentEvent({ type: "assistantMessageBoundary", threadId: tid, textItemId: second, content: "small", isFinalResponse: false });
    expect(getTestThreadThoughtSegments(tid)).toMatchObject([{ id: first, endedAt: expect.any(Number) }, { id: second, endedAt: expect.any(Number) }]);
  });

});
