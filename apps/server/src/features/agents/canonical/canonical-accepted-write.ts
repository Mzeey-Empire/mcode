import type { Database } from "bun:sqlite";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import {
  AcceptedCanonicalAgentEventEnvelopeSchema, CanonicalAgentEventEnvelopeSchema, AgentProgressPositionSchema, TurnOutcomeSchema, MessageSchema,
} from "@mcode/contracts";
import { canonicalAgentEvents } from "../../../runtime/persistence/sqlite/schema.js";
import { CanonicalAgentStore as CanonicalAgentBoundary } from "./canonical-agent-store.js";
import type { CanonicalAcceptedWriteReceipt } from "./canonical-agent-writer-protocol.js";
import type { ExecutionSemanticOperation } from "../execution/execution-worker-handler.js";
import type { CanonicalExecutionSemanticWriter } from "./canonical-execution-semantic-writer.js";
import { PlanQuestionAnswersStore as PlanQuestionAnswersRepo } from "../planning/persistence/plan-question-answers-store.js";
import { MessageStore as MessageRepo } from "../conversation/persistence/message-store.js";
import { AcceptedFeatureWriteMetadataSchema, persistAcceptedFeatureWrite } from "./accepted-feature-write.js";

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
  features: AcceptedFeatureWriteMetadataSchema().optional(),
}).strict();
/** Already-prepared data to append without interpreting a provider event. */
export type CanonicalAcceptedWriteInput = Omit<z.infer<typeof CanonicalAcceptedWriteInputSchema>, "compatibility">
  & { readonly compatibility?: ExecutionSemanticOperation };

/** Storage correctness for accepted events, independent of execution and publication. */
export class CanonicalAcceptedEventWrite {
  private readonly orm;
  private readonly planAnswers;
  private readonly messages;

  constructor(private readonly db: Database, private readonly canonical: CanonicalAgentBoundary,
    private readonly compatibility?: Pick<CanonicalExecutionSemanticWriter, "applyAcceptedCompatibility" | "confirmAcceptedCompatibility">) {
    this.orm = drizzle(db);
    this.planAnswers = new PlanQuestionAnswersRepo(db);
    this.messages = new MessageRepo(db);
  }

  /** Called inside the receipt transaction so the stream head and events commit together. */
  apply(input: CanonicalAcceptedWriteInput, operationId: string): CanonicalAcceptedWriteReceipt {
    const parsed = CanonicalAcceptedWriteInputSchema.parse(input);
    this.assertRouting(parsed);
    this.assertPredecessor(parsed);
    this.applyCompatibility(input, operationId);
    const result = this.canonical.appendAcceptedInsideTransaction({ ...parsed.execution,
      phase: parsed.phase, nativeCursor: parsed.nativeCursor, events: parsed.events,
      ...(parsed.terminalOutcome ? { terminalOutcome: parsed.terminalOutcome } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
      ...(parsed.execution.turnId === "" ? { persistCheckpoint: false } : {}),
    });
    if (result.outcome !== "committed") throw new Error("Accepted progress did not append a new durable prefix");
    this.persistFeatures(input.execution.threadId, parsed.features);
    if (parsed.planAnswer) {
      if (parsed.planAnswer.thread_id !== input.execution.threadId || parsed.planAnswer.role !== "assistant") {
        throw new Error("Accepted plan answer belongs to another assistant message");
      }
      this.stagePlanAnswer(parsed.planAnswer, parsed.phase);
      this.planAnswers.markAnswered(parsed.planAnswer.id, parsed.planAnswer.thread_id);
    }
    if (input.compatibility) this.compatibility?.confirmAcceptedCompatibility(input.compatibility, result.conversationRevision);
    return {
      receipt: { operationId, contentHash: parsed.contentHash, predecessor: parsed.predecessor,
        through: parsed.through, durableRevision: result.conversationRevision },
      revision: { conversationRevision: result.conversationRevision, rosterRevision: result.rosterRevision },
      events: result.events,
    };
  }

  private stagePlanAnswer(assistant: z.infer<ReturnType<typeof MessageSchema>>, phase: string): void {
    const existing = this.messages.findByIdInThreadIncludingInternal(assistant.thread_id, assistant.id);
    if (existing) {
      if (existing.role !== "assistant") throw new Error("Accepted plan answer conflicts with an existing message");
      return;
    }
    this.messages.createAssistantIdempotent({ id: assistant.id, threadId: assistant.thread_id,
      content: assistant.content, sequence: assistant.sequence, model: assistant.model ?? null,
      attachments: assistant.attachments ?? [], isInternal: phase !== "finalized" });
  }

  private persistFeatures(threadId: string, metadata: unknown): void {
    if (metadata !== undefined) persistAcceptedFeatureWrite(this.db, threadId, metadata);
  }

  private applyCompatibility(input: CanonicalAcceptedWriteInput, operationId: string): void {
    if (!input.compatibility) return;
    const operation = input.compatibility;
    if (!this.compatibility || operationId !== operation.operationId && !operationId.startsWith(`${operation.operationId}:page:`)
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
