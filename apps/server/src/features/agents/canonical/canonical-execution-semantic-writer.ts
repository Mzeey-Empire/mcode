import type { Database } from "bun:sqlite";
import * as NodeCrypto from "node:crypto";
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
});
const storedReceiptSchema = z.object({
  kind: z.literal("committed"),
  operationId: z.string(),
  durableRevision: z.number().int(),
});
const storedOperationSchema = z.object({
  kind: z.string(),
  input_hash: z.string(),
  receipt_json: z.string(),
});

interface SemanticHead {
  readonly execution: ExecutionIdentity;
  readonly providerId: string;
  readonly lease: ExecutionLease;
  readonly ordinal: number;
  readonly durableRevision: number;
  readonly terminal: boolean;
}

type StoredOperation = z.infer<typeof storedOperationSchema>;

class SemanticConflict extends Error {}

/** Adapts the supported execution mutations to one writer-local canonical SQLite connection. */
export class CanonicalExecutionSemanticWriter implements ExecutionSemanticWriter {
  private readonly turns: CanonicalParentTurnWrite;
  private readonly findOperation: ReturnType<Database["prepare"]>;
  private readonly insertOperation: ReturnType<Database["prepare"]>;
  private readonly updateHead: ReturnType<Database["prepare"]>;
  private bufferedPublication: Parameters<CanonicalAgentEventPublisher>[0][] | null = null;

  constructor(private readonly db: Database, private readonly publish: CanonicalAgentEventPublisher) {
    this.turns = new CanonicalParentTurnWrite(db, (events) => {
      if (this.bufferedPublication) this.bufferedPublication.push(events);
      else this.publish(events);
    });
    this.findOperation = db.prepare("SELECT kind, input_hash, receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?");
    this.insertOperation = db.prepare("INSERT INTO canonical_writer_operation_receipts (execution_id, operation_id, kind, input_hash, receipt_json) VALUES (?, ?, ?, ?, ?)");
    this.updateHead = db.prepare("UPDATE canonical_writer_operation_receipts SET receipt_json = ? WHERE execution_id = ? AND operation_id = ? AND kind = ?");
  }

  /** Commit a supported operation with a durable receipt, or reject it without changing canonical state. */
  async transact(operation: ExecutionSemanticOperation): Promise<ExecutionWriteReceipt> {
    if (!validOperation(operation)) return conflict(operation);
    const hash = fingerprint(operation);
    const replay = this.loadOperation(operation.execution.executionId, operation.operationId);
    if (replay) return this.replay(operation, hash, replay);
    try {
      if (operation.mutation.kind === "begin") return this.begin(operation, hash);
      if (operation.mutation.kind === "append-events") return this.append(operation, hash);
      if (operation.mutation.kind === "finish") return await this.finish(operation, hash);
      return conflict(operation);
    } catch (error) {
      if (error instanceof SemanticConflict) return conflict(operation);
      throw error;
    }
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
      };
      this.insertOperation.run(operation.execution.executionId, HEAD_ID, HEAD_KIND, fingerprint(head.lease), JSON.stringify(head));
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
      this.storeReceipt(operation, hash, receipt);
      return receipt;
    })());
  }

  private async finish(operation: ExecutionSemanticOperation, hash: string): Promise<ExecutionWriteReceipt> {
    const mutation = operation.mutation;
    if (mutation.kind !== "finish" || !validFinish(operation, mutation)) return conflict(operation);
    const head = this.loadHead(operation.execution.executionId);
    if (!head || !nextHead(head, operation) || head.providerId !== mutation.input.providerId) return conflict(operation);
    const result = await this.turns.finish(mutation.input, (durableSequence) => {
      const current = this.requireNextHead(operation);
      if (current.providerId !== mutation.input.providerId) throw new SemanticConflict();
      const receipt = committed(operation, durableSequence);
      this.storeHead({ ...current, ordinal: operation.ordinal, durableRevision: receipt.durableRevision, terminal: true });
      this.storeReceipt(operation, hash, receipt);
    });
    if (result.outcome !== "committed") return conflict(operation);
    const stored = this.loadOperation(operation.execution.executionId, operation.operationId);
    return stored ? this.replay(operation, hash, stored) : conflict(operation);
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

  private storeReceipt(operation: ExecutionSemanticOperation, hash: string, receipt: ExecutionWriteReceipt): void {
    this.insertOperation.run(
      operation.execution.executionId,
      operation.operationId,
      `semantic:${operation.mutation.kind}`,
      hash,
      JSON.stringify(receipt),
    );
  }

  private replay(operation: ExecutionSemanticOperation, hash: string, stored: StoredOperation): ExecutionWriteReceipt {
    if (stored.kind !== `semantic:${operation.mutation.kind}` || stored.input_hash !== hash) return conflict(operation);
    const receipt = storedReceiptSchema.parse(JSON.parse(stored.receipt_json));
    return receipt.operationId === operation.operationId && Number.isSafeInteger(receipt.durableRevision)
      ? receipt : conflict(operation);
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

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, sortJson(entry)]));
}
