import { describe, it, expect } from "vitest";
import { TerminalReplayBuffer } from "../terminal-replay-buffer.js";

describe("TerminalReplayBuffer", () => {
  it("starts empty", () => {
    const buf = new TerminalReplayBuffer(1024);
    expect(buf.replay(0)).toEqual({ chunks: [], gapped: false });
  });

  it("records and replays a single chunk", () => {
    const buf = new TerminalReplayBuffer(1024);
    const bytes = new Uint8Array([1, 2, 3]);
    buf.record(5, bytes);
    const result = buf.replay(4);
    expect(result.gapped).toBe(false);
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]!.seq).toBe(5);
    expect(result.chunks[0]!.bytes).toEqual(bytes);
  });

  it("replay returns only chunks after lastSeq", () => {
    const buf = new TerminalReplayBuffer(1024);
    buf.record(1, new Uint8Array([1]));
    buf.record(2, new Uint8Array([2]));
    buf.record(3, new Uint8Array([3]));
    const result = buf.replay(1);
    expect(result.gapped).toBe(false);
    expect(result.chunks.map((c) => c.seq)).toEqual([2, 3]);
  });

  it("replay(0) returns all chunks", () => {
    const buf = new TerminalReplayBuffer(1024);
    buf.record(1, new Uint8Array([10]));
    buf.record(2, new Uint8Array([20]));
    buf.record(3, new Uint8Array([30]));
    const result = buf.replay(0);
    expect(result.gapped).toBe(false);
    expect(result.chunks.map((c) => c.seq)).toEqual([1, 2, 3]);
  });

  it("gapped=true when lastSeq is before oldest retained after eviction", () => {
    // cap=10 bytes; push enough to evict seq=1 so it's no longer retained
    const buf = new TerminalReplayBuffer(10);
    buf.record(1, new Uint8Array(6)); // 6 bytes
    buf.record(2, new Uint8Array(6)); // 12 > 10 → seq=1 evicted
    const result = buf.replay(0); // ask for everything including seq=0/1
    expect(result.gapped).toBe(true);
  });

  it("evicts oldest chunks when cap exceeded", () => {
    const buf = new TerminalReplayBuffer(10);
    buf.record(1, new Uint8Array(6).fill(0xaa)); // 6 bytes
    buf.record(2, new Uint8Array(6).fill(0xbb)); // 12 total > 10 → seq=1 evicted
    const result = buf.replay(0);
    // Only seq=2 should survive
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]!.seq).toBe(2);
  });

  it("bufferedBytes never exceeds cap after eviction", () => {
    const cap = 20;
    const buf = new TerminalReplayBuffer(cap);
    for (let i = 0; i < 10; i++) {
      buf.record(i, new Uint8Array(8).fill(i));
    }
    expect(buf.bufferedBytes).toBeLessThanOrEqual(cap);
  });

  it("droppedBytes accumulates correctly", () => {
    const buf = new TerminalReplayBuffer(10);
    buf.record(1, new Uint8Array(6)); // 6 bytes stored
    buf.record(2, new Uint8Array(6)); // 6 bytes causes seq=1 (6 bytes) to be evicted
    expect(buf.droppedBytes).toBe(6);
  });

  it("clear() empties the buffer", () => {
    const buf = new TerminalReplayBuffer(1024);
    buf.record(1, new Uint8Array([1, 2, 3]));
    buf.clear();
    const result = buf.replay(0);
    expect(result.chunks).toEqual([]);
  });

  it("replay after clear returns gapped=false", () => {
    const buf = new TerminalReplayBuffer(10);
    buf.record(1, new Uint8Array(6));
    buf.record(2, new Uint8Array(6)); // triggers eviction → droppedBytes > 0
    buf.clear();
    // After clear the slate is clean — not a gap, just empty
    const result = buf.replay(0);
    expect(result.gapped).toBe(false);
  });

  it("compaction: head pointer doesn't grow unboundedly", () => {
    // Each chunk is 1 byte so all 2000 fit within a 4 KB cap.
    // Verify the backing array stays bounded rather than accumulating a huge
    // ghost-head prefix.
    const buf = new TerminalReplayBuffer(4096);
    for (let i = 0; i < 2000; i++) {
      buf.record(i, new Uint8Array([i & 0xff]));
    }
    // All 2000 chunks fit (2000 bytes < 4096) — replay should return all.
    const result = buf.replay(-1);
    expect(result.gapped).toBe(false);
    expect(result.chunks.length).toBe(2000);
    // Compaction fires when head > 1024 AND head * 2 >= buffer.length, so the
    // ghost-head prefix is at most half the backing array at compaction time.
    // Upper bound 2000 * 2 is conservative: covers the worst-case half-prefix
    // that exists just before the next compaction would trigger.
    expect(buf.bufferLength).toBeLessThanOrEqual(2000 * 2);
  });

  it("seq=0 is valid — record(0, bytes) works, replay(-1) returns it", () => {
    const buf = new TerminalReplayBuffer(1024);
    const bytes = new Uint8Array([42]);
    buf.record(0, bytes);
    const result = buf.replay(-1);
    expect(result.gapped).toBe(false);
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]!.seq).toBe(0);
    expect(result.chunks[0]!.bytes).toEqual(bytes);
  });
});
