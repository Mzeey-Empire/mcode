import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";

describe("threadStore textDelta batching", () => {
  beforeEach(() => {
    useThreadStore.setState({
      streamingByThread: {},
      streamingPreviewByThread: {},
      toolCallsByThread: {},
      thoughtSegmentsByThread: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("schedules one rAF for many deltas and applies combined text when the frame runs", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const tid = "thread-coalesce";
    for (let i = 0; i < 8; i++) {
      useThreadStore.getState().handleAgentEvent(tid, {
        method: "session.textDelta",
        params: { delta: String(i) },
      });
    }

    expect(queue).toHaveLength(1);
    expect(useThreadStore.getState().streamingByThread[tid]).toBeUndefined();

    queue[0]!(0);

    expect(useThreadStore.getState().streamingByThread[tid]).toBe("01234567");
  });

  it("updates streaming only for isFinalResponse deltas (skips thought segments)", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const tid = "thread-final-flag";
    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "think ", isFinalResponse: false },
    });
    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "final", isFinalResponse: true },
    });
    expect(queue).toHaveLength(1);

    queue[0]!(0);

    expect(useThreadStore.getState().streamingByThread[tid]).toBe("think final");
    expect(useThreadStore.getState().thoughtSegmentsByThread[tid]?.length).toBe(1);
    expect(useThreadStore.getState().thoughtSegmentsByThread[tid]?.[0]?.text).toBe("think ");
  });

  it("flushes pending deltas before session.turnComplete reads streaming", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    const tid = "thread-flush";
    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.textDelta",
      params: { delta: "hello " },
    });
    expect(queue).toHaveLength(1);

    useThreadStore.getState().handleAgentEvent(tid, {
      method: "session.turnComplete",
      params: { costUsd: null, tokensIn: 0, tokensOut: 0 },
    });

    expect(useThreadStore.getState().streamingByThread[tid]).toBeUndefined();
  });
});
