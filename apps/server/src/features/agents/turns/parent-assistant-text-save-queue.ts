import { logger } from "@mcode/shared";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { PARENT_ASSISTANT_TEXT_RETAINED_LIMITS, type ParentAssistantTextCheckpointQueuePolicy,
  type ParentAssistantTextCheckpointQueueScheduler, type ParentAssistantTextDurabilityMode,
  type ParentAssistantTextDurabilityUpdate, type QueuedParentAssistantText } from "./parent-assistant-text-checkpoint-store.js";
import type { ParentAssistantTextCheckpointService } from "./parent-assistant-text-checkpoint-service.js";

interface RetainedTextChunk { entries: QueuedParentAssistantText[]; bytes: number; journaled: boolean }
interface TextSaveState {
  threadId: string; sequence: number; retainedBytes: number; retainedItems: number;
  pending: RetainedTextChunk | null; chunks: RetainedTextChunk[];
  mode: ParentAssistantTextDurabilityMode; attempts: number; baselineReady: boolean;
  discarded?: boolean; barrier?: () => Promise<void>;
  timer?: unknown; retryTimer?: unknown; inFlight?: Promise<boolean>;
}
const MAX_RETAINED_TEXT_EXECUTIONS = 8;
const MAX_PENDING_TEXT_BYTES_PER_EXECUTION = 1024 * 1024;

const timers = new Map<unknown, ReturnType<typeof setTimeout>>();
const scheduler: ParentAssistantTextCheckpointQueueScheduler = {
  now: () => Date.now(), schedule: (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.set(timer, timer);
    return timer;
  },
  cancel: (handle) => { const timer = timers.get(handle); if (timer !== undefined) { clearTimeout(timer); timers.delete(handle); } },
};

/** Retain bounded accepted text while the application writer saves its ordered chunks. */
export class ParentAssistantTextSaveQueue {
  private readonly states = new Map<string, TextSaveState>();
  private readonly retention = new Map<string, { bytes: number; items: number }>();
  private closing = false;
  constructor(private readonly checkpoints: Pick<ParentAssistantTextCheckpointService,
    "appendChunk" | "restoreChunks" | "recoveryJournal">,
    private readonly policy: ParentAssistantTextCheckpointQueuePolicy,
    private readonly clock: ParentAssistantTextCheckpointQueueScheduler = scheduler,
    private readonly changed: (update: ParentAssistantTextDurabilityUpdate) => void = () => {}) {}

  /** Retain accepted deltas while an unavailable committed sequence is retried. */
  initializeExecution(executionId: string, threadId: string): number {
    const existing = this.states.get(executionId);
    if (existing) return existing.sequence;
    if (this.closing) throw new Error("Assistant text save queue is closing");
    if (this.states.size >= MAX_RETAINED_TEXT_EXECUTIONS) throw new Error("Assistant text retained execution capacity reached");
    const state: TextSaveState = { threadId, sequence: 0, baselineReady: false,
      retainedBytes: 0, retainedItems: 0, pending: null, chunks: [], mode: "durable", attempts: 0 };
    this.states.set(executionId, state);
    this.retention.set(executionId, { bytes: 0, items: 0 });
    try { this.recoverBaseline(executionId, state); }
    catch (cause) { this.retainFailure(executionId, state, undefined, cause); }
    return state.sequence;
  }

  /** Reserve retention and publish accepted text before scheduling any storage work. */
  enqueue(entry: QueuedParentAssistantText): boolean {
    const executionId = entry.input.executionId;
    const state = this.requireOpenExecution(executionId);
    const bytes = Buffer.byteLength(entry.input.text, "utf8");
    if (!this.admitEntry(state, entry, bytes)) return false;
    if (state.mode === "unsaved") { state.sequence = entry.input.sequence; entry.publish(); return true; }
    if (state.pending && (state.pending.entries.length >= this.policy.maxQueuedEvents
      || state.pending.bytes + bytes > this.policy.maxChunkBytes)) this.seal(executionId, state);
    if (!state.pending) {
      state.pending = { entries: [], bytes: 0, journaled: false };
      state.timer = this.clock.schedule(() => this.flushInBackground(executionId), this.policy.maxAgeMs);
    }
    state.pending.entries.push(entry);
    state.pending.bytes += bytes;
    state.retainedBytes += bytes;
    state.retainedItems += 1;
    const retained = this.retention.get(executionId);
    if (!retained) throw new Error("Assistant text retention reservation was lost");
    retained.bytes += bytes;
    retained.items += 1;
    state.sequence = entry.input.sequence;
    entry.publish();
    if (state.pending.bytes >= this.policy.maxChunkBytes || state.pending.entries.length >= this.policy.maxQueuedEvents) {
      this.seal(executionId, state);
    }
    return true;
  }

  /** Schedule earlier chunks without fencing semantic event publication behind SQLite. */
  prepareSemanticBoundary(threadId: string): boolean {
    for (const [executionId, state] of this.states) if (state.threadId === threadId) this.seal(executionId, state);
    return true;
  }

  /** Await one explicit save attempt; failure remains retained and visible. */
  async flush(executionId: string): Promise<boolean> {
    const state = this.states.get(executionId);
    if (!state) return true;
    this.seal(executionId, state);
    if (!state.inFlight && this.hasSaveWork(state)) this.startSave(executionId, state);
    if (state.inFlight && !await state.inFlight) return false;
    return this.isFlushed(state);
  }

  /** Give terminal materialization an acknowledged prefix without changing provider liveness. */
  finish(executionId: string): Promise<boolean> { return this.flush(executionId); }

  /** Install a save fence synchronously while later text publishes with its new generation's sequence. */
  classify(executionId: string, write: () => Promise<void>): Promise<void> {
    const previous = this.states.get(executionId);
    if (!previous) throw new Error("Assistant text classification execution was not initialized");
    this.seal(executionId, previous);
    const next: TextSaveState = { threadId: previous.threadId, sequence: 0, retainedBytes: 0,
      retainedItems: 0, pending: null, chunks: [], mode: "durable", attempts: 0, baselineReady: true };
    next.barrier = async () => {
      if (!await this.flushState(executionId, previous)) throw new Error("Assistant text classification awaits its preceding saves");
      await write();
      previous.discarded = true;
      this.cancelTimers(previous);
    };
    this.states.set(executionId, next);
    this.startSave(executionId, next);
    return next.inFlight!.then((saved) => { if (!saved) throw new Error("Assistant text classification remains retained for retry"); });
  }

  /** Reflect bounded retention exhaustion separately from ordinary writer failure. */
  hasStoppedForStorageFailure(executionId: string): boolean { return this.states.get(executionId)?.mode === "stopping"; }

  /** Reflect bounded retention exhaustion for the owning thread. */
  hasThreadStoppedForStorageFailure(threadId: string): boolean {
    return [...this.states.values()].some((state) => state.threadId === threadId && state.mode === "stopping");
  }

  /** Read the visible saving state for reconnect hydration. */
  durabilityMode(executionId: string): ParentAssistantTextDurabilityMode | null { return this.states.get(executionId)?.mode ?? null; }

  /** Honor an explicit unsaved continuation after retained saves fail. */
  continueWithoutSaving(executionId: string): boolean {
    const state = this.states.get(executionId);
    if (!state || state.mode !== "saving-delayed" || state.inFlight || state.barrier) return false;
    this.cancelTimers(state);
    state.discarded = true;
    this.releaseRetention(executionId, state, state.retainedBytes, state.retainedItems);
    state.chunks = []; state.pending = null; state.retainedBytes = 0; state.retainedItems = 0;
    this.setMode(executionId, state, "unsaved");
    return true;
  }

  /** Release the queue only after its equivalent terminal projection commits. */
  discard(executionId: string): void {
    const state = this.states.get(executionId);
    if (!state) return;
    this.cancelTimers(state);
    state.discarded = true;
    this.states.delete(executionId);
    this.retention.delete(executionId);
  }

  /** Stop admission and timers, then drain real commits while reporting retained failures. */
  async close(): Promise<void> {
    this.closing = true;
    let retainedFailure = false;
    for (const [executionId, state] of this.states) {
      this.cancelTimers(state);
      if (!await this.flushState(executionId, state)) retainedFailure = true;
      this.cancelTimers(state);
    }
    if (retainedFailure) throw new Error("Assistant text save queue closed with retained unsaved checkpoints");
  }

  private seal(executionId: string, state: TextSaveState): void {
    if (state.pending) { state.chunks.push(state.pending); state.pending = null; }
    if (state.timer !== undefined) { this.clock.cancel(state.timer); state.timer = undefined; }
    if (state.chunks.length > 0 && !state.inFlight && state.attempts === 0) this.startSave(executionId, state);
  }

  private requireOpenExecution(executionId: string): TextSaveState {
    if (this.closing) throw new Error("Assistant text save queue is closing");
    const state = this.states.get(executionId);
    if (!state) throw new Error("Assistant text execution was not initialized");
    return state;
  }

  private admitEntry(state: TextSaveState, entry: QueuedParentAssistantText, bytes: number): boolean {
    if (bytes === 0 || bytes > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes || entry.input.sequence !== state.sequence + 1) {
      entry.fail("Assistant text checkpoint delta has an invalid size or sequence");
      return false;
    }
    if (state.mode === "unsaved") return true;
    const retained = this.retention.get(entry.input.executionId);
    if (!retained) throw new Error("Assistant text retention reservation was lost");
    if (retained.bytes + bytes > MAX_PENDING_TEXT_BYTES_PER_EXECUTION
      || retained.items + 1 > PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxChunks) {
      this.setMode(entry.input.executionId, state, "stopping");
      entry.fail("Assistant text retained save capacity reached");
      return false;
    }
    return true;
  }

  private startSave(executionId: string, state: TextSaveState): void {
    if (state.retryTimer !== undefined) { this.clock.cancel(state.retryTimer); state.retryTimer = undefined; }
    state.inFlight = Promise.resolve().then(() => this.saveOrdered(executionId, state)).catch((cause: unknown) => {
      this.setMode(executionId, state, "saving-delayed");
      logger.error("Parent text save observer failed after its writer operation", { executionId, cause });
      return false;
    }).finally(() => {
      state.inFlight = undefined;
      if (state.discarded) return;
      if (state.chunks.length > 0 && state.attempts === 0) this.startSave(executionId, state);
    });
  }

  private async saveOrdered(executionId: string, state: TextSaveState): Promise<boolean> {
    if (state.barrier) {
      try { await state.barrier(); state.barrier = undefined; state.attempts = 0; }
      catch (cause) { this.retainFailure(executionId, state, undefined, cause); return false; }
    }
    if (!this.ensureBaseline(executionId, state)) return false;
    while (state.chunks.length > 0 && !state.discarded) {
      const chunk = state.chunks[0]!;
      try {
        const result = await this.checkpoints.appendChunk(chunk.entries.map((entry) => entry.input));
        if (result.outcome === "overflow") throw new Error("Assistant text checkpoint retained capacity reached");
      } catch (cause) {
        this.retainFailure(executionId, state, chunk, cause);
        return false;
      }
      state.chunks.shift();
      this.releaseRetention(executionId, state, chunk.bytes, chunk.entries.length);
      state.attempts = 0;
    }
    if (!state.discarded) {
      if (state.pending === null) this.checkpoints.recoveryJournal.discard(executionId);
      this.setMode(executionId, state, "durable");
    }
    return true;
  }

  private recoverBaseline(executionId: string, state: TextSaveState): void {
    const restored = this.checkpoints.restoreChunks(executionId);
    const sequence = restored.at(-1)?.lastSequence ?? 0;
    const chunks = state.pending ? [...state.chunks, state.pending] : state.chunks;
    for (const chunk of chunks) for (const entry of chunk.entries) entry.input.sequence += sequence;
    state.sequence += sequence;
    state.baselineReady = true;
    state.attempts = 0;
  }

  private ensureBaseline(executionId: string, state: TextSaveState): boolean {
    if (state.baselineReady) return true;
    try { this.recoverBaseline(executionId, state); return true; }
    catch (cause) { this.retainFailure(executionId, state, undefined, cause); return false; }
  }

  private hasSaveWork(state: TextSaveState): boolean {
    return !state.discarded && (!state.baselineReady || state.chunks.length > 0 || !!state.barrier);
  }

  private isFlushed(state: TextSaveState): boolean {
    return state.chunks.length === 0 && state.pending === null && !state.barrier && (state.baselineReady || !!state.discarded);
  }

  private retainFailure(executionId: string, state: TextSaveState, chunk: RetainedTextChunk | undefined, cause: unknown): void {
    state.attempts += 1;
    this.setMode(executionId, state, "saving-delayed");
    logger.warn("Parent assistant text save remains retained", { executionId,
      error: cause instanceof Error ? cause.message : String(cause) });
    if (chunk && !chunk.journaled && this.checkpoints.recoveryJournal.isAvailable()) {
      try { this.checkpoints.recoveryJournal.append(chunk.entries.map((entry) => entry.input)); chunk.journaled = true; }
      catch (journalError) { logger.warn("Parent assistant text recovery journal write failed", { executionId,
        error: journalError instanceof Error ? journalError.message : String(journalError) }); }
    }
    if (state.attempts < 6 && !this.closing) state.retryTimer = this.clock.schedule(() => {
      state.retryTimer = undefined;
      if (!state.discarded && !state.inFlight) this.startSave(executionId, state);
    }, 1_000);
  }

  private flushInBackground(executionId: string): void {
    void this.flush(executionId).catch((error: unknown) => logger.error("Parent text save queue observer failed", { executionId, error }));
  }

  private async flushState(executionId: string, state: TextSaveState): Promise<boolean> {
    this.seal(executionId, state);
    if (!state.inFlight && this.hasSaveWork(state)) this.startSave(executionId, state);
    if (state.inFlight && !await state.inFlight) return false;
    return this.isFlushed(state);
  }

  private setMode(executionId: string, state: TextSaveState, mode: ParentAssistantTextDurabilityMode): void {
    if (state.mode === mode) return;
    state.mode = mode;
    this.changed({ executionId, threadId: state.threadId, mode });
  }

  private releaseRetention(executionId: string, state: TextSaveState, bytes: number, items: number): void {
    state.retainedBytes -= bytes;
    state.retainedItems -= items;
    const retained = this.retention.get(executionId);
    if (retained) { retained.bytes -= bytes; retained.items -= items; }
  }

  private cancelTimers(state: TextSaveState): void {
    if (state.timer !== undefined) this.clock.cancel(state.timer);
    if (state.retryTimer !== undefined) this.clock.cancel(state.retryTimer);
    state.timer = undefined; state.retryTimer = undefined;
  }
}
