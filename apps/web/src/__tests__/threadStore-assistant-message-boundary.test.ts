import {
  applyLegacyThreadStoreSeed,
  getTestThreadStreaming,
  getTestThreadThoughtSegments,
} from "@/stores/thread-store-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";

/**
 * `session.assistantMessageBoundary` carries the authoritative per-message
 * classification derived from the Anthropic `stop_reason`. The tests below
 * exercise the two branches the handler must distinguish.
 */
describe("threadStore assistantMessageBoundary", () => {
  beforeEach(() => {
    applyLegacyThreadStoreSeed({
      streamingByThread: {},
      streamingPreviewByThread: {},
      toolCallsByThread: {},
      thoughtSegmentsByThread: {},
    });
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
    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "Autoclave is a sealed " },
    });
    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "pressure vessel." },
    });

    // Boundary arrives with stop_reason=end_turn → the deltas were the final
    // response, not a thought.
    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.assistantMessageBoundary",
      isFinalResponse: true,
    });

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
    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "Let me look at the file." },
    });

    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.assistantMessageBoundary",
      isFinalResponse: false,
    });

    const segs = getTestThreadThoughtSegments(tid) ?? [];
    expect(segs).toHaveLength(1);
    expect(segs[0]?.text).toBe("Let me look at the file.");
    expect(segs[0]?.endedAt).toBeTypeOf("number");
  });

  it("is a no-op when there is no open thought segment", () => {
    const tid = "thread-empty";
    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.assistantMessageBoundary",
      isFinalResponse: true,
    });
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
    applyLegacyThreadStoreSeed({
      thoughtSegmentsByThread: {
        [tid]: [{ text: "old thought", startedAt: 1, endedAt: 2 }],
      },
    });

    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.assistantMessageBoundary",
      isFinalResponse: true,
    });

    const segs = getTestThreadThoughtSegments(tid) ?? [];
    expect(segs).toEqual([{ text: "old thought", startedAt: 1, endedAt: 2 }]);
  });
});
