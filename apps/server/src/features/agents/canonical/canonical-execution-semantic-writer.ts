import type { Database } from "bun:sqlite";
import * as NodeCrypto from "node:crypto";
import {
  AgentEventSchema,
  AgentEventType,
  CanonicalAgentEventEnvelopeSchema,
  ParentNarrativeRecoveryItemSchema,
  ProviderIdSchema,
  TurnOutcomeSchema,
  type TurnOutcome,
} from "@mcode/contracts";
import { z } from "zod";

import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../../../runtime/persistence/sqlite/bounded-write-batches.js";
import type { ExecutionIdentity, ExecutionLease } from "../execution/execution-mailbox-protocol.js";
import type {
  ExecutionProviderCommitReceipt,
  ExecutionLivePublicationIntent,
  ProjectedCommittedProviderEvent,
  ExecutionSemanticOperation,
  ExecutionSemanticWriter,
  ExecutionWriteReceipt,
  ExecutionLivePublicationReceipt,
} from "../execution/execution-worker-handler.js";
import type { CanonicalAgentEventPublisher } from "./canonical-agent-boundary.js";
import { CanonicalAgentBoundary } from "./canonical-agent-boundary.js";
import { CanonicalCommittedProviderProjector } from "./canonical-committed-provider-projector.js";
import { CanonicalCodexSystemErrorProjection, matchesCodexSystemIntents } from "./canonical-codex-system-error-projection.js";
import { CanonicalContextCompactionProjection } from "./canonical-context-compaction-projection.js";
import { CanonicalParentTurnWrite, type DataOnlyParentLiveMessageInput } from "./canonical-parent-turn-write.js";
import { TaskRepo } from "../orchestration/persistence/task-repo.js";
import type { TaskToolWriteIntent } from "../tasks/task-tool-intent-reducer.js";
import {
  ParentAssistantTextCheckpointService,
  PARENT_ASSISTANT_TEXT_QUEUE_POLICY,
  type ParentAssistantTextCheckpointInput,
  type ParentAssistantTextCheckpointResult,
} from "../turns/parent-assistant-text-checkpoint-service.js";

const HEAD_ID = "semantic:head";
const HEAD_KIND = "semantic-head";
const PUBLICATION_KIND = "semantic-publication";
const PENDING_FINISH_KIND = "semantic:finish-pending";
const PUBLICATION_CHUNK_SIZE = 64;
const PUBLICATION_CHUNK_PAGE_SIZE = 16;
const MAX_BUFFERED_PUBLICATION_EVENTS = 2_048;
const MAX_LIVE_PUBLICATION_EVENTS = 64;
const MAX_LIVE_PUBLICATION_BYTES = 256 * 1024;
const MAX_LIVE_RECEIPT_BYTES = 512 * 1024;
const LIVE_RECOVERY_KINDS: ReadonlySet<ExecutionSemanticOperation["mutation"]["kind"]> = new Set([
  "append-assistant-text", "narrative-delta", "live-event",
]);
const narrativeDeltaSchema = z.object({
  executionId: z.string(),
  items: z.array(ParentNarrativeRecoveryItemSchema()),
  discardedItemIds: z.array(z.string().regex(/^(toolCall|narrationSegment|hook):.+$/)).optional(),
});
const storedTaskSchema = z.object({
  id: z.string().max(256).optional(),
  content: z.string().min(1).max(16 * 1024),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  activeForm: z.string().max(4096).optional(),
  group: z.string().max(128).optional(),
}).strict();
const taskIntentsSchema = z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upsert-group"), group: z.string().max(128),
    tasks: z.array(storedTaskSchema).max(256) }).strict(),
  z.object({ kind: z.literal("append-task"), task: storedTaskSchema }).strict(),
  z.object({ kind: z.literal("update-task"), id: z.string().min(1).max(256),
    group: z.string().max(128), patch: storedTaskSchema.pick({ status: true, content: true, activeForm: true }).partial() }).strict(),
  z.object({ kind: z.literal("remove-task"), id: z.string().min(1).max(256), group: z.string().max(128) }).strict(),
])).max(16);
const storedPublicationSequencesSchema = z.array(z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.object({ executionId: z.string(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
]))
  .min(1).max(PUBLICATION_CHUNK_SIZE);
const projectedProviderEventSchema = z.object({
  providerId: ProviderIdSchema,
  sourceKind: z.literal("canonical-commit"),
  event: AgentEventSchema(),
  canonicalReceipt: z.object({
    eventId: z.string(),
    sourceSequence: z.number().int().optional(),
    acceptedSequence: z.number().int(),
    durableRevision: z.number().int(),
    serverTimestamps: z.object({ acceptedAt: z.string(), persistedAt: z.string().optional() }),
  }),
});
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
  assignedMessageId: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  compacting: z.boolean().default(false),
});
const storedReceiptSchema = z.object({
  kind: z.literal("committed"),
  operationId: z.string(),
  durableRevision: z.number().int(),
  publicationVersion: z.literal(1),
  livePublication: z.array(z.object({
    publicationId: z.string(),
    after: z.enum(["writer", "terminal"]),
    event: AgentEventSchema(),
  })).min(1).max(MAX_LIVE_PUBLICATION_EVENTS).optional(),
  providerCommit: z.object({
    outcome: z.enum(["committed", "duplicate", "conflict", "terminal-outcome-confirmed", "ingest-overflow"]),
    conversationRevision: z.number().int(),
    rosterRevision: z.number().int(),
    acceptedThrough: z.number().int(),
    durableThrough: z.number().int(),
    eventCount: z.number().int().nonnegative(),
  }).optional(),
  providerEvents: z.array(projectedProviderEventSchema).optional(),
  assistantTextCheckpoint: z.object({
    outcome: z.literal("committed"),
    durableThrough: z.number().int().nonnegative(),
    committedItems: z.number().int().positive(),
    committedBytes: z.number().int().positive(),
  }).optional(),
});
const storedOperationSchema = z.object({
  kind: z.string(),
  input_hash: z.string(),
  receipt_json: z.string(),
});
const storedPublicationChunkPageSchema = z.array(storedOperationSchema.extend({ operation_id: z.string() }))
  .max(PUBLICATION_CHUNK_PAGE_SIZE);
const storedEnvelopeRowSchema = z.object({ envelope_json: z.string() });
const durableSequenceRowSchema = z.object({ last_durable_sequence: z.number().int() });

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
  readonly assignedMessageId?: string | null;
  readonly compacting: boolean;
}

type StoredOperation = z.infer<typeof storedOperationSchema>;

class SemanticConflict extends Error {}

/** The revoked ownership and recovery incident for a worker that cannot prove its live turn. */
export interface LostExecutionInterruption {
  readonly execution: ExecutionIdentity;
  readonly lease: ExecutionLease;
  readonly reason: string;
  readonly recoveryIncidentId: string;
}

/** Adapts the supported execution mutations to one writer-local canonical SQLite connection. */
export class CanonicalExecutionSemanticWriter implements ExecutionSemanticWriter {
  private readonly turns: CanonicalParentTurnWrite;
  private readonly providerProjector: CanonicalCommittedProviderProjector;
  private readonly contextCompaction: CanonicalContextCompactionProjection;
  private readonly systemProjection: CanonicalCodexSystemErrorProjection;
  private readonly tasks: TaskRepo;
  private readonly assistantText: ParentAssistantTextCheckpointService;
  private readonly canonical: CanonicalAgentBoundary;
  private readonly findOperation: ReturnType<Database["prepare"]>;
  private readonly listPublicationChunks: ReturnType<Database["prepare"]>;
  private readonly findPublishedEvent: ReturnType<Database["prepare"]>;
  private readonly findDurableSequence: ReturnType<Database["prepare"]>;
  private readonly insertOperation: ReturnType<Database["prepare"]>;
  private readonly commitPendingFinish: ReturnType<Database["prepare"]>;
  private readonly updateHead: ReturnType<Database["prepare"]>;
  private readonly updateCheckpointPhase: ReturnType<Database["prepare"]>;
  private readonly updateCheckpoint: ReturnType<Database["prepare"]>;
  private bufferedPublication: Parameters<CanonicalAgentEventPublisher>[0][] | null = null;
  private bufferedPublicationCount = 0;

  constructor(private readonly db: Database, private readonly publish: CanonicalAgentEventPublisher) {
    this.turns = new CanonicalParentTurnWrite(db, (events) => {
      if (this.bufferedPublication) this.bufferPublication(events);
      else this.publish(events);
    });
    const codexBoundary = new CanonicalAgentBoundary(db, (events) => {
      if (!this.bufferedPublication) throw new Error("Codex projection requires a semantic transaction");
      this.bufferPublication(events);
    });
    this.canonical = codexBoundary;
    this.providerProjector = new CanonicalCommittedProviderProjector(codexBoundary);
    this.contextCompaction = new CanonicalContextCompactionProjection(db);
    this.systemProjection = new CanonicalCodexSystemErrorProjection(db);
    this.tasks = new TaskRepo(db);
    this.assistantText = new ParentAssistantTextCheckpointService(db);
    this.findOperation = db.prepare("SELECT kind, input_hash, receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?");
    this.listPublicationChunks = db.prepare("SELECT operation_id, kind, input_hash, receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id > ? AND operation_id < ? ORDER BY operation_id LIMIT ?");
    this.findPublishedEvent = db.prepare("SELECT envelope_json FROM canonical_agent_events WHERE execution_id = ? AND accepted_sequence = ?");
    this.findDurableSequence = db.prepare("SELECT last_durable_sequence FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?");
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
    if (existing) {
      if (existing.kind === "committed" && operation.mutation.kind === "finish") {
        this.assistantText.retire(operation.execution.executionId);
      }
      if (existing.kind === "committed" && operation.mutation.kind === "live-event"
        && operation.mutation.text.kind === "reclassify") {
        this.assistantText.discardRecoveryJournal(operation.execution.executionId);
      }
      return existing;
    }
    try {
      return await this.applySupported(operation, hash);
    } catch (error) {
      if (error instanceof SemanticConflict) return conflict(operation);
      throw error;
    }
  }

  /** Fence a lost worker and apply the existing interrupted-turn recovery contract. */
  interruptWorkerLoss(input: LostExecutionInterruption): ExecutionWriteReceipt {
    const operation = workerLossOperation(input);
    if (!validLostExecutionInput(input, operation)) return conflict(operation);
    const hash = fingerprint(input);
    const existing = this.loadOperation(input.execution.executionId, operation.operationId);
    if (existing) {
      const receipt = this.replay(operation, hash, existing);
      if (receipt.kind === "committed") this.turns.retireInterruptedText(input.execution.executionId);
      return receipt;
    }
    const head = this.loadHead(input.execution.executionId);
    if (!head) return { ...conflict(operation), recoveryState: "not-started" };
    if (!sameExecutionAndLease(head, input)) return conflict(operation);
    if (head.terminal) return { ...conflict(operation), recoveryState: "already-terminal" };
    this.turns.importRecoveryJournals();
    try {
      const receipt = this.withBufferedPublication(() => this.db.transaction(
        () => this.writeLostInterruption(input, operation, hash),
      )());
      this.turns.retireInterruptedText(input.execution.executionId);
      return receipt;
    } catch (error) {
      if (error instanceof SemanticConflict) return conflict(operation);
      throw error;
    }
  }

  private writeLostInterruption(
    input: LostExecutionInterruption,
    operation: ExecutionSemanticOperation,
    hash: string,
  ): ExecutionWriteReceipt {
    const current = this.loadHead(input.execution.executionId);
    if (!current || current.terminal || !sameExecutionAndLease(current, input)) throw new SemanticConflict();
    const result = this.turns.interruptLostExecution({ ...input.execution,
      reason: input.reason, recoveryIncidentId: input.recoveryIncidentId,
      ...(current.assignedMessageId ? { assignedMessageId: current.assignedMessageId } : {}) });
    const receipt = committed(operation, result.durableThrough);
    const sequences = this.bufferedPublication?.flatMap((batch) => batch.map((event) => event.acceptedSequence)) ?? [];
    this.storePublicationChunks(input.execution.executionId, hash, sequences);
    this.storeHead({ ...current, ordinal: current.ordinal + 1,
      durableRevision: receipt.durableRevision, terminal: true });
    this.storeReceipt(operation, hash, receipt);
    return receipt;
  }

  private async applySupported(operation: ExecutionSemanticOperation, hash: string): Promise<ExecutionWriteReceipt> {
    if (LIVE_RECOVERY_KINDS.has(operation.mutation.kind)) return this.applyLiveRecovery(operation, hash);
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
      || !validPublicationProvider(operation, mutation.providerId)
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
        compacting: false,
      };
      this.insertOperation.run(operation.execution.executionId, HEAD_ID, HEAD_KIND, fingerprint(head.lease), JSON.stringify(head));
      this.storePublicationChunks(operation.execution.executionId, hash, result.events.map((event) => event.acceptedSequence));
      this.storeReceipt(operation, hash, receipt);
      return receipt;
    })());
  }

  private append(operation: ExecutionSemanticOperation, hash: string): ExecutionWriteReceipt {
    const mutation = operation.mutation;
    if (mutation.kind !== "append-events" || !mutation.phase || mutation.phase.length > 64
      || mutation.events.length === 0
      || mutation.events.some((event) => event.routing.threadId !== operation.execution.threadId
        || event.routing.turnId !== operation.execution.turnId
        || event.routing.executionId !== operation.execution.executionId)) return conflict(operation);
    return this.withBufferedPublication(() => this.db.transaction(() => {
      const head = this.requireNextHead(operation);
      if (!validPublicationProvider(operation, head.providerId)) throw new SemanticConflict();
      const result = this.turns.append({
        ...operation.execution,
        phase: mutation.phase,
        nativeCursor: mutation.nativeCursor,
        events: mutation.events,
      });
      if (result.outcome !== "committed") throw new SemanticConflict();
      const providerEvents = this.providerProjector.project(result.events);
      const compacting = this.contextCompaction.apply(operation.execution.threadId, head.compacting, providerEvents);
      if (compacting === null) throw new SemanticConflict();
      const checkpoint = durableSequenceRowSchema.parse(this.findDurableSequence.get(operation.execution.executionId));
      const providerCommit: ExecutionProviderCommitReceipt = {
        outcome: result.outcome,
        conversationRevision: result.conversationRevision,
        rosterRevision: result.rosterRevision,
        acceptedThrough: result.acceptedThrough,
        durableThrough: result.durableThrough,
        eventCount: result.events.length,
      };
      const receipt = committed(operation, checkpoint.last_durable_sequence, providerCommit, providerEvents);
      this.storeHead({ ...head, ordinal: operation.ordinal, durableRevision: receipt.durableRevision, compacting });
      const publication = this.bufferedPublication?.flat() ?? [];
      // A Codex child write has its own execution sequence, even when the parent event caused it.
      this.storePublicationChunks(operation.execution.executionId, hash, publication.map((event) => ({
        executionId: event.routing.executionId,
        sequence: event.acceptedSequence,
      })));
      this.storeReceipt(operation, hash, receipt);
      return receipt;
    })());
  }

  private appendAssistantText(operation: ExecutionSemanticOperation, hash: string): ExecutionWriteReceipt {
    const mutation = operation.mutation;
    if (mutation.kind !== "append-assistant-text") return conflict(operation);
    return this.db.transaction(() => {
      const head = this.requireNextHead(operation);
      const result = this.assistantText.appendChunk(mutation.inputs);
      if (result.outcome !== "committed") throw new SemanticConflict();
      // Assistant text has its own durable sequence; it does not advance the canonical event revision.
      const receipt = committed(operation, head.durableRevision, undefined, undefined, result);
      this.storeHead({ ...head, ordinal: operation.ordinal });
      this.storeReceipt(operation, hash, receipt);
      return receipt;
    })();
  }

  private recordNarrativeDelta(operation: ExecutionSemanticOperation, hash: string): ExecutionWriteReceipt {
    const mutation = operation.mutation;
    if (mutation.kind !== "narrative-delta") return conflict(operation);
    return this.db.transaction(() => {
      const head = this.requireNextHead(operation);
      this.requireUnfinishedCheckpoint(operation.execution);
      this.persistNarrativeDelta(mutation.input);
      const receipt = committed(operation, head.durableRevision);
      this.storeHead({ ...head, ordinal: operation.ordinal });
      this.storeReceipt(operation, hash, receipt);
      return receipt;
    })();
  }

  private applyLiveRecovery(operation: ExecutionSemanticOperation, hash: string): ExecutionWriteReceipt {
    if (operation.mutation.kind === "append-assistant-text") return this.appendAssistantText(operation, hash);
    if (operation.mutation.kind === "narrative-delta") return this.recordNarrativeDelta(operation, hash);
    return this.recordLiveEvent(operation, hash);
  }

  private recordLiveEvent(operation: ExecutionSemanticOperation, hash: string): ExecutionWriteReceipt {
    const mutation = operation.mutation;
    if (mutation.kind !== "live-event") return conflict(operation);
    const receipt = this.db.transaction(() => {
      const head = this.requireNextHead(operation);
      if (head.providerId !== "codex") throw new SemanticConflict();
      this.requireUnfinishedCheckpoint(operation.execution);
      this.stageLiveMessage(operation.execution, head, mutation.message);
      const textResult = this.applyLiveText(mutation.text, operation.execution.executionId);
      if (mutation.narrative) this.persistNarrativeDelta(mutation.narrative);
      if (mutation.taskIntents) this.applyTaskIntents(operation.execution.threadId, mutation.taskIntents);
      if (mutation.text.kind === "reclassify" && !this.assistantText.resetInTransaction(operation.execution.executionId)) {
        throw new SemanticConflict();
      }
      const livePublication = this.projectLiveSystem(operation);
      const committedReceipt = committed(operation, head.durableRevision, undefined, undefined, textResult, livePublication);
      this.storeHead({ ...head, ordinal: operation.ordinal,
        ...(mutation.message ? { assignedMessageId: mutation.message.messageId } : {}) });
      this.storeReceipt(operation, hash, committedReceipt);
      return committedReceipt;
    })();
    if (mutation.text.kind === "reclassify") {
      this.assistantText.discardRecoveryJournal(operation.execution.executionId);
    }
    return receipt;
  }

  private projectLiveSystem(operation: ExecutionSemanticOperation): readonly ExecutionLivePublicationReceipt[] | undefined {
    const mutation = operation.mutation;
    if (mutation.kind !== "live-event" || mutation.systemIntents === undefined) return undefined;
    const publication = liveEventPublication(operation);
    if (publication?.event.type !== "system") throw new SemanticConflict();
    const result = this.systemProjection.projectBoundSystem(
      operation.execution, publication.event, mutation.systemIntents, publication.after,
    );
    return [{ publicationId: `${operation.operationId}:0`, after: result.after, event: result.event }];
  }

  private stageLiveMessage(
    execution: ExecutionIdentity,
    head: SemanticHead,
    message: DataOnlyParentLiveMessageInput | undefined,
  ): void {
    if (!message) return;
    if (head.assignedMessageId && head.assignedMessageId !== message.messageId) throw new SemanticConflict();
    if (!this.turns.stageLiveAssistant(execution, message)) throw new SemanticConflict();
  }

  private applyLiveText(
    text: Extract<ExecutionSemanticOperation["mutation"], { kind: "live-event" }>["text"],
    executionId: string,
  ): ParentAssistantTextCheckpointResult | undefined {
    if (text.kind === "unchanged") return undefined;
    if (text.kind === "reclassify") {
      if (this.assistantText.restore(executionId) !== text.expectedText) throw new SemanticConflict();
      return undefined;
    }
    const result = this.assistantText.appendChunk(text.kind === "append" ? text.inputs : [text.input]);
    if (result.outcome !== "committed") throw new SemanticConflict();
    return result;
  }

  private applyTaskIntents(threadId: string, intents: readonly TaskToolWriteIntent[]): void {
    for (const intent of intents) {
      switch (intent.kind) {
        case "upsert-group": this.tasks.upsertGroup(threadId, intent.group, intent.tasks); break;
        case "append-task": this.tasks.appendTask(threadId, intent.task); break;
        case "update-task": this.tasks.updateTask(threadId, intent.id, intent.patch, intent.group); break;
        case "remove-task": this.tasks.removeTask(threadId, intent.id, intent.group); break;
      }
    }
  }

  private requireUnfinishedCheckpoint(execution: ExecutionIdentity): void {
    const checkpoint = this.canonical.loadCheckpoint(execution.executionId);
    if (!checkpoint || checkpoint.threadId !== execution.threadId
      || checkpoint.turnId !== execution.turnId || checkpoint.terminalOutcome !== null) {
      throw new SemanticConflict();
    }
  }

  private persistNarrativeDelta(input: Extract<ExecutionSemanticOperation["mutation"],
    { kind: "narrative-delta" }>["input"]): void {
    if (!this.canonical.recordParentNarrativeRecovery(input)) throw new SemanticConflict();
  }

  private async finish(operation: ExecutionSemanticOperation, hash: string): Promise<ExecutionWriteReceipt> {
    const mutation = operation.mutation;
    if (mutation.kind !== "finish" || !validFinish(operation, mutation)) return conflict(operation);
    if (!this.validFinishHead(operation, mutation.input.providerId)) return conflict(operation);
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
    if (!stored) return conflict(operation);
    const receipt = this.readReceipt(operation, hash, stored);
    if (receipt.kind === "committed") this.assistantText.retire(operation.execution.executionId);
    return receipt;
  }

  private stageTerminal(operation: ExecutionSemanticOperation, hash: string): ExecutionWriteReceipt {
    const mutation = operation.mutation;
    if (mutation.kind !== "stage-terminal" || mutation.input.threadId !== operation.execution.threadId
      || mutation.input.executionId !== operation.execution.executionId) return conflict(operation);
    return this.db.transaction(() => {
      const head = this.requireNextHead(operation);
      if (head.providerOutcome !== mutation.input.outcome) throw new SemanticConflict();
      if (head.assignedMessageId && head.assignedMessageId !== mutation.input.assistant.messageId) {
        throw new SemanticConflict();
      }
      this.turns.stageTerminalProjection(mutation.input);
      const receipt = committed(operation, head.durableRevision);
      this.storeHead({ ...head, ordinal: operation.ordinal,
        assignedMessageId: mutation.input.assistant.messageId ?? head.assignedMessageId ?? null });
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
    if (head.providerOutcome !== mutation.outcome || !this.hasStagedTerminalPredecessor(operation)) return false;
    return head.assignedMessageId
      ? head.assignedMessageId === mutation.input.projection.messageId
      : mutation.input.projection.messageId === undefined;
  }

  private validFinishHead(operation: ExecutionSemanticOperation, providerId: string): boolean {
    const head = this.loadHead(operation.execution.executionId);
    return Boolean(head && nextHead(head, operation) && head.providerId === providerId
      && validPublicationProvider(operation, head.providerId) && this.validStagedFinish(operation, head));
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

  private storePublicationChunks(
    executionId: string,
    hash: string,
    sequences: readonly (number | { executionId: string; sequence: number })[],
  ): void {
    for (let offset = 0; offset < sequences.length; offset += PUBLICATION_CHUNK_SIZE) {
      const chunk = sequences.slice(offset, offset + PUBLICATION_CHUNK_SIZE);
      const first = chunk[0];
      if (first === undefined) continue;
      const id = publicationChunkId(hash, typeof first === "number" ? first : offset + 1);
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
    if (operation.livePublication && Buffer.byteLength(receiptJson, "utf8") > MAX_LIVE_RECEIPT_BYTES) {
      throw new SemanticConflict();
    }
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
    if (operation.livePublication && Buffer.byteLength(stored.receipt_json, "utf8") > MAX_LIVE_RECEIPT_BYTES) {
      throw new Error("Live publication receipt exceeds its size limit");
    }
    const receipt = storedReceiptSchema.parse(JSON.parse(stored.receipt_json));
    if (!this.matchesLivePublicationReceipt(operation, receipt.livePublication)) {
      throw new Error("Live publication receipt does not match its operation");
    }
    return receipt.operationId === operation.operationId && Number.isSafeInteger(receipt.durableRevision)
      ? committed(operation, receipt.durableRevision, receipt.providerCommit, receipt.providerEvents,
        receipt.assistantTextCheckpoint, receipt.livePublication) : conflict(operation);
  }

  private matchesLivePublicationReceipt(
    operation: ExecutionSemanticOperation,
    actual: readonly ExecutionLivePublicationReceipt[] | undefined,
  ): boolean {
    const mutation = operation.mutation;
    if (mutation.kind === "live-event" && mutation.systemIntents?.[0]?.kind === "system-notice") {
      return this.matchesGeneratedNoticeReceipt(operation, actual);
    }
    return fingerprint(actual ?? null) === fingerprint(livePublicationFor(operation) ?? null);
  }

  private matchesGeneratedNoticeReceipt(
    operation: ExecutionSemanticOperation,
    actual: readonly ExecutionLivePublicationReceipt[] | undefined,
  ): boolean {
    const expected = livePublicationFor(operation)?.[0];
    const published = actual?.[0];
    if (actual?.length !== 1 || expected?.event.type !== "system" || expected.event.messageId
      || !isGeneratedNoticePublication(published)) return false;
    return fingerprint({ ...published, event: { ...published.event, messageId: undefined } }) === fingerprint(expected);
  }

  private publishStoredEvents(executionId: string, hash: string): void {
    const prefix = publicationChunkPrefix(hash);
    let cursor = prefix;
    while (true) {
      const chunks = storedPublicationChunkPageSchema.parse(this.listPublicationChunks.all(
        executionId, cursor, `${prefix}~`, PUBLICATION_CHUNK_PAGE_SIZE,
      ));
      if (chunks.length === 0) return;
      for (const chunk of chunks) {
        if (chunk.kind !== PUBLICATION_KIND || chunk.input_hash !== hash) throw new Error("Semantic publication chunk mismatch");
        const sequences = storedPublicationSequencesSchema.parse(JSON.parse(chunk.receipt_json));
        const events = sequences.map((sequence) => typeof sequence === "number"
          ? this.loadPublishedEvent(executionId, sequence)
          : this.loadPublishedEvent(sequence.executionId, sequence.sequence));
        this.publish(events);
      }
      cursor = chunks[chunks.length - 1]!.operation_id;
    }
  }

  private loadPublishedEvent(executionId: string, sequence: number) {
    const row = storedEnvelopeRowSchema.nullable().parse(this.findPublishedEvent.get(executionId, sequence));
    if (!row) throw new Error(`Semantic publication event missing at ${executionId}:${sequence}`);
    return CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(row.envelope_json));
  }

  // Only the synchronous begin and append transactions use this buffer. Finish publishes after each committed batch.
  private bufferPublication(events: Parameters<CanonicalAgentEventPublisher>[0]): void {
    if (!this.bufferedPublication || this.bufferedPublicationCount + events.length > MAX_BUFFERED_PUBLICATION_EVENTS) {
      throw new Error("Semantic publication buffer exceeded its limit");
    }
    this.bufferedPublication.push(events);
    this.bufferedPublicationCount += events.length;
  }

  private withBufferedPublication(write: () => ExecutionWriteReceipt): ExecutionWriteReceipt {
    if (this.bufferedPublication) throw new Error("Nested semantic publication buffer");
    const pending: Parameters<CanonicalAgentEventPublisher>[0][] = [];
    this.bufferedPublication = pending;
    this.bufferedPublicationCount = 0;
    try {
      const result = write();
      this.bufferedPublication = null;
      for (const events of pending) this.publish(events);
      return result;
    } finally {
      this.bufferedPublication = null;
      this.bufferedPublicationCount = 0;
    }
  }
}

function validOperation(operation: ExecutionSemanticOperation): boolean {
  return operation.operationId === `${operation.lease.leaseId}:${operation.ordinal}`
    && operation.operationId !== HEAD_ID && operation.operationId.length <= 256
    && Number.isSafeInteger(operation.ordinal) && operation.ordinal > 0
    && validIdentity(operation.execution) && validLease(operation.lease)
    && validSemanticMutationInput(operation)
    && validLivePublication(operation);
}

function validLivePublication(operation: ExecutionSemanticOperation): boolean {
  const publication = operation.livePublication;
  if (publication === undefined) return true;
  if (!validLivePublicationShape(publication, operation.mutation.kind)) return false;
  const barrier = operation.mutation.kind === "finish" ? "terminal" : "writer";
  let bytes = 0;
  for (const intent of publication) {
    if (!validLivePublicationIntent(intent, operation, barrier)) return false;
    bytes += Buffer.byteLength(JSON.stringify(intent), "utf8");
    if (bytes > MAX_LIVE_PUBLICATION_BYTES) return false;
  }
  return true;
}

function validLivePublicationShape(
  publication: readonly ExecutionLivePublicationIntent[],
  mutationKind: ExecutionSemanticOperation["mutation"]["kind"],
): boolean {
  return Array.isArray(publication) && publication.length > 0 && publication.length <= MAX_LIVE_PUBLICATION_EVENTS
    && (mutationKind === "begin" || mutationKind === "append-events" || mutationKind === "finish"
      || mutationKind === "live-event" && publication.length === 1);
}

function validLivePublicationIntent(
  intent: NonNullable<ExecutionSemanticOperation["livePublication"]>[number],
  operation: ExecutionSemanticOperation,
  barrier: "writer" | "terminal",
): boolean {
  return intent.after === barrier && AgentEventSchema().safeParse(intent.event).success
    && intent.event.threadId === operation.execution.threadId
    && intent.event.turnExecutionId === operation.execution.executionId
    && (operation.mutation.kind !== "begin" || intent.event.type === "turnStarted")
    && (intent.event.type !== "turnStarted" || operation.mutation.kind === "begin")
    && (barrier === "terminal" || !isTerminalLiveEvent(intent.event.type));
}

function isTerminalLiveEvent(type: ExecutionLivePublicationIntent["event"]["type"]): boolean {
  return type === "turnComplete" || type === "error" || type === "ended";
}

function validPublicationProvider(operation: ExecutionSemanticOperation, providerId: string): boolean {
  return operation.livePublication === undefined || providerId === "codex";
}

function validSemanticMutationInput(operation: ExecutionSemanticOperation): boolean {
  if (operation.mutation.kind === "append-assistant-text") {
    return validAssistantTextInput(operation.mutation.inputs, operation.execution);
  }
  if (operation.mutation.kind === "narrative-delta") {
    return validNarrativeDeltaInput(operation.mutation.input, operation.execution);
  }
  if (operation.mutation.kind === "live-event") return validLiveEventInput(operation);
  return true;
}

function validLiveEventInput(operation: ExecutionSemanticOperation): boolean {
  const mutation = operation.mutation;
  if (mutation.kind !== "live-event") return false;
  const publication = liveEventPublication(operation);
  if (!publication) return false;
  const event = publication.event;
  if (!validLiveSystemMutation(mutation, event)) return false;
  if (!validLiveTextPayload(mutation, operation.execution)
    || !AgentEventSchema().safeParse(event).success
    || !validLiveEventAssociation(mutation, event, operation.execution)) return false;
  if (mutation.narrative && !validNarrativeDeltaInput(mutation.narrative, operation.execution)) return false;
  if (!validLiveTaskIntents(mutation.taskIntents, event)) return false;
  return validLiveEventBudget(operation, mutation);
}

function validLiveSystemMutation(
  mutation: Extract<ExecutionSemanticOperation["mutation"], { kind: "live-event" }>,
  event: ExecutionLivePublicationIntent["event"],
): boolean {
  if (event.type !== "system") return mutation.systemIntents === undefined;
  return Array.isArray(mutation.systemIntents) && mutation.systemIntents.length <= 1
    && mutation.text.kind === "unchanged" && mutation.narrative === undefined && mutation.taskIntents === undefined
    && matchesCodexSystemIntents(event, mutation.systemIntents);
}

function validLiveTaskIntents(
  intents: readonly TaskToolWriteIntent[] | undefined,
  event: ExecutionLivePublicationIntent["event"],
): boolean {
  if (!intents) return true;
  if (!taskIntentsSchema.safeParse(intents).success) return false;
  return intents.length === 0 || event.type === "toolUse" || event.type === "toolResult";
}

function liveEventPublication(operation: ExecutionSemanticOperation): ExecutionLivePublicationIntent | null {
  const publication = operation.livePublication;
  return Array.isArray(publication) && publication.length === 1 && publication[0]?.after === "writer"
    ? publication[0] : null;
}

function validLiveEventBudget(
  operation: ExecutionSemanticOperation,
  mutation: Extract<ExecutionSemanticOperation["mutation"], { kind: "live-event" }>,
): boolean {
  const narrativeRows = mutation.narrative
    ? mutation.narrative.items.length + (mutation.narrative.discardedItemIds?.length ?? 0) : 0;
  const textRows = mutation.text.kind === "append" ? mutation.text.inputs.length
    : mutation.text.kind === "unchanged" ? 0 : 1;
  const rows = textRows + narrativeRows + (mutation.taskIntents?.length ?? 0) + (mutation.message ? 1 : 0);
  if (rows > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 2) return false;
  return Buffer.byteLength(JSON.stringify(operation), "utf8") <= ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes;
}

function validLiveTextPayload(
  mutation: Extract<ExecutionSemanticOperation["mutation"], { kind: "live-event" }>,
  execution: ExecutionIdentity,
): boolean {
  if (!mutation.text) return false;
  if (mutation.text.kind === "append") return validAssistantTextInput(mutation.text.inputs, execution);
  if (mutation.text.kind === "promote") return validAssistantTextInput([mutation.text.input], execution);
  if (mutation.text.kind === "reclassify") return validReclassification(mutation.text.expectedText, mutation.narrative);
  return mutation.text.kind === "unchanged";
}

function validReclassification(
  expectedText: string,
  narrative: Extract<ExecutionSemanticOperation["mutation"], { kind: "live-event" }>["narrative"],
): boolean {
  if (typeof expectedText !== "string" || !expectedText) return false;
  return expectedText.trim().length === 0 || Boolean(narrative?.items.some((item) =>
    item.kind === "narrationSegment" && item.record.text === expectedText));
}

function validLiveTextAssociation(
  text: Extract<ExecutionSemanticOperation["mutation"], { kind: "live-event" }>["text"],
  event: ExecutionLivePublicationIntent["event"],
): boolean {
  switch (text.kind) {
    case "unchanged": return event.type === "system" || validNarrativeEvent(event);
    case "append": return validAppendEvent(event, text.inputs);
    case "reclassify": return event.type === "assistantMessageBoundary" && event.isFinalResponse === false
      && text.expectedText.length > 0;
    case "promote": return event.type === "assistantMessageBoundary" && event.isFinalResponse === true;
  }
}

function validLiveEventAssociation(
  mutation: Extract<ExecutionSemanticOperation["mutation"], { kind: "live-event" }>,
  event: ExecutionLivePublicationIntent["event"],
  execution: ExecutionIdentity,
): boolean {
  if (mutation.message) {
    return mutation.text.kind === "unchanged" && validLiveMessageAssociation(mutation.message, event, execution);
  }
  return event.type !== AgentEventType.Message && validLiveTextAssociation(mutation.text, event);
}

function validLiveMessageAssociation(
  message: DataOnlyParentLiveMessageInput,
  event: ExecutionLivePublicationIntent["event"],
  execution: ExecutionIdentity,
): boolean {
  return event.type === AgentEventType.Message && validLiveMessageIdentity(message)
    && validLiveMessageBody(message) && event.threadId === execution.threadId
    && event.messageId === message.messageId && event.content === message.content
    && (event.model ?? null) === message.model
    && JSON.stringify(event.attachments ?? []) === JSON.stringify(message.attachments);
}

function validLiveMessageIdentity(message: DataOnlyParentLiveMessageInput): boolean {
  return typeof message.precedingMessageId === "string" && message.precedingMessageId.length > 0
    && typeof message.messageId === "string" && /^[0-9a-f]{64}$/.test(message.messageId);
}

function validLiveMessageBody(message: DataOnlyParentLiveMessageInput): boolean {
  if (typeof message.content !== "string" || !Array.isArray(message.attachments)) return false;
  return (message.model === null || typeof message.model === "string")
    && (message.content.trim().length > 0 || message.attachments.length > 0);
}

function validNarrativeEvent(event: ExecutionLivePublicationIntent["event"]): boolean {
  return event.type === "textDelta" ? event.isFinalResponse === false
    : [
      "assistantMessageBoundary", "toolUse", "toolResult", "hookStarted", "hookCompleted",
      "modelFallback", "toolInputDelta", "toolProgress", "providerUnavailable", "hookProgress",
      "apiRetry", "rateLimited", "quotaUpdate", "goalUpdated", "goalCleared", "mcpServerStartupStatus",
    ].includes(event.type);
}

function validAppendEvent(
  event: ExecutionLivePublicationIntent["event"],
  inputs: readonly ParentAssistantTextCheckpointInput[],
): boolean {
  return event.type === "textDelta" && event.isFinalResponse !== false
    && inputs.map((input) => input.text).join("") === event.delta;
}

function validNarrativeDeltaInput(
  input: Extract<ExecutionSemanticOperation["mutation"], { kind: "narrative-delta" }>["input"],
  execution: ExecutionIdentity,
): boolean {
  if (!input || input.executionId !== execution.executionId || !Array.isArray(input.items)) return false;
  const discarded = input.discardedItemIds ?? [];
  if (!Array.isArray(discarded)) return false;
  const count = input.items.length + discarded.length;
  if (count === 0 || count > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 2) return false;
  return Buffer.byteLength(JSON.stringify(input), "utf8") <= ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes
    && narrativeDeltaSchema.safeParse(input).success;
}

function validAssistantTextInput(
  inputs: readonly ParentAssistantTextCheckpointInput[],
  execution: ExecutionIdentity,
): boolean {
  if (!Array.isArray(inputs) || inputs.length === 0
    || inputs.length > PARENT_ASSISTANT_TEXT_QUEUE_POLICY.maxQueuedEvents) return false;
  let bytes = 0;
  const first = inputs[0];
  if (!first || !validAssistantTextEntry(first, execution)) return false;
  const firstSequence = first.sequence;
  for (const [index, input] of inputs.entries()) {
    if (!validAssistantTextEntry(input, execution) || input.sequence !== firstSequence + index) return false;
    bytes += Buffer.byteLength(input.text, "utf8");
    if (bytes > PARENT_ASSISTANT_TEXT_QUEUE_POLICY.maxChunkBytes) return false;
  }
  return bytes > 0;
}

function validAssistantTextEntry(input: ParentAssistantTextCheckpointInput | undefined, execution: ExecutionIdentity): boolean {
  if (!input) return false;
  return input.executionId === execution.executionId && input.threadId === execution.threadId
    && input.turnId === execution.turnId && typeof input.text === "string"
    && Buffer.byteLength(input.text, "utf8") > 0
    && Number.isSafeInteger(input.sequence) && input.sequence > 0;
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

function validLostExecutionInput(input: LostExecutionInterruption, operation: ExecutionSemanticOperation): boolean {
  return validIdentity(input.execution) && validLease(input.lease)
    && Boolean(input.reason && input.recoveryIncidentId) && operation.operationId.length <= 256;
}

function sameExecutionAndLease(head: SemanticHead, input: LostExecutionInterruption): boolean {
  return head.execution.threadId === input.execution.threadId
    && head.execution.turnId === input.execution.turnId
    && head.execution.executionId === input.execution.executionId
    && head.lease.ownerEpoch === input.lease.ownerEpoch
    && head.lease.workerIndex === input.lease.workerIndex
    && head.lease.workerGeneration === input.lease.workerGeneration
    && head.lease.leaseId === input.lease.leaseId;
}

function workerLossOperation(input: LostExecutionInterruption): ExecutionSemanticOperation {
  return { operationId: `${input.lease.leaseId}:worker-lost`, execution: input.execution,
    lease: input.lease, ordinal: 0,
    mutation: { kind: "worker-lost", reason: input.reason, recoveryIncidentId: input.recoveryIncidentId } };
}

function committed(
  operation: ExecutionSemanticOperation,
  durableRevision: number,
  providerCommit?: ExecutionProviderCommitReceipt,
  providerEvents?: readonly ProjectedCommittedProviderEvent[],
  assistantTextCheckpoint?: ParentAssistantTextCheckpointResult,
  livePublication: readonly ExecutionLivePublicationReceipt[] | undefined = livePublicationFor(operation),
): Extract<ExecutionWriteReceipt, { kind: "committed" }> {
  return {
    kind: "committed", operationId: operation.operationId, durableRevision,
    ...(providerCommit ? { providerCommit } : {}),
    ...(providerEvents ? { providerEvents } : {}),
    ...(assistantTextCheckpoint ? { assistantTextCheckpoint } : {}),
    ...(livePublication ? { livePublication } : {}),
  };
}

function livePublicationFor(operation: ExecutionSemanticOperation): readonly ExecutionLivePublicationReceipt[] | undefined {
  return operation.livePublication?.map((intent, index) => ({
    publicationId: `${operation.operationId}:${index}`, after: intent.after,
    event: AgentEventSchema().parse(intent.event),
  }));
}

function isGeneratedNoticePublication(
  receipt: ExecutionLivePublicationReceipt | undefined,
): receipt is ExecutionLivePublicationReceipt & { readonly event: Extract<ExecutionLivePublicationIntent["event"], { type: "system" }> & { readonly messageId: string } } {
  return receipt?.event.type === "system" && typeof receipt.event.messageId === "string"
    && z.string().uuid().safeParse(receipt.event.messageId).success;
}

function conflict(operation: ExecutionSemanticOperation): Extract<ExecutionWriteReceipt, { kind: "conflict" }> {
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
