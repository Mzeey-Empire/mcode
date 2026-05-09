import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";

describe("threadStore textDelta batching", () => {
  beforeEach(() => {
    useThreadStore.setState({
      streamingByThread: {},
      streamingPreviewByThread: {},
      toolCallsByThread: {},
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
