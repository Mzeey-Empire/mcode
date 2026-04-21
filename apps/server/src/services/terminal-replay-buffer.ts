/**
 * Always-on circular replay buffer for PTY output.
 *
 * Unlike {@link TerminalFlowControl}, which only buffers during pauses, this
 * buffer retains the most recent PTY output at all times so that reconnecting
 * WebSocket clients can replay what they missed.
 *
 * The buffer is byte-capped: when `bufferedBytes` exceeds `capBytes`, the
 * oldest chunks are evicted from the head until the total is within the cap.
 * A `droppedBytes` counter accumulates evicted bytes so callers can detect
 * whether a replay request covers a gap.
 */

/** Default replay buffer capacity: 512 KB. */
export const REPLAY_BUFFER_DEFAULT_CAP_BYTES = 512 * 1024;

/** A single (seq, bytes) entry stored in the replay buffer. */
interface ReplayChunk {
  seq: number;
  bytes: Uint8Array;
}

/**
 * Return value of {@link TerminalReplayBuffer.replay}.
 *
 * `chunks` contains all retained entries with `seq > afterSeq` in arrival
 * order. `gapped` is `true` when the requested sequence position predates the
 * oldest retained entry, meaning the client may have missed output that was
 * already evicted.
 */
export interface ReplayResult {
  chunks: ReadonlyArray<ReplayChunk>;
  gapped: boolean;
}

/**
 * Byte-capped circular replay buffer that retains recent PTY output for
 * WebSocket reconnect replay.
 *
 * Thread safety: not thread-safe — must be used from a single event-loop turn.
 */
export class TerminalReplayBuffer {
  private buffer: Array<ReplayChunk> = [];
  /** Index of the oldest unconsumed entry in `buffer`. */
  private head = 0;
  /** Running total of bytes across all retained chunks. */
  public bufferedBytes = 0;
  /** Running total of bytes dropped via cap eviction. */
  public droppedBytes = 0;
  private readonly capBytes: number;

  /**
   * Creates a new replay buffer.
   *
   * @param capBytes - Maximum bytes to retain. Defaults to
   *   {@link REPLAY_BUFFER_DEFAULT_CAP_BYTES} (512 KB).
   */
  constructor(capBytes: number = REPLAY_BUFFER_DEFAULT_CAP_BYTES) {
    this.capBytes = capBytes;
  }

  /**
   * Length of the backing array (including ghost head slots).
   * Exposed for test assertions about compaction behaviour.
   */
  get bufferLength(): number {
    return this.buffer.length;
  }

  /**
   * Records a new PTY chunk into the buffer.
   *
   * Appends the chunk, then evicts from the head until `bufferedBytes` is
   * within `capBytes`. Uses the same O(1) head-advance technique as
   * {@link TerminalFlowControl} and compacts the backing array when the ghost
   * head prefix grows large enough to matter.
   *
   * @param seq - Monotonic per-PTY sequence number assigned by the caller.
   * @param chunk - Raw bytes emitted by the PTY.
   */
  record(seq: number, chunk: Uint8Array): void {
    this.buffer.push({ seq, bytes: chunk });
    this.bufferedBytes += chunk.length;

    // Evict oldest chunks until within cap.
    while (this.bufferedBytes > this.capBytes && this.head < this.buffer.length) {
      const evicted = this.buffer[this.head++]!;
      this.bufferedBytes -= evicted.bytes.length;
      this.droppedBytes += evicted.bytes.length;
    }

    // Compact backing array when the ghost prefix is large enough to matter.
    // Mirrors the compaction threshold in TerminalFlowControl.
    if (this.head > 1024 && this.head * 2 >= this.buffer.length) {
      this.buffer = this.buffer.slice(this.head);
      this.head = 0;
    }
  }

  /**
   * Returns all retained chunks with `seq > afterSeq` along with a gap flag.
   *
   * Callers should pass the last sequence number they received. Passing `0`
   * (or any value before the first recorded seq) returns all retained chunks.
   * Passing `-1` returns everything including seq=0.
   *
   * `gapped` is `true` when bytes were dropped by cap eviction AND the oldest
   * retained chunk's seq is greater than `afterSeq`, meaning the client asked
   * for a position that is no longer in the buffer.
   *
   * @param afterSeq - Return chunks whose `seq` is strictly greater than this.
   */
  replay(afterSeq: number): ReplayResult {
    const active = this.buffer.slice(this.head);

    if (active.length === 0) {
      return { chunks: [], gapped: false };
    }

    const oldestSeq = active[0]!.seq;
    const gapped = this.droppedBytes > 0 && afterSeq < oldestSeq;

    const chunks = active.filter((c) => c.seq > afterSeq);
    return { chunks, gapped };
  }

  /**
   * Clears all buffered chunks and resets all counters.
   *
   * After a clear, {@link replay} returns `gapped: false` — a fresh buffer is
   * not considered a gap.
   */
  clear(): void {
    this.buffer = [];
    this.head = 0;
    this.bufferedBytes = 0;
    this.droppedBytes = 0;
  }
}
