import * as NodeCrypto from "node:crypto";
import type { CanonicalAgentEventDraft } from "../canonical/canonical-agent-boundary.js";
import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";
import { BoundedProgressRetention } from "./progress-retention-budget.js";
import type {
  AcceptedProgressBatch, AcceptedProgressEvent, ProgressRetentionBudget, ProgressRetentionLimits,
  ProgressRetentionReservation, ProgressSaveFailure, SavedProgressReceipt, ThreadProgressPosition,
  ThreadProgressSavingState,
} from "./thread-progress-types.js";

interface RetainedBatch<WriteIntent> {
  readonly batch: AcceptedProgressBatch<WriteIntent>;
  readonly reservations: readonly ProgressRetentionReservation[];
  receipt?: SavedProgressReceipt;
}

interface OperationFingerprint<Acceptance> {
  readonly contentHash: string;
  readonly through: ThreadProgressPosition;
  readonly eventIds: readonly string[];
  readonly bytes: number;
  readonly replay?: { readonly inputHash: string; readonly receipt: Acceptance; readonly bytes: number };
}

interface OriginalAcceptance<Acceptance> {
  readonly inputHash: string;
  readonly receipt: Acceptance;
  readonly bytes: number;
}

/** Prepared semantics enter this owner only after the execution's identity fence. */
export interface PreparedThreadProgress<WriteIntent> {
  readonly operationId: string;
  readonly execution: ExecutionIdentity;
  readonly events: readonly CanonicalAgentEventDraft[];
  readonly write: WriteIntent;
  readonly admission: "progress" | "control";
}

/** Admission resolves independently of the queued disk operation. */
export type ThreadProgressAcceptance<WriteIntent> =
  | { readonly kind: "accepted"; readonly batch: AcceptedProgressBatch<WriteIntent> }
  | { readonly kind: "duplicate"; readonly operationId: string; readonly through: ThreadProgressPosition }
  | { readonly kind: "rejected"; readonly reason: "routing-conflict" | "identity-conflict" | "retention-exhausted" };

/** Owns immutable progress and a retained tail beyond execution-worker release. */
export class ThreadProgressOwner<WriteIntent, Acceptance = never> {
  private readonly localBudget: BoundedProgressRetention;
  private readonly retained: RetainedBatch<WriteIntent>[] = [];
  private readonly operations = new Map<string, OperationFingerprint<Acceptance>>();
  private readonly acceptedEventIds = new Set<string>();
  private readonly sequenceByExecution = new Map<string, number>();
  private saved: ThreadProgressPosition;
  private accepted: ThreadProgressPosition;
  private durableRevision: number;
  private failure: ProgressSaveFailure | undefined;

  constructor(private readonly options: {
    readonly threadId: string;
    readonly epoch: string;
    readonly durableRevision: number;
    readonly limits: ProgressRetentionLimits;
    readonly sharedBudget: ProgressRetentionBudget;
    readonly acceptedSequenceByExecution?: ReadonlyMap<string, number>;
    readonly savedPosition?: ThreadProgressPosition;
    readonly now?: () => string;
  }) {
    this.localBudget = new BoundedProgressRetention(options.limits);
    if (options.savedPosition && options.savedPosition.epoch !== options.epoch) throw new Error("Saved progress seed belongs to another epoch");
    this.saved = options.savedPosition ?? { epoch: options.epoch, sequence: 0 };
    this.accepted = this.saved;
    this.durableRevision = options.durableRevision;
    for (const [id, sequence] of options.acceptedSequenceByExecution ?? []) this.sequenceByExecution.set(id, sequence);
  }

  /** Assign identities/order once, reserve capacity, and retain before live release. */
  accept(input: PreparedThreadProgress<WriteIntent>, validate?: (batch: AcceptedProgressBatch<WriteIntent>) => boolean,
    replay?: { readonly inputHash: string; readonly receipt: (batch: AcceptedProgressBatch<WriteIntent>) => Acceptance }): ThreadProgressAcceptance<WriteIntent> {
    if (!this.validRouting(input)) return { kind: "rejected", reason: "routing-conflict" };
    const contentHash = hash(input);
    const duplicate = this.operations.get(input.operationId);
    if (duplicate) return duplicate.contentHash === contentHash
      ? { kind: "duplicate", operationId: input.operationId, through: duplicate.through } : { kind: "rejected", reason: "identity-conflict" };
    if (this.conflictingEvents(input.events)) return { kind: "rejected", reason: "identity-conflict" };
    const prepared = this.prepareBatch(input, contentHash);
    const original = this.originalAcceptance(prepared, replay);
    const fingerprint = this.operationFingerprint(prepared, original);
    const batch = this.accountAcceptance(prepared, fingerprint.bytes);
    if (validate && !validate(batch)) return { kind: "rejected", reason: "routing-conflict" };
    const reservations = this.reserve(batch);
    if (!reservations) return { kind: "rejected", reason: "retention-exhausted" };
    this.retained.push({ batch, reservations });
    this.operations.set(batch.operationId, fingerprint);
    this.accepted = batch.through;
    for (const event of batch.events) {
      this.acceptedEventIds.add(event.draft.eventId);
      this.sequenceByExecution.set(event.draft.routing.executionId, event.acceptedSequence);
    }
    return { kind: "accepted", batch };
  }

  private originalAcceptance(batch: AcceptedProgressBatch<WriteIntent>,
    replay?: { readonly inputHash: string; readonly receipt: (batch: AcceptedProgressBatch<WriteIntent>) => Acceptance }): OriginalAcceptance<Acceptance> | undefined {
    if (!replay) return undefined;
    const receipt = freeze(structuredClone(replay.receipt(batch)));
    return { inputHash: replay.inputHash, receipt,
      bytes: Buffer.byteLength(JSON.stringify({ inputHash: replay.inputHash, receipt }), "utf8") };
  }

  private operationFingerprint(batch: AcceptedProgressBatch<WriteIntent>, original?: OriginalAcceptance<Acceptance>): OperationFingerprint<Acceptance> {
    const eventIds = batch.events.map((event) => event.draft.eventId);
    const identity = { operationId: batch.operationId, contentHash: batch.contentHash, through: batch.through, eventIds };
    // Event IDs remain in both the operation window and its conflict index after
    // saving, so both copies belong to the bounded duplicate window.
    const bytes = Buffer.byteLength(JSON.stringify(identity), "utf8")
      + Buffer.byteLength(JSON.stringify(eventIds), "utf8") + (original?.bytes ?? 0);
    return { contentHash: batch.contentHash, through: batch.through, eventIds, bytes, replay: original };
  }

  private accountAcceptance(batch: AcceptedProgressBatch<WriteIntent>, fingerprintBytes: number): AcceptedProgressBatch<WriteIntent> {
    return freeze({ ...batch, byteLength: batch.byteLength + fingerprintBytes });
  }

  /** Match the immutable producer input before regenerated timestamps or publication numbers. */
  replay(operationId: string, inputHash: string): { readonly kind: "unknown" } | { readonly kind: "conflict" }
    | { readonly kind: "duplicate"; readonly receipt: Acceptance } {
    const original = this.operations.get(operationId)?.replay;
    if (!original) return { kind: "unknown" };
    return original.inputHash === inputHash ? { kind: "duplicate", receipt: structuredClone(original.receipt) } : { kind: "conflict" };
  }

  /** Seed a completed durable command after its accepted progress has drained. */
  seedCommitted(durableRevision: number, sequences: ReadonlyMap<string, number>): void {
    if (this.retained.length > 0 || durableRevision < this.durableRevision) {
      throw new Error("A durable command cannot overtake accepted progress");
    }
    this.durableRevision = durableRevision;
    for (const [id, sequence] of sequences) this.sequenceByExecution.set(id, sequence);
  }

  /** Receipts enter the same owner as admission; gaps cannot advance saved history. */
  acknowledge(receipt: SavedProgressReceipt): boolean {
    const index = this.retained.findIndex((entry) => entry.batch.operationId === receipt.operationId);
    const pending = this.retained[index];
    if (!pending || !matchesReceipt(pending.batch, receipt) || !this.validDurableRevision(index, receipt)) return false;
    pending.receipt = receipt;
    this.advanceSavedPrefix();
    return true;
  }

  /** Preserve the original error for logging and expose delay separately from execution. */
  recordFailure(failure: ProgressSaveFailure): void {
    if (this.retained.some((entry) => entry.batch.operationId === failure.operationId)) this.failure = failure;
  }

  /** Capture the entire unsaved suffix synchronously with both watermarks. */
  recoveryCut(): {
    readonly accepted: ThreadProgressPosition;
    readonly saved: ThreadProgressPosition;
    readonly durableRevision: number;
    readonly retained: readonly AcceptedProgressBatch<WriteIntent>[];
  } {
    return { accepted: this.accepted, saved: this.saved, durableRevision: this.durableRevision,
      retained: this.retained.map((entry) => entry.batch) };
  }

  /** Release retained capacity only after deletion has fenced and settled its storage append. */
  discard(): void {
    for (const entry of this.retained) for (const reservation of entry.reservations) reservation.release();
    this.retained.length = 0;
    this.operations.clear();
    this.acceptedEventIds.clear();
    this.sequenceByExecution.clear();
    this.failure = undefined;
  }

  /** Saving receipts never contain live effects or execution lifecycle transitions. */
  savingState(): ThreadProgressSavingState {
    if (this.failure) return { kind: this.failure.exhausted ? "failed" : "delayed", saved: this.saved,
      accepted: this.accepted, durableRevision: this.durableRevision, operationId: this.failure.operationId,
      error: this.failure.error };
    if (this.retained.length === 0) return { kind: "saved", through: this.saved, durableRevision: this.durableRevision };
    return { kind: "saving", saved: this.saved, accepted: this.accepted, durableRevision: this.durableRevision };
  }

  private validRouting(input: PreparedThreadProgress<WriteIntent>): boolean {
    return input.execution.threadId === this.options.threadId && input.operationId.length > 0 && input.operationId.length <= 240
      && input.events.length > 0 && input.events.length <= 8192
      && input.events.every((event) => event.routing.threadId === input.execution.threadId
        && event.routing.executionId === input.execution.executionId && event.eventId.length > 0 && event.eventId.length <= 256);
  }

  private conflictingEvents(events: readonly CanonicalAgentEventDraft[]): boolean {
    const incomingIds = new Set<string>();
    for (const event of events) {
      if (incomingIds.has(event.eventId) || this.acceptedEventIds.has(event.eventId)) return true;
      incomingIds.add(event.eventId);
    }
    return false;
  }

  private prepareBatch(input: PreparedThreadProgress<WriteIntent>, contentHash: string): AcceptedProgressBatch<WriteIntent> {
    const acceptedAt = this.options.now?.() ?? new Date().toISOString();
    let acceptedSequence = this.sequenceByExecution.get(input.execution.executionId) ?? 0;
    const events: AcceptedProgressEvent[] = input.events.map((draft, offset) => ({
      draft: structuredClone(draft), acceptedSequence: ++acceptedSequence,
      position: { epoch: this.options.epoch, sequence: this.accepted.sequence + offset + 1 }, acceptedAt,
    }));
    const through = { epoch: this.options.epoch, sequence: this.accepted.sequence + events.length };
    const data = { operationId: input.operationId, execution: structuredClone(input.execution), contentHash,
      predecessor: this.accepted, through, events, write: structuredClone(input.write), admission: input.admission };
    return freeze({ ...data, byteLength: Buffer.byteLength(JSON.stringify(data), "utf8") });
  }

  private reserve(batch: AcceptedProgressBatch<WriteIntent>): readonly ProgressRetentionReservation[] | undefined {
    const local = this.localBudget.reserve(batch.events.length, batch.byteLength, batch.admission);
    if (!local) return undefined;
    const shared = this.options.sharedBudget.reserve(batch.events.length, batch.byteLength, batch.admission);
    if (!shared) { local.release(); return undefined; }
    return [local, shared];
  }

  private advanceSavedPrefix(): void {
    while (this.retained[0]?.receipt) {
      const entry = this.retained.shift();
      if (!entry?.receipt) throw new Error("Saved prefix lost its acknowledgement");
      this.saved = entry.batch.through;
      this.durableRevision = entry.receipt.durableRevision;
      for (const reservation of entry.reservations) reservation.release();
      if (this.failure?.operationId === entry.batch.operationId) this.failure = undefined;
    }
    this.pruneSavedIdentities();
  }

  private validDurableRevision(index: number, receipt: SavedProgressReceipt): boolean {
    if (receipt.durableRevision < this.durableRevision + index + 1) return false;
    return this.retained.every((entry, otherIndex) => !entry.receipt || otherIndex === index
      || (otherIndex < index ? entry.receipt.durableRevision < receipt.durableRevision
        : entry.receipt.durableRevision > receipt.durableRevision));
  }

  private pruneSavedIdentities(): void {
    // Keep a bounded duplicate window after save; SQLite remains the durable replay authority.
    const retainedIds = new Set(this.retained.map((entry) => entry.batch.operationId));
    let replayBytes = this.savedReplayBytes(retainedIds);
    for (const [id, fingerprint] of this.operations) {
      if (this.operations.size <= this.retained.length + 128 && replayBytes <= 256 * 1024) break;
      if (retainedIds.has(id)) continue;
      this.operations.delete(id);
      replayBytes -= fingerprint.bytes;
      for (const eventId of fingerprint.eventIds) this.acceptedEventIds.delete(eventId);
    }
    this.pruneSavedExecutions();
  }

  private pruneSavedExecutions(): void {
    const retainedExecutions = new Set(this.retained.map((entry) => entry.batch.execution.executionId));
    for (const executionId of this.sequenceByExecution.keys()) {
      if (this.sequenceByExecution.size <= retainedExecutions.size + 128) break;
      if (!retainedExecutions.has(executionId)) this.sequenceByExecution.delete(executionId);
    }
  }

  private savedReplayBytes(retainedIds: ReadonlySet<string>): number {
    return [...this.operations].reduce((sum, [id, operation]) => sum + (retainedIds.has(id) ? 0 : operation.bytes), 0);
  }
}

function matchesReceipt<WriteIntent>(batch: AcceptedProgressBatch<WriteIntent>, receipt: SavedProgressReceipt): boolean {
  return receipt.contentHash === batch.contentHash && receipt.through.epoch === batch.through.epoch
    && receipt.through.sequence === batch.through.sequence && Number.isSafeInteger(receipt.durableRevision)
    && receipt.durableRevision >= 0 && receipt.predecessor.epoch === batch.predecessor.epoch
    && receipt.predecessor.sequence === batch.predecessor.sequence;
}

function hash(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function freeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
