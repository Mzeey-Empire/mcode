import { describe, it, expect, vi } from "vitest";
import { TerminalFlowControl } from "../terminal-flow-control.js";

describe("TerminalFlowControl", () => {
  it("starts un-paused and forwards bytes through the sink", () => {
    const sink = vi.fn();
    const fc = new TerminalFlowControl({ sink, highBytes: 100, lowBytes: 40 });
    fc.push(new Uint8Array([1, 2, 3]));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("buffers bytes while paused and drains them on resume", () => {
    const sink = vi.fn();
    const fc = new TerminalFlowControl({ sink, highBytes: 100, lowBytes: 40 });
    fc.pause("client-request");
    fc.push(new Uint8Array([1, 2]));
    fc.push(new Uint8Array([3, 4]));
    expect(sink).not.toHaveBeenCalled();
    fc.resume();
    // One drain call per buffered chunk, in order.
    expect(sink.mock.calls.map((c) => Array.from(c[0] as Uint8Array))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("drops oldest buffered chunks only after cap is exceeded and records dropped bytes", () => {
    const sink = vi.fn();
    const fc = new TerminalFlowControl({ sink, highBytes: 10, lowBytes: 5, bufferCapBytes: 8 });
    fc.pause("socket-buffered");
    fc.push(new Uint8Array([1, 2, 3, 4, 5])); // 5 bytes, fits in cap
    fc.push(new Uint8Array([6, 7, 8, 9]));   // would bring total to 9 > 8 → drop oldest
    expect(fc.droppedBytes).toBeGreaterThan(0);
    fc.resume();
    const drained = sink.mock.calls.flatMap((c) => Array.from(c[0] as Uint8Array));
    expect(drained.length).toBeLessThanOrEqual(8);
  });

  it("is idempotent for pause/resume", () => {
    const sink = vi.fn();
    const fc = new TerminalFlowControl({ sink, highBytes: 100, lowBytes: 40 });
    fc.pause("client-request");
    fc.pause("socket-buffered"); // second pause is fine
    fc.resume(); // clears both
    fc.resume(); // no-op
    fc.push(new Uint8Array([1]));
    expect(sink).toHaveBeenCalledOnce();
  });

  it("release() removes one source and drains only when both are clear", () => {
    const sink = vi.fn();
    const fc = new TerminalFlowControl({ sink, highBytes: 100, lowBytes: 40 });
    fc.pause("client-request");
    fc.pause("socket-buffered");
    fc.push(new Uint8Array([42]));
    fc.release("client-request"); // still held by socket-buffered
    expect(sink).not.toHaveBeenCalled();
    fc.release("socket-buffered"); // now clear → drain
    expect(sink).toHaveBeenCalledOnce();
  });
});
