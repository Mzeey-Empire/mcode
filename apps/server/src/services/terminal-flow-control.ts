/**
 * Per-PTY flow-control buffer for the server side.
 *
 * Two pause sources can hold the PTY:
 *   - "client-request": the client sent terminal.pause
 *   - "socket-buffered": ws.bufferedAmount crossed the server high-water mark
 *
 * While paused from either source, pushed chunks accumulate in a bounded
 * ring. When both sources release, the ring drains to the sink in FIFO order.
 * If the ring cap is exceeded, the oldest bytes are dropped — the kernel PTY
 * buffer is the primary backpressure mechanism, so this only fires when
 * the kernel buffer is insufficient.
 */

export type PauseSource = "client-request" | "socket-buffered";

/** Options for constructing a {@link TerminalFlowControl} instance. */
export interface TerminalFlowControlOptions {
  /**
   * Called with each chunk when the channel is open.
   * Receives the monotonic per-PTY sequence number assigned at push time so
   * the caller can detect gaps caused by ring-buffer eviction.
   */
  sink: (seq: number, chunk: Uint8Array) => void;
  /** High-water mark used by the socket-level coordinator. */
  highBytes: number;
  /** Low-water mark used by the socket-level coordinator. */
  lowBytes: number;
  /** Max bytes to buffer during a pause before dropping oldest. Defaults to highBytes * 4. */
  bufferCapBytes?: number;
}

/** Per-PTY backpressure buffer with multi-source pause semantics. */
export class TerminalFlowControl {
  private readonly sink: (seq: number, chunk: Uint8Array) => void;
  private readonly highBytes: number;
  private readonly lowBytes: number;
  private readonly bufferCap: number;
  private readonly pauseReasons = new Set<PauseSource>();
  /** Buffered (seq, bytes) pairs queued while paused. */
  private buffer: Array<{ seq: number; bytes: Uint8Array }> = [];
  private bufferedBytes = 0;
  /** Running count of bytes dropped because the ring was full. */
  public droppedBytes = 0;

  constructor(opts: TerminalFlowControlOptions) {
    this.sink = opts.sink;
    this.highBytes = opts.highBytes;
    this.lowBytes = opts.lowBytes;
    this.bufferCap = opts.bufferCapBytes ?? opts.highBytes * 4;
  }

  /** True while any pause source is held. */
  get paused(): boolean {
    return this.pauseReasons.size > 0;
  }

  /** Bytes currently queued waiting for resume. */
  get pending(): number {
    return this.bufferedBytes;
  }

  /** Low/high water marks (exposed so the coordinator can threshold on them). */
  get marks(): { high: number; low: number } {
    return { high: this.highBytes, low: this.lowBytes };
  }

  /** Hold the PTY under a named source. Idempotent. */
  pause(source: PauseSource): void {
    this.pauseReasons.add(source);
  }

  /**
   * Release all pause sources and drain the buffer synchronously to the sink.
   * Idempotent — safe to call when already un-paused.
   */
  resume(): void {
    this.pauseReasons.clear();
    this._drain();
  }

  /**
   * Release a single pause source. Drains only when no sources remain.
   * Idempotent — safe to call when this source is not held.
   */
  release(source: PauseSource): void {
    this.pauseReasons.delete(source);
    if (this.pauseReasons.size === 0) {
      this._drain();
    }
  }

  /**
   * Push a chunk with its pre-assigned sequence number.
   *
   * Seq is assigned by the caller at PTY data arrival time — before any
   * buffering or eviction decision. This ensures that if a chunk is later
   * evicted from the ring, the gap is visible on the wire (the seq
   * counter advances past the evicted seq numbers).
   *
   * Forwards directly to sink when open; queues when paused.
   */
  push(seq: number, chunk: Uint8Array): void {
    if (!this.paused) {
      this.sink(seq, chunk);
      return;
    }
    this.buffer.push({ seq, bytes: chunk });
    this.bufferedBytes += chunk.length;
    // Evict oldest chunks until we're within the cap.
    while (this.bufferedBytes > this.bufferCap && this.buffer.length > 0) {
      const dropped = this.buffer.shift()!;
      this.bufferedBytes -= dropped.bytes.length;
      this.droppedBytes += dropped.bytes.length;
    }
  }

  private _drain(): void {
    while (this.buffer.length > 0) {
      const item = this.buffer.shift()!;
      this.bufferedBytes -= item.bytes.length;
      this.sink(item.seq, item.bytes);
    }
  }
}
