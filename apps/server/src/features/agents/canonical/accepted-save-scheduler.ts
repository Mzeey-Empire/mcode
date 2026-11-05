import type { AcceptedProgressBatch, ProgressSaveFailure, SavedProgressReceipt } from "../execution/thread-progress-types.js";
import type { SaveFailureClass } from "./accepted-save-failure.js";

/** Background retries of an exhausted save never wait longer than this between attempts. */
const MAX_EXHAUSTED_RETRY_DELAY_MS = 30_000;
/** Background retries start no faster than this, so a zero retry delay cannot spin the writer. */
const MIN_EXHAUSTED_RETRY_DELAY_MS = 1_000;

/** Storage replies certify commits and cannot release a renderer effect. */
export interface AcceptedProgressWriter<WriteIntent> {
  /** `replacing` is the content rejection of this batch; when set, save its replacement form instead. */
  append(batch: AcceptedProgressBatch<WriteIntent>, replacing?: Error): Promise<SavedProgressReceipt>;
}

interface PendingSave<WriteIntent> {
  readonly batch: AcceptedProgressBatch<WriteIntent>;
  attempts: number;
  retryAt: number;
  /** A receipt observer failed; only an explicit retry may run this head again. */
  failed: boolean;
  /** Reported as exhausted; the head keeps retrying in the background with capped backoff. */
  exhausted: boolean;
  backoffs: number;
  replacing?: Error;
}

/** A shared writer runs one batch per ready thread before returning to a busy thread. */
export class AcceptedSaveScheduler<WriteIntent> {
  private readonly queues = new Map<string, PendingSave<WriteIntent>[]>();
  private readonly ready: string[] = [];
  private inFlight: Promise<void> | undefined;
  private inFlightThreadId: string | undefined;
  private readonly pausedThreads = new Set<string>();
  private wake: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly observerFailures = new Map<string, Error>();

  constructor(private readonly options: {
    readonly writer: AcceptedProgressWriter<WriteIntent>;
    readonly maxAttempts: number;
    readonly retryDelayMs: number;
    readonly classify: (error: Error) => SaveFailureClass;
    readonly onSaved: (batch: AcceptedProgressBatch<WriteIntent>, receipt: SavedProgressReceipt) => Promise<void>;
    readonly onFailure: (batch: AcceptedProgressBatch<WriteIntent>, failure: ProgressSaveFailure) => Promise<void>;
    readonly onObserverError?: (batch: AcceptedProgressBatch<WriteIntent>, error: Error) => void;
  }) {
    if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1
      || !Number.isSafeInteger(options.retryDelayMs) || options.retryDelayMs < 0) {
      throw new Error("Invalid accepted save retry policy");
    }
  }

  /** The owner has already reserved retention; enqueue never duplicates its bytes. */
  enqueue(batch: AcceptedProgressBatch<WriteIntent>): void {
    if (this.stopped) throw new Error("Accepted save scheduler is closed");
    const threadId = batch.execution.threadId;
    const queue = this.queues.get(threadId);
    if (queue?.some((entry) => entry.batch.operationId === batch.operationId)) {
      throw new Error("Accepted save operation was enqueued twice");
    }
    const pending: PendingSave<WriteIntent> = { batch, attempts: 0, retryAt: 0, failed: false, exhausted: false, backoffs: 0 };
    if (queue) queue.push(pending);
    else { this.queues.set(threadId, [pending]); this.ready.push(threadId); }
    this.schedule();
  }

  /** Try a failed or exhausted head now, with the same operation identity and immutable contents. */
  retry(threadId: string): boolean {
    const head = this.queues.get(threadId)?.[0];
    if (!head || !(head.failed || head.exhausted) || this.stopped) return false;
    head.failed = false;
    head.exhausted = false;
    head.attempts = 0;
    head.backoffs = 0;
    head.retryAt = 0;
    this.observerFailures.delete(threadId);
    this.schedule();
    return true;
  }

  /** Counts include failed/retrying entries; content is never exposed in telemetry. */
  depth(): { readonly pending: number; readonly pendingBytes: number; readonly threads: number; readonly inFlight: boolean } {
    const entries = [...this.queues.values()].flat();
    return { pending: entries.length, pendingBytes: entries.reduce((sum, entry) => sum + entry.batch.byteLength, 0),
      threads: this.queues.size, inFlight: this.inFlight !== undefined };
  }

  /** Wait for currently runnable work; a failed or exhausted tail remains retained by its owner. */
  async settle(): Promise<void> {
    while (this.inFlight || this.runnable()) {
      this.schedule();
      await this.inFlight;
    }
    const failure = this.observerFailures.values().next().value;
    if (failure) throw failure;
  }

  /** Stops dispatch after the current acknowledged write, preserving owner retention. */
  async close(): Promise<void> {
    this.stopped = true;
    if (this.wake) clearTimeout(this.wake);
    await this.inFlight;
    const failure = this.observerFailures.values().next().value;
    if (failure) throw failure;
  }

  /** Fence one deleted family, await its real in-flight append, then discard its queued suffix. */
  async discardThread(threadId: string): Promise<void> {
    this.pausedThreads.add(threadId);
    if (this.inFlightThreadId === threadId) await this.inFlight;
    this.queues.delete(threadId);
    this.observerFailures.delete(threadId);
    for (let index = this.ready.length - 1; index >= 0; index -= 1) {
      if (this.ready[index] === threadId) this.ready.splice(index, 1);
    }
    this.pausedThreads.delete(threadId);
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.inFlight) return;
    const pending = this.nextReady();
    if (!pending) { this.scheduleRetry(); return; }
    // Start on the next microtask so enqueue cannot run storage before live admission returns.
    const task = Promise.resolve().then(() => this.save(pending));
    this.inFlightThreadId = pending.batch.execution.threadId;
    this.inFlight = task.catch((cause) => this.recordObserverFailure(pending, cause)).then(() => {
      const threadId = pending.batch.execution.threadId;
      if (this.queues.has(threadId)) this.ready.push(threadId);
      this.inFlight = undefined;
      this.inFlightThreadId = undefined;
      this.schedule();
    });
  }

  private nextReady(): PendingSave<WriteIntent> | undefined {
    for (let count = this.ready.length; count > 0; count -= 1) {
      const threadId = this.ready.shift();
      if (!threadId) throw new Error("Accepted save ready queue lost a thread");
      const pending = this.queues.get(threadId)?.[0];
      if (pending && !this.pausedThreads.has(threadId) && !pending.failed && pending.retryAt <= Date.now()) return pending;
      this.ready.push(threadId);
    }
    return undefined;
  }

  private runnable(): boolean {
    return [...this.queues].some(([id, queue]) => !this.pausedThreads.has(id) && queue[0] && !queue[0].failed
      && !queue[0].exhausted && queue[0].retryAt <= Date.now());
  }

  private async save(pending: PendingSave<WriteIntent>): Promise<void> {
    pending.attempts += 1;
    let receipt: SavedProgressReceipt;
    try {
      receipt = await this.options.writer.append(pending.batch, pending.replacing);
    } catch (cause) {
      await this.recordWriteFailure(pending, cause instanceof Error ? cause : new Error("Accepted progress write failed", { cause }));
      return;
    }
    // Receipt handling failure is observable, but it is not a failed disk commit.
    await this.options.onSaved(pending.batch, receipt);
    const threadId = pending.batch.execution.threadId;
    const queue = this.queues.get(threadId);
    if (queue?.[0] !== pending) throw new Error("Accepted save lost its ordered head");
    queue.shift();
    if (queue.length === 0) {
      this.queues.delete(threadId);
      const readyIndex = this.ready.indexOf(threadId);
      if (readyIndex >= 0) this.ready.splice(readyIndex, 1);
    }
  }

  private async recordWriteFailure(pending: PendingSave<WriteIntent>, error: Error): Promise<void> {
    const failure = this.options.classify(error);
    if (failure === "content" && !pending.replacing) {
      // The rejected contents never become valid, so the replacement goes next instead of retrying them.
      pending.replacing = error;
      pending.attempts = 0;
      pending.retryAt = 0;
      return;
    }
    // A rejected replacement means the events themselves cannot be saved, so it is treated like the environment.
    pending.exhausted ||= failure !== "transient" || pending.attempts >= this.options.maxAttempts;
    pending.retryAt = Date.now() + (pending.exhausted ? this.exhaustedRetryDelay(pending) : this.options.retryDelayMs);
    await this.options.onFailure(pending.batch, { operationId: pending.batch.operationId, error, exhausted: pending.exhausted });
  }

  private exhaustedRetryDelay(pending: PendingSave<WriteIntent>): number {
    const base = Math.max(this.options.retryDelayMs, MIN_EXHAUSTED_RETRY_DELAY_MS);
    const delay = Math.min(MAX_EXHAUSTED_RETRY_DELAY_MS, base * 2 ** pending.backoffs);
    if (delay < MAX_EXHAUSTED_RETRY_DELAY_MS) pending.backoffs += 1;
    return delay;
  }

  private recordObserverFailure(pending: PendingSave<WriteIntent>, cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error("Accepted save observer failed", { cause });
    pending.failed = true;
    this.observerFailures.set(pending.batch.execution.threadId, error);
    try {
      this.options.onObserverError?.(pending.batch, error);
    } catch (reportingError) {
      this.observerFailures.set(pending.batch.execution.threadId,
        new Error("Accepted save observer error reporting failed", { cause: reportingError }));
    }
  }

  private scheduleRetry(): void {
    if (this.wake) clearTimeout(this.wake);
    const times = [...this.queues].flatMap(([id, queue]) => {
      const head = queue[0];
      return head && !this.pausedThreads.has(id) && !head.failed ? [head.retryAt] : [];
    });
    if (times.length === 0) return;
    this.wake = setTimeout(() => { this.wake = undefined; this.schedule(); }, Math.max(0, Math.min(...times) - Date.now()));
  }
}
