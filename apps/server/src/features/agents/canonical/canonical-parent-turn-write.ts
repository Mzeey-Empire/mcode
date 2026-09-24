import type { Database } from "bun:sqlite";

import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { PlanQuestionAnswersRepo } from "../planning/persistence/plan-question-answers-repo.js";
import type {
  ParentTurnFinishInput,
  ParentTurnProjection,
  ParentTurnStartInput,
} from "../turns/parent-turn-durability.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import {
  CanonicalAgentBoundary,
  type CanonicalAgentBatchedCommitResult,
  type CanonicalAgentCommitInput,
  type CanonicalAgentCommitResult,
  type CanonicalAgentEventDraft,
  type CanonicalAgentEventPublisher,
} from "./canonical-agent-boundary.js";

type CreateMessageArgument = Parameters<MessageRepo["create"]>;

/** User-message data the writer can project inside the canonical start transaction. */
export type ParentUserMessageWrite =
  | { kind: "existing"; messageId: string }
  | {
      kind: "create";
      messageId?: string;
      content: string;
      sequence: number;
      attachments?: CreateMessageArgument[4];
      replyToMessageId?: CreateMessageArgument[5];
      quotedText?: CreateMessageArgument[6];
      mentions?: CreateMessageArgument[9];
      previewAnnotations?: CreateMessageArgument[10];
      origin?: CreateMessageArgument[11];
      selectedTextComments?: CreateMessageArgument[13];
    };

/** Values for an atomic start; no caller closure enters the writer. */
export interface DataOnlyParentTurnStartInput extends Omit<ParentTurnStartInput, "projectUserMessage"> {
  userMessage: ParentUserMessageWrite;
  reopenThread?: boolean;
  answeredPlanQuestionMessageId?: string;
}

/** Values for one canonical event and checkpoint transaction. */
export interface DataOnlyParentEventInput extends Omit<CanonicalAgentCommitInput, "events" | "projectCompatibility" | "onOverflow"> {
  events: readonly CanonicalAgentEventDraft[];
}

/** A staged assistant and narrative to confirm in the terminal transaction. */
export interface DataOnlyParentTurnFinishInput extends Omit<ParentTurnFinishInput, "projectTurn" | "finalizeCompatibility"> {
  projection: ParentTurnProjection;
}

/** Writer-local semantic operations with cloneable inputs and durable receipts. */
export class CanonicalParentTurnWrite {
  private readonly canonical: CanonicalAgentBoundary;
  private readonly messages: MessageRepo;
  private readonly threads: ThreadRepo;
  private readonly planAnswers: PlanQuestionAnswersRepo;
  private readonly stagedAssistant: ReturnType<Database["prepare"]>;

  constructor(db: Database, publish: CanonicalAgentEventPublisher) {
    this.canonical = new CanonicalAgentBoundary(db, publish);
    this.messages = new MessageRepo(db);
    this.threads = new ThreadRepo(db);
    this.planAnswers = new PlanQuestionAnswersRepo(db);
    this.stagedAssistant = db.prepare("SELECT role, content FROM messages WHERE id = ? AND thread_id = ?");
  }

  /** Commit the user message, optional thread reopen and plan answer with canonical start. */
  start(input: DataOnlyParentTurnStartInput): CanonicalAgentCommitResult {
    return this.canonical.startParentTurn({
      ...input,
      projectUserMessage: () => {
        if (input.reopenThread && !this.threads.reopen(input.thread.id)) {
          throw new Error(`Thread not found: ${input.thread.id}`);
        }
        const message = this.projectUserMessage(input);
        if (input.answeredPlanQuestionMessageId) {
          this.planAnswers.markAnswered(input.answeredPlanQuestionMessageId, input.thread.id);
        }
        return message;
      },
    });
  }

  /** Commit a plain canonical event batch and its checkpoint before publication. */
  append(input: DataOnlyParentEventInput): CanonicalAgentCommitResult {
    return this.canonical.commit(input);
  }

  /** Confirm the terminal checkpoint and publish the staged assistant in one transaction. */
  finish(input: DataOnlyParentTurnFinishInput): Promise<CanonicalAgentBatchedCommitResult> {
    this.assertStagedAssistant(input);
    const projection: ParentTurnProjection = {
      message: input.projection.message
        ? {
            ...input.projection.message,
            is_internal: false,
            outcome: input.outcome,
            outcomeExecutionId: input.executionId,
          }
        : null,
      narrative: input.projection.narrative,
    };
    return this.canonical.finishParentTurnBatched({
      ...input,
      projectTurn: () => projection,
      finalizeCompatibility: () => {
        if (!projection.message) return;
        this.messages.setAssistantOutcome(projection.message.id, input.outcome, input.executionId);
        this.messages.publishAssistant(projection.message.id);
      },
    });
  }

  private projectUserMessage(input: DataOnlyParentTurnStartInput) {
    const { userMessage } = input;
    if (userMessage.kind === "existing") {
      const existing = this.messages.findByIdInThread(input.thread.id, userMessage.messageId);
      if (!existing || existing.role !== "user") {
        throw new Error(`Queued user message not found: ${userMessage.messageId}`);
      }
      return existing;
    }
    return this.messages.create(
      input.thread.id,
      "user",
      userMessage.content,
      userMessage.sequence,
      userMessage.attachments,
      userMessage.replyToMessageId,
      userMessage.quotedText,
      undefined,
      undefined,
      userMessage.mentions,
      userMessage.previewAnnotations,
      userMessage.origin,
      userMessage.messageId,
      userMessage.selectedTextComments,
    );
  }

  private assertStagedAssistant(input: DataOnlyParentTurnFinishInput): void {
    const projected = input.projection.message;
    if (!projected) return;
    const staged = this.stagedAssistant.get(projected.id, input.threadId) as { role: string; content: string } | null;
    if (!staged || staged.role !== "assistant" || staged.content !== projected.content) {
      throw new Error(`Staged assistant projection not found: ${projected.id}`);
    }
  }
}
