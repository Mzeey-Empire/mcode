import type { Database } from "bun:sqlite";
import * as NodeCrypto from "node:crypto";
import { CanonicalAgentEventEnvelopeSchema, TurnOutcomeSchema, type TurnOutcome } from "@mcode/contracts";
import { z } from "zod";

import type { ExecutionIdentity, ExecutionLease } from "../execution/execution-mailbox-protocol.js";
import type {
  ExecutionSemanticOperation,
  ExecutionSemanticWriter,
  ExecutionWriteReceipt,
} from "../execution/execution-worker-handler.js";
import type { CanonicalAgentEventPublisher } from "./canonical-agent-boundary.js";
import { CanonicalParentTurnWrite } from "./canonical-parent-turn-write.js";

const HEAD_ID = "semantic:head";
const HEAD_KIND = "semantic-head";
const PUBLICATION_KIND = "semantic-publication";
const PENDING_FINISH_KIND = "semantic:finish-pending";
const PUBLICATION_CHUNK_SIZE = 64;
const storedPublicationSequencesSchema = z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
  .min(1).max(PUBLICATION_CHUNK_SIZE);
const storedHeadSchema = z.object({
  execution: z.object({ threadId: z.string(), turnId: z.string(), executionId: z.string() }),
  providerId: z.string(),
  lease: z.object({
    ownerEpoch: z.number().int(),
    workerIndex: z.number().int(),
    workerGeneration: z.number().int(),
    leaseId: z.string(),
  }),
  ordinal: z.number().int(),
  durableRevision: z.number().int(),
  terminal: z.boolean(),
  stopRequestId: z.string().nullable(),
  stopWatermark: z.number().int().nullable(),
  providerOutcome: TurnOutcomeSchema.nullable(),
});
const storedReceiptSchema = z.object({
  kind: z.literal("committed"),
  operationId: z.string(),
  durableRevision: z.number().int(),
  publicationVersion: z.literal(1),
});
const storedOperationSchema = z.object({
  kind: z.string(),
  input_hash: z.string(),
  receipt_json: z.string(),
});
const storedOperationListSchema = z.array(storedOperationSchema);
const storedEnvelopeRowSchema = z.object({ envelope_json: z.string() });

interface SemanticHead {
  readonly execution: ExecutionIdentity;
  readonly providerId: string;
  readonly lease: ExecutionLease;
  readonly ordinal: number;
  readonly durableRevision: number;
  readonly terminal: boolean;
  readonly stopRequestId: string | null;
  readonly stopWatermark: number | null;
  readonly providerOutcome: TurnOutcome | null;
}

type StoredOperation = z.infer<typeof storedOperationSchema>;

class SemanticConflict extends Error {}

/** Adapts the supported execution mutations to one writer-local canonical SQLite connection. */
export class CanonicalExecutionSemanticWriter implements ExecutionSemanticWriter {
  private readonly turns: CanonicalParentTurnWrite;
  private readonly findOperation: ReturnType<Database["prepare"]>;
  private readonly listPublicationChunks: ReturnType<Database["prepare"]>;
  private readonly findPublishedEvent: ReturnType<Database["prepare"]>;
  private readonly insertOperation: ReturnType<Database["prepare"]>;
  private readonly commitPendingFinish: ReturnType<Database["prepare"]>;
  private readonly updateHead: ReturnType<Database["prepare"]>;
  private readonly updateCheckpointPhase: ReturnType<Database["prepare"]>;
  private readonly updateCheckpoint: ReturnType<Database["prepare"]>;
  private bufferedPublication: Parameters<CanonicalAgentEventPublisher>[0][] | null = null;

  constructor(private readonly db: Database, private readonly publish: CanonicalAgentEventPublisher) {
    this.turns = new CanonicalParentTurnWrite(db, (events) => {
      if (this.bufferedPublication) this.bufferedPublication.push(events);
      else this.publish(events);
    });
    this.findOperation = db.prepare("SELECT kind, input_hash, receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?");
    this.listPublicationChunks = db.prepare("SELECT kind, input_hash, receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id >= ? AND operation_id < ? ORDER BY operation_id");
    this.findPublishedEvent = db.prepare("SELECT envelope_json FROM canonical_agent_events WHERE execution_id = ? AND accepted_sequence = ?");
    this.insertOperation = db.prepare("INSERT INTO canonical_writer_operation_receipts (execution_id, operation_id, kind, input_hash, receipt_json) VALUES (?, ?, ?, ?, ?)");
    this.commitPendingFinish = db.prepare("UPDATE canonical_writer_operation_receipts SET kind = ?, receipt_json = ? WHERE execution_id = ? AND operation_id = ? AND kind = ? AND input_hash = ?");
    this.updateHead = db.prepare("UPDATE canonical_writer_operation_receipts SET receipt_json = ? WHERE execution_id = ? AND operation_id = ? AND kind = ?");
    this.updateCheckpointPhase = db.prepare("UPDATE canonical_agent_ingest_checkpoints SET phase = ?, updated_at = ? WHERE execution_id = ? AND terminal_outcome IS NULL");
    this.updateCheckpoint = db.prepare("UPDATE canonical_agent_ingest_checkpoints SET phase = ?, native_cursor_json = ?, updated_at = ? WHERE execution_id = ? AND terminal_outcome IS NULL");
  }

  /** Commit a supported operation with a durable receipt, or reject it without changing canonical state. */
  async transact(operation: ExecutionSemanticOperation): Promise<ExecutionWriteReceipt> {
    if (!validOperation(operation)) return conflict(operation);
    const hash = fingerprint(operation);
    const existing = this.existingReceipt(operation, hash);
    if (existing) return existing;
    try {
      return await this.applySupported(operation, hash);
    } catch (error) {
      if (error instanceof SemanticConflict) return conflict(operation);
      throw error;
    }
  }

  private async applySupported(operation: ExecutionSemanticOperation, hash: string): Promise<ExecutionWriteReceipt> {
    switch (operation.mutation.kind) {
      case "begin": return this.begin(operation, hash);
      case "append-events": return this.append(operation, hash);
      case "checkpoint":
      case "stop-requested":
      case "provider-outcome": return this.control(operation, hash);
      case "stage-terminal": return this.stageTerminal(operation, hash);
      case "finish": return await this.finish(operation, hash);
      default: return conflict(operation);
    }
  }

  private existingReceipt(operation: ExecutionSemanticOperation, hash: string): ExecutionWriteReceipt | null {
    const row = this.loadOperation(operation.execution.executionId, operation.operationId);
    if (!row) return null;
    if (row.kind !== PENDING_FINISH_KIND) return this.replay(operation, hash, row);
    return operation.mutation.kind === "finish" && row.input_hash === hash ? null : conflict(operation);
  }

  private begin(operation: ExecutionSemanticOperation, hash: string): ExecutionWriteReceipt {
    const mutation = operation.mutation;
    if (mutation.kind !== "begin" || operation.ordinal !== 1 || this.loadHead(operation.execution.executionId)) {
      return conflict(operation);
    }
    if (mutation.providerId !== mutation.input.thread.providerId
      || mutation.input.thread.id !== operation.execution.threadId
      || mutation.input.turnId !== operation.execution.turnId
      || mutation.input.executionId !== operation.execution.executionId) return conflict(operation);
    return this.withBufferedPublication(() => this.db.transaction(() => {
      if (this.loadHead(operation.execution.executionId)) throw new SemanticConflict();
      const result = this.turns.start(mutation.input);
      if (result.outcome !== "committed") throw new SemanticConflict();
      const receipt = committed(operation, result.durableThrough);
      const head: SemanticHead = {
        execution: operation.execution,
        providerId: mutation.providerId,
        lease: operation.lease,
        ordinal: operation.ordinal,
        durableRevision: receipt.durableRevision,
        terminal: false,
        stopRequestId: null,
        stopWatermark: null,
        providerOutcome: null,
      };
      this.insertOperation.run(operation.execution.executionId, HEAD_ID, HEAD_KIND, fingerprint(head.lease), JSON.stringify(head));
      this.storePublicationChunks(operation.execution.executionId, hash, result.events.map((event) => event.acceptedSequence));
      this.storeReceipt(operation, hash, receipt);
      return receipt;
    })());
  }

  private append(operation: ExecutionSemanticOperation, hash: string): ExecutionWriteReceipt {
    const mutation = operation.mutation;
    if (mutation.kind !== "append-events" || mutation.events.length === 0
      || mutation.events.some((event) => event.routing.threadId !== operation.execution.threadId
        || event.routing.turnId !== operation.execution.turnId
        || event.routing.executionId !== operation.execution.executionId)) return conflict(operation);
    return this.withBufferedPublication(() => this.db.transaction(() => {
      const head = this.requireNextHead(operation);
      const result = this.turns.append({
        ...operation.execution,
        phase: "running",
        events: mutation.events,
      });
      if (result.outcome !== "committed") throw new SemanticConflict();
      const receipt = committed(operation, result.durableThrough);
      this.storeHead({ ...head, ordinal: operation.ordinal, durableRevision: receipt.durableRevision });
      this.storePublicationChunks(operation.execution.executionId, hash, result.events.map((event) => event.acceptedSequence));
      this.storeReceipt(operation, hash, receipt);
      return receipt;
    })());
  }

  private async finish(operation: ExecutionSemanticOperation, hash: string): Promise<ExecutionWriteReceipt> {
    const mutation = operation.mutation;
    if (mutation.kind !== "finish" || !validFinish(operation, mutation)) return conflict(operation);
    const head = this.loadHead(operation.execution.executionId);
    if (!head || !nextHead(head, operation) || head.providerId !== mutation.input.providerId) return conflict(operation);
    if (!this.validStagedFinish(operation, head)) return conflict(operation);
    this.reserveFinish(operation, hash);
    this.publishStoredEvents(operation.execution.executionId, hash);
    const result = await this.turns.finish(mutation.input, (batch) => {
      this.storePublicationChunks(operation.execution.executionId, hash, batch.publishedSequences);
      if (batch.terminal) {
        const current = this.requireNextHead(operation);
        if (current.providerId !== mutation.input.providerId) throw new SemanticConflict();
        const receipt = committed(operation, batch.durableSequence);
        this.storeHead({ ...current, ordinal: operation.ordinal, durableRevision: receipt.durableRevision, terminal: true });
        this.storeReceipt(operation, hash, receipt);
      }
    });
    if (result.outcome !== "committed") return conflict(operation);
    const stored = this.loadOperation(operation.execution.executionId, operation.operationId);
    return stored ? this.readReceipt(operation, hash, stored) : conflict(operation);
  }

  private stageTerminal(operation: ExecutionSemanticOperation, hash: string): ExecutionWriteReceipt {
    const mutation = operation.mutation;
    if (mutation.kind !== "stage-terminal" || mutation.input.threadId !== operation.execution.threadId
      || mutation.input.executionId !== operation.execution.executionId) return conflict(operation);
    return this.db.transaction(() => {
      const head = this.requireNextHead(operation);
      if (head.providerOutcome !== mutation.input.outcome) throw new SemanticConflict();
      this.turns.stageTerminalProjection(mutation.input);
      const receipt = committed(operation, head.durableRevision);
      this.storeHead({ ...head, ordinal: operation.ordinal });
      this.storeReceipt(operation, hash, receipt);
      return receipt;
    })();
  }

  private control(operation: ExecutionSemanticOperation, hash: string): ExecutionWriteReceipt {
    return this.db.transaction(() => {
      const head = this.requireNextHead(operation);
      const next = this.applyControlMutation(head, operation);
      const receipt = committed(operation, head.durableRevision);
      this.storeHead({ ...next, ordinal: operation.ordinal });
      this.storeReceipt(operation, hash, receipt);
      return receipt;
    })();
  }

  private applyControlMutation(head: SemanticHead, operation: ExecutionSemanticOperation): SemanticHead {
    const mutation = operation.mutation;
    switch (mutation.kind) {
      case "stop-requested": return this.recordStop(head, operation, mutation);
      case "provider-outcome": return this.recordProviderOutcome(head, mutation.outcome);
      case "checkpoint": return this.recordCheckpoint(head, operation.execution.executionId, mutation);
      default: throw new SemanticConflict();
    }
  }

  private recordStop(
    head: SemanticHead,
    operation: ExecutionSemanticOperation,
    mutation: Extract<ExecutionSemanticOperation["mutation"], { kind: "stop-requested" }>,
  ): SemanticHead {
    if (!mutation.requestId || head.stopRequestId || head.providerOutcome
      || mutation.lastAdmittedOrdinal !== operation.ordinal - 1) throw new SemanticConflict();
    if (this.updateCheckpointPhase.run("stopping", new Date().toISOString(), operation.execution.executionId).changes !== 1) {
      throw new SemanticConflict();
    }
    return { ...head, stopRequestId: mutation.requestId, stopWatermark: mutation.lastAdmittedOrdinal };
  }

  private recordProviderOutcome(head: SemanticHead, outcome: TurnOutcome): SemanticHead {
    if (head.providerOutcome || head.stopRequestId && outcome !== "cancelled") throw new SemanticConflict();
    return { ...head, providerOutcome: outcome };
  }

  private recordCheckpoint(
    head: SemanticHead,
    executionId: string,
    mutation: Extract<ExecutionSemanticOperation["mutation"], { kind: "checkpoint" }>,
  ): SemanticHead {
    const cursor = mutation.nativeCursor === null ? null : JSON.stringify(mutation.nativeCursor);
    if (!mutation.phase || mutation.phase.length > 64 || cursor === undefined
      || this.updateCheckpoint.run(mutation.phase, cursor, new Date().toISOString(), executionId).changes !== 1) {
      throw new SemanticConflict();
    }
    return head;
  }

  private hasStagedTerminalPredecessor(operation: ExecutionSemanticOperation): boolean {
    const previousId = `${operation.lease.leaseId}:${operation.ordinal - 1}`;
    return this.loadOperation(operation.execution.executionId, previousId)?.kind === "semantic:stage-terminal";
  }

  private validStagedFinish(operation: ExecutionSemanticOperation, head: SemanticHead): boolean {
    const mutation = operation.mutation;
    if (mutation.kind !== "finish" || !("kind" in mutation.input.projection)) return true;
    return head.providerOutcome === mutation.outcome && this.hasStagedTerminalPredecessor(operation);
  }

  private requireNextHead(operation: ExecutionSemanticOperation): SemanticHead {
    const head = this.loadHead(operation.execution.executionId);
    if (!head || !nextHead(head, operation)) throw new SemanticConflict();
    return head;
  }

  private loadHead(executionId: string): SemanticHead | null {
    const row = this.loadOperation(executionId, HEAD_ID);
    if (!row) return null;
    if (row.kind !== HEAD_KIND) throw new SemanticConflict();
    return storedHeadSchema.parse(JSON.parse(row.receipt_json));
  }

  private loadOperation(executionId: string, operationId: string): StoredOperation | null {
    return storedOperationSchema.nullable().parse(this.findOperation.get(executionId, operationId));
  }

  private storeHead(head: SemanticHead): void {
    this.updateHead.run(JSON.stringify(head), head.execution.executionId, HEAD_ID, HEAD_KIND);
  }

  private reserveFinish(operation: ExecutionSemanticOperation, hash: string): void {
    const existing = this.loadOperation(operation.execution.executionId, operation.operationId);
    if (existing) {
      if (existing.kind !== PENDING_FINISH_KIND || existing.input_hash !== hash) throw new SemanticConflict();
      return;
    }
    this.insertOperation.run(operation.execution.executionId, operation.operationId, PENDING_FINISH_KIND, hash, "{}");
  }

  private storePublicationChunks(executionId: string, hash: string, sequences: readonly number[]): void {
    for (let offset = 0; offset < sequences.length; offset += PUBLICATION_CHUNK_SIZE) {
      const chunk = sequences.slice(offset, offset + PUBLICATION_CHUNK_SIZE);
      const first = chunk[0];
      if (first === undefined) continue;
      const id = publicationChunkId(hash, first);
      const json = JSON.stringify(chunk);
      const existing = this.loadOperation(executionId, id);
      if (existing) {
        if (existing.kind !== PUBLICATION_KIND || existing.input_hash !== hash || existing.receipt_json !== json) {
          throw new SemanticConflict();
        }
        continue;
      }
      this.insertOperation.run(executionId, id, PUBLICATION_KIND, hash, json);
    }
  }

  private storeReceipt(operation: ExecutionSemanticOperation, hash: string, receipt: ExecutionWriteReceipt): void {
    const receiptJson = JSON.stringify({ ...receipt, publicationVersion: 1 });
    if (operation.mutation.kind === "finish") {
      const updated = this.commitPendingFinish.run(
        "semantic:finish", receiptJson, operation.execution.executionId, operation.operationId, PENDING_FINISH_KIND, hash,
      );
      if (updated.changes !== 1) throw new SemanticConflict();
      return;
    }
    this.insertOperation.run(
      operation.execution.executionId,
      operation.operationId,
      `semantic:${operation.mutation.kind}`,
      hash,
      receiptJson,
    );
  }

  private replay(operation: ExecutionSemanticOperation, hash: string, stored: StoredOperation): ExecutionWriteReceipt {
    const receipt = this.readReceipt(operation, hash, stored);
    if (receipt.kind === "committed") this.publishStoredEvents(operation.execution.executionId, hash);
    return receipt;
  }

  private readReceipt(operation: ExecutionSemanticOperation, hash: string, stored: StoredOperation): ExecutionWriteReceipt {
    if (stored.kind !== `semantic:${operation.mutation.kind}` || stored.input_hash !== hash) return conflict(operation);
    const receipt = storedReceiptSchema.parse(JSON.parse(stored.receipt_json));
    return receipt.operationId === operation.operationId && Number.isSafeInteger(receipt.durableRevision)
      ? committed(operation, receipt.durableRevision) : conflict(operation);
  }

  private publishStoredEvents(executionId: string, hash: string): void {
    const prefix = publicationChunkPrefix(hash);
    const chunks = storedOperationListSchema.parse(this.listPublicationChunks.all(executionId, prefix, `${prefix}~`));
    for (const chunk of chunks) {
      if (chunk.kind !== PUBLICATION_KIND || chunk.input_hash !== hash) throw new Error("Semantic publication chunk mismatch");
      const sequences = storedPublicationSequencesSchema.parse(JSON.parse(chunk.receipt_json));
      const events = sequences.map((sequence) => this.loadPublishedEvent(executionId, sequence));
      this.publish(events);
    }
  }

  private loadPublishedEvent(executionId: string, sequence: number) {
    const row = storedEnvelopeRowSchema.nullable().parse(this.findPublishedEvent.get(executionId, sequence));
    if (!row) throw new Error(`Semantic publication event missing at ${executionId}:${sequence}`);
    return CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(row.envelope_json));
  }

  // Only the synchronous begin and append transactions use this buffer. Finish publishes after each committed batch.
  private withBufferedPublication(write: () => ExecutionWriteReceipt): ExecutionWriteReceipt {
    if (this.bufferedPublication) throw new Error("Nested semantic publication buffer");
    const pending: Parameters<CanonicalAgentEventPublisher>[0][] = [];
    this.bufferedPublication = pending;
    try {
      const result = write();
      this.bufferedPublication = null;
      for (const events of pending) this.publish(events);
      return result;
    } finally {
      this.bufferedPublication = null;
    }
  }
}

function validOperation(operation: ExecutionSemanticOperation): boolean {
  return operation.operationId === `${operation.lease.leaseId}:${operation.ordinal}`
    && operation.operationId !== HEAD_ID && operation.operationId.length <= 256
    && Number.isSafeInteger(operation.ordinal) && operation.ordinal > 0
    && validIdentity(operation.execution) && validLease(operation.lease);
}

function validIdentity(identity: ExecutionIdentity): boolean {
  return Boolean(identity.threadId && identity.turnId && identity.executionId);
}

function validLease(lease: ExecutionLease): boolean {
  return Boolean(lease.leaseId) && Number.isSafeInteger(lease.ownerEpoch) && lease.ownerEpoch >= 0
    && Number.isSafeInteger(lease.workerIndex) && lease.workerIndex >= 0
    && Number.isSafeInteger(lease.workerGeneration) && lease.workerGeneration >= 0;
}

function validFinish(
  operation: ExecutionSemanticOperation,
  mutation: Extract<ExecutionSemanticOperation["mutation"], { kind: "finish" }>,
): boolean {
  return mutation.outcome === mutation.input.outcome
    && mutation.input.threadId === operation.execution.threadId
    && mutation.input.turnId === operation.execution.turnId
    && mutation.input.executionId === operation.execution.executionId;
}

function nextHead(head: SemanticHead, operation: ExecutionSemanticOperation): boolean {
  const lease = head.lease;
  const candidate = operation.lease;
  return !head.terminal && head.execution.threadId === operation.execution.threadId
    && head.execution.turnId === operation.execution.turnId
    && head.ordinal + 1 === operation.ordinal
    && lease.ownerEpoch === candidate.ownerEpoch && lease.workerIndex === candidate.workerIndex
    && lease.workerGeneration === candidate.workerGeneration && lease.leaseId === candidate.leaseId;
}

function committed(
  operation: ExecutionSemanticOperation,
  durableRevision: number,
): Extract<ExecutionWriteReceipt, { kind: "committed" }> {
  return { kind: "committed", operationId: operation.operationId, durableRevision };
}

function conflict(operation: ExecutionSemanticOperation): ExecutionWriteReceipt {
  return { kind: "conflict", operationId: operation.operationId };
}

function fingerprint(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

function publicationChunkPrefix(hash: string): string {
  return `semantic:publication:${hash}:`;
}

function publicationChunkId(hash: string, firstSequence: number): string {
  return `${publicationChunkPrefix(hash)}${firstSequence.toString().padStart(16, "0")}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, sortJson(entry)]));
}
