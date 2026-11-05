import type { Database } from "bun:sqlite";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { AcceptedCanonicalAgentEventEnvelopeSchema, CanonicalAgentEventEnvelopeSchema, AgentProgressPositionSchema } from "@mcode/contracts/compat/agent-model";
import { TurnOutcomeSchema } from "@mcode/contracts/models/turn-outcome";
import { MessageSchema } from "@mcode/contracts/models/message";
import { canonicalAgentEvents } from "../../../runtime/persistence/sqlite/schema.js";
import { CanonicalAgentStore } from "./canonical-agent-store.js";
import type { CanonicalAcceptedWriteReceipt } from "./canonical-agent-writer-protocol.js";
import type { AcceptedCompatibilityOperation, CanonicalExecutionSemanticWriter } from "./canonical-execution-semantic-writer.js";
import { PlanQuestionAnswersStore as PlanQuestionAnswersRepo } from "../planning/persistence/plan-question-answers-store.js";
import { MessageStore as MessageRepo } from "../conversation/persistence/message-store.js";
import { AcceptedFeatureWriteMetadataSchema, persistAcceptedFeatureWrite } from "./accepted-feature-write.js";
import { TurnSteerStore } from "../steering/persistence/turn-steer-store.js";
import { stageAcceptedContent } from "./accepted-save-failure.js";

/** Immutable storage intent, validated again on the dedicated SQLite worker. */
export const CanonicalAcceptedWriteInputSchema = z.object({
  execution: z.object({ threadId: z.string().min(1).max(256), turnId: z.string().max(256), executionId: z.string().uuid() }).strict(),
  phase: z.string().min(1).max(64),
  nativeCursor: z.unknown().nullable(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  predecessor: AgentProgressPositionSchema,
  through: AgentProgressPositionSchema,
  baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  events: z.array(AcceptedCanonicalAgentEventEnvelopeSchema).min(1).max(256),
  terminalOutcome: TurnOutcomeSchema.optional(),
  error: z.string().max(8_000).optional(),
  compatibility: z.unknown().optional(),
  planAnswer: MessageSchema().optional(),
  /** A user message the provider took mid-turn; its steer row is marked delivered in this transaction. */
  steerMessage: MessageSchema().optional(),
  features: AcceptedFeatureWriteMetadataSchema().optional(),
  /** Saves the same events in place of a page whose other contents the writer rejected. */
  replaced: z.object({ reason: z.string().min(1).max(500) }).strict().optional(),
}).strict();

const REPLACED_OPERATION_SUFFIX = ":replaced";

/** A deterministic storage id, so a lost reply replays the replacement's receipt instead of conflicting. */
export function replacedOperationId(pageOperationId: string): string {
  return `${pageOperationId}${REPLACED_OPERATION_SUFFIX}`;
}
/** Already-prepared data to append without interpreting a provider event. */
export type CanonicalAcceptedWriteInput = Omit<z.infer<typeof CanonicalAcceptedWriteInputSchema>, "compatibility">
  & { readonly compatibility?: AcceptedCompatibilityOperation };

/** Storage correctness for accepted events, independent of execution and publication. */
export class CanonicalAcceptedEventWrite {
  private readonly orm;
  private readonly planAnswers;
  private readonly messages;
  private readonly steers;
  private readonly advancePublicationHead;

  constructor(private readonly db: Database, private readonly canonical: CanonicalAgentStore,
    private readonly compatibility?: Pick<CanonicalExecutionSemanticWriter, "applyAcceptedCompatibility" | "confirmAcceptedCompatibility">) {
    this.orm = drizzle(db);
    this.planAnswers = new PlanQuestionAnswersRepo(db);
    this.messages = new MessageRepo(db);
    this.steers = new TurnSteerStore(db);
    this.advancePublicationHead = db.prepare(`INSERT INTO canonical_writer_live_publication_heads (thread_id, last_sequence)
      VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET last_sequence = MAX(last_sequence, excluded.last_sequence)`);
  }

  /** Called inside the receipt transaction so the stream head and events commit together. */
  apply(input: CanonicalAcceptedWriteInput, operationId: string): CanonicalAcceptedWriteReceipt {
    const parsed = CanonicalAcceptedWriteInputSchema.parse(input);
    this.assertRouting(parsed);
    this.assertPredecessor(parsed);
    this.assertReplacement(input, operationId);
    this.applyCompatibility(input, operationId);
    const result = this.canonical.appendAcceptedInsideTransaction({ ...parsed.execution,
      phase: parsed.phase, nativeCursor: parsed.nativeCursor, events: parsed.events,
      ...(parsed.terminalOutcome ? { terminalOutcome: parsed.terminalOutcome } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
      ...(parsed.execution.turnId === "" ? { persistCheckpoint: false } : {}),
    });
    if (result.outcome !== "committed") throw new Error("Accepted progress did not append a new durable prefix");
    this.persistPublicationHead(parsed);
    stageAcceptedContent("feature metadata could not be saved", () => this.persistFeatures(input.execution.threadId, parsed.features));
    stageAcceptedContent("message staging failed", () => this.stageMessages(parsed, input.execution.threadId));
    if (input.compatibility) this.compatibility?.confirmAcceptedCompatibility(input.compatibility, result.conversationRevision);
    return {
      receipt: { operationId, contentHash: parsed.contentHash, predecessor: parsed.predecessor,
        through: parsed.through, durableRevision: result.conversationRevision,
        ...(parsed.replaced ? { replaced: parsed.replaced } : {}) },
      revision: { conversationRevision: result.conversationRevision, rosterRevision: result.rosterRevision },
      events: result.events,
    };
  }

  private stageMessages(parsed: z.infer<typeof CanonicalAcceptedWriteInputSchema>, threadId: string): void {
    if (parsed.planAnswer) {
      if (parsed.planAnswer.thread_id !== threadId || parsed.planAnswer.role !== "assistant") {
        throw new Error("Accepted plan answer belongs to another assistant message");
      }
      this.stagePlanAnswer(parsed.planAnswer, parsed.phase);
      this.planAnswers.markAnswered(parsed.planAnswer.id, parsed.planAnswer.thread_id);
    }
    if (parsed.steerMessage) this.stageSteerMessage(parsed.steerMessage, threadId);
  }

  private stagePlanAnswer(assistant: z.infer<ReturnType<typeof MessageSchema>>, phase: string): void {
    const existing = this.messages.findByIdInThreadIncludingInternal(assistant.thread_id, assistant.id);
    if (existing) {
      if (existing.role !== "assistant") throw new Error("Accepted plan answer conflicts with an existing message");
      return;
    }
    this.messages.createAssistantIdempotent({ id: assistant.id, threadId: assistant.thread_id,
      content: assistant.content, sequence: assistant.sequence, model: assistant.model ?? null,
      provider: this.canonical.loadThread(assistant.thread_id)?.providerId ?? null,
      attachments: assistant.attachments ?? [], isInternal: phase !== "finalized" });
  }

  /**
   * The messages row reserves the steer's sequence, because the next prompt numbers itself from
   * this table. The provider already holds the message, so a steer row that a replay or restart
   * moved on is left alone instead of failing the save.
   */
  private stageSteerMessage(message: z.infer<ReturnType<typeof MessageSchema>>, threadId: string): void {
    if (message.thread_id !== threadId || message.role !== "user") {
      throw new Error("Accepted steer message belongs to another thread or role");
    }
    const existing = this.messages.findByIdInThreadIncludingInternal(threadId, message.id);
    if (existing && existing.role !== "user") throw new Error("Accepted steer message conflicts with an existing message");
    if (!existing) {
      this.messages.create(threadId, "user", message.content, message.sequence, undefined, undefined, undefined,
        undefined, false, message.mentions ?? undefined, undefined, undefined, message.id, undefined, message.systemNotice ?? undefined);
    }
    this.steers.markDelivered(message.id);
  }

  private persistFeatures(threadId: string, metadata: unknown): void {
    if (metadata !== undefined) persistAcceptedFeatureWrite(this.db, threadId, metadata);
  }

  private persistPublicationHead(input: z.infer<typeof CanonicalAcceptedWriteInputSchema>): void {
    let lastSequence = 0;
    for (const { payload } of input.events) {
      if (payload.type !== "publication.recorded") continue;
      const sequence = Number(payload.publicationId);
      if (!/^[1-9]\d*$/.test(payload.publicationId) || !Number.isSafeInteger(sequence)) {
        throw new Error("Accepted publication requires a positive safe sequence");
      }
      lastSequence = Math.max(lastSequence, sequence);
    }
    if (lastSequence > 0) this.advancePublicationHead.run(input.execution.threadId, lastSequence);
  }

  /** A replacement carries only events and a content-replaced operation, and only under its own storage id. */
  private assertReplacement(input: CanonicalAcceptedWriteInput, operationId: string): void {
    const replacing = operationId.endsWith(REPLACED_OPERATION_SUFFIX);
    const replacedCompatibility = input.compatibility?.mutation.kind === "content-replaced";
    if (replacing !== (input.replaced !== undefined) || (input.compatibility !== undefined && replacing !== replacedCompatibility)
      || replacing && (input.planAnswer || input.steerMessage || input.features)) {
      throw new Error("Accepted content replacement does not match its operation");
    }
  }

  private applyCompatibility(input: CanonicalAcceptedWriteInput, operationId: string): void {
    if (!input.compatibility) return;
    const operation = input.compatibility;
    const pageOperationId = input.replaced ? operationId.slice(0, -REPLACED_OPERATION_SUFFIX.length) : operationId;
    if (!this.compatibility || pageOperationId !== operation.operationId && !pageOperationId.startsWith(`${operation.operationId}:page:`)
      || operation.execution.executionId !== input.execution.executionId) {
      throw new Error("Accepted compatibility operation identity does not match");
    }
    this.compatibility.applyAcceptedCompatibility(operation);
  }

  private assertRouting(input: z.infer<typeof CanonicalAcceptedWriteInputSchema>): void {
    if (input.predecessor.epoch !== input.through.epoch
      || input.through.sequence !== input.predecessor.sequence + input.events.length
      || input.events.some((event, index) => event.routing.threadId !== input.execution.threadId
        || event.routing.executionId !== input.execution.executionId
        || event.routing.turnId !== undefined && event.routing.turnId !== input.execution.turnId
        || event.progressPosition.epoch !== input.through.epoch
        || event.progressPosition.sequence !== input.predecessor.sequence + index + 1)) {
      throw new Error("Accepted progress write has inconsistent routing or position");
    }
  }

  private assertPredecessor(input: z.infer<typeof CanonicalAcceptedWriteInputSchema>): void {
    const head = this.savedHead(input.execution.threadId);
    const revision = this.canonical.loadThread(input.execution.threadId)?.conversationRevision ?? 0;
    const position = head?.progressPosition;
    if (!position || position.epoch !== input.predecessor.epoch) {
      this.assertInitialPredecessor(input, revision);
      return;
    }
    if (position.sequence !== input.predecessor.sequence || revision !== head?.durableRevision) {
      throw new Error("Accepted stream durable predecessor does not match");
    }
  }

  private assertInitialPredecessor(input: z.infer<typeof CanonicalAcceptedWriteInputSchema>, revision: number): void {
    if (input.predecessor.sequence !== 0 || revision !== input.baseRevision) {
      throw new Error("Accepted stream initial durable predecessor does not match");
    }
  }

  private savedHead(threadId: string) {
    const row = this.orm.select({ envelopeJson: canonicalAgentEvents.envelopeJson }).from(canonicalAgentEvents)
      .where(eq(canonicalAgentEvents.threadId, threadId))
      .orderBy(desc(canonicalAgentEvents.durableRevision), desc(canonicalAgentEvents.acceptedSequence)).limit(1).get();
    return row ? CanonicalAgentEventEnvelopeSchema.parse(JSON.parse(row.envelopeJson)) : undefined;
  }

}
