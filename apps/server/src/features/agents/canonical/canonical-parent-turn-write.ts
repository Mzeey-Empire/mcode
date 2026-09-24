import type { Database } from "bun:sqlite";
import {
  ParentNarrativeRecoveryItemSchema,
  type ParentNarrativeRecoveryItem,
  type StoredAttachment,
  type TurnOutcome,
} from "@mcode/contracts";
import { z } from "zod";

import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { ThoughtSegmentRepo } from "../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../events/persistence/hook-execution-repo.js";
import { PlanQuestionAnswersRepo } from "../planning/persistence/plan-question-answers-repo.js";
import { ToolCallRecordRepo } from "../tools/persistence/tool-call-record-repo.js";
import { deriveTurnAssistantMessageId } from "../turns/turn-assistant-message-id.js";
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
  type CanonicalTerminalBatchWrite,
} from "./canonical-agent-boundary.js";

type CreateMessageArgument = Parameters<MessageRepo["create"]>;
const stagedAssistantSchema = z.object({ role: z.string(), content: z.string() });

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

/** Cloneable terminal data whose compatibility rows are staged on the writer connection. */
export interface DataOnlyParentTerminalProjectionInput {
  threadId: string;
  executionId: string;
  outcome: TurnOutcome;
  endedAt: string;
  assistant: { content: string; model: string | null; attachments: readonly StoredAttachment[] };
  narrative: readonly ParentNarrativeRecoveryItem[];
}

/** A staged projection ready for the canonical terminal commit. */
export interface StagedParentTerminalProjection {
  projection: ParentTurnProjection;
  messageId: string | null;
  toolCallCount: number;
}

/** Writer-local semantic operations with cloneable inputs and durable receipts. */
export class CanonicalParentTurnWrite {
  private readonly db: Database;
  private readonly canonical: CanonicalAgentBoundary;
  private readonly messages: MessageRepo;
  private readonly narrative: NarrativeStore;
  private readonly threads: ThreadRepo;
  private readonly planAnswers: PlanQuestionAnswersRepo;
  private readonly stagedAssistant: ReturnType<Database["prepare"]>;

  constructor(db: Database, publish: CanonicalAgentEventPublisher) {
    this.db = db;
    this.canonical = new CanonicalAgentBoundary(db, publish);
    this.messages = new MessageRepo(db);
    this.narrative = new NarrativeStore(
      this.messages,
      new ToolCallRecordRepo(db),
      new ThoughtSegmentRepo(db),
      new HookExecutionRepo(db),
      db,
    );
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

  /** Stage an internal assistant and its terminal narrative without publishing them. */
  stageTerminalProjection(input: DataOnlyParentTerminalProjectionInput): StagedParentTerminalProjection {
    if (!input.threadId || !input.executionId || !Number.isFinite(Date.parse(input.endedAt))) {
      throw new Error("Invalid parent terminal projection identity or end time");
    }
    const narrative = input.narrative.map((item) => ParentNarrativeRecoveryItemSchema().parse(item));
    return this.db.transaction(() => this.stageTerminalProjectionInTransaction(input, narrative))();
  }

  private stageTerminalProjectionInTransaction(
    input: DataOnlyParentTerminalProjectionInput,
    snapshot: readonly ParentNarrativeRecoveryItem[],
  ): StagedParentTerminalProjection {
    const turn = this.terminalProjectionTurn(input);
    if (turn.terminal) return this.persistedTerminalProjection(input, turn.turnId);
    if (!hasTerminalSubstance(input, snapshot)) {
      return { projection: { message: null, narrative: [] }, messageId: null, toolCallCount: 0 };
    }
    const message = this.stageAssistant(input);
    const settled = settleTerminalNarrative(snapshot, message.id, input.outcome, input.endedAt, input.assistant.content);
    this.narrative.persistRecoveredNarrative(message.id, settled, true);
    return this.projectionForMessage(message);
  }

  private terminalProjectionTurn(input: DataOnlyParentTerminalProjectionInput): { turnId: string; terminal: boolean } {
    const turn = this.canonical.loadTurnByExecution(input.executionId);
    const checkpoint = this.canonical.loadCheckpoint(input.executionId);
    if (!turn || turn.threadId !== input.threadId || checkpoint?.turnId !== turn.id) {
      throw new Error(`Canonical parent execution not found: ${input.executionId}`);
    }
    if (checkpoint.terminalOutcome && checkpoint.terminalOutcome !== input.outcome) {
      throw new Error(`Canonical parent execution has a different terminal outcome: ${input.executionId}`);
    }
    return { turnId: turn.id, terminal: checkpoint.terminalOutcome !== null };
  }

  private persistedTerminalProjection(input: DataOnlyParentTerminalProjectionInput, turnId: string): StagedParentTerminalProjection {
    const persisted = this.canonical.loadTerminalProjection(turnId);
    if (!persisted.message) {
      if (input.assistant.content.trim() || input.assistant.attachments.length > 0 || input.narrative.length > 0) {
        throw new Error(`Canonical terminal projection is empty: ${input.executionId}`);
      }
      return { projection: { message: null, narrative: [] }, messageId: null, toolCallCount: 0 };
    }
    this.assertAssistantMatches(persisted.message, input);
    return this.projectionForMessage(persisted.message);
  }

  private stageAssistant(input: DataOnlyParentTerminalProjectionInput) {
    const id = deriveTurnAssistantMessageId(input.threadId, `execution:${input.executionId}`);
    const existing = this.messages.findByIdInThread(input.threadId, id);
    if (existing) {
      this.assertAssistantMatches(existing, input);
      return existing;
    }
    const sequence = this.messages.getLatestSequenceIncludingInternal(input.threadId) + 1;
    return this.messages.createAssistantIdempotent({
      id,
      threadId: input.threadId,
      content: input.assistant.content,
      sequence,
      model: input.assistant.model,
      attachments: [...input.assistant.attachments],
      isInternal: true,
    });
  }

  private assertAssistantMatches(
    message: NonNullable<ReturnType<MessageRepo["findByIdInThread"]>>,
    input: DataOnlyParentTerminalProjectionInput,
  ): void {
    if (message.role !== "assistant" || message.content !== input.assistant.content
      || message.model !== input.assistant.model
      || JSON.stringify(message.attachments ?? []) !== JSON.stringify(input.assistant.attachments)) {
      throw new Error(`Staged assistant projection conflicts with terminal input: ${input.executionId}`);
    }
  }

  private projectionForMessage(message: NonNullable<ReturnType<MessageRepo["findByIdInThread"]>>): StagedParentTerminalProjection {
    const narrative = this.narrative.loadForMessages([message]);
    return {
      projection: { message, narrative },
      messageId: message.id,
      toolCallCount: narrative.filter((entry) => entry.kind === "toolCall").length,
    };
  }

  /** Confirm the terminal checkpoint and publish the staged assistant in one transaction. */
  finish(
    input: DataOnlyParentTurnFinishInput,
    onBatchWrite?: (batch: CanonicalTerminalBatchWrite) => void,
  ): Promise<CanonicalAgentBatchedCommitResult> {
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
    }, onBatchWrite);
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
    const staged = stagedAssistantSchema.nullable().parse(this.stagedAssistant.get(projected.id, input.threadId));
    if (!staged || staged.role !== "assistant" || staged.content !== projected.content) {
      throw new Error(`Staged assistant projection not found: ${projected.id}`);
    }
  }
}

function settleTerminalNarrative(
  items: readonly ParentNarrativeRecoveryItem[],
  messageId: string,
  outcome: TurnOutcome,
  endedAt: string,
  assistantContent: string,
): ParentNarrativeRecoveryItem[] {
  const finalText = assistantContent.trim();
  const lastThoughtOrder = Math.max(...items.filter((item) => item.kind === "narrationSegment")
    .map((item) => item.record.sort_order));
  return items.map((item) => {
    if (item.kind === "toolCall") return settleToolCall(item, messageId, outcome, endedAt);
    if (item.kind === "hook") return settleHook(item, messageId, endedAt);
    return settleThought(item, messageId, finalText, lastThoughtOrder);
  });
}

function hasTerminalSubstance(
  input: DataOnlyParentTerminalProjectionInput,
  snapshot: readonly ParentNarrativeRecoveryItem[],
): boolean {
  return Boolean(input.assistant.content.trim()) || input.assistant.attachments.length > 0 || snapshot.length > 0;
}

function settleToolCall(
  item: Extract<ParentNarrativeRecoveryItem, { kind: "toolCall" }>,
  messageId: string,
  outcome: TurnOutcome,
  endedAt: string,
): ParentNarrativeRecoveryItem {
  const status = item.record.status === "running" ? terminalToolStatus(outcome) : item.record.status;
  return { kind: "toolCall", record: {
    ...item.record,
    message_id: messageId,
    status,
    completed_at: item.record.status === "running" ? endedAt : item.record.completed_at,
  } };
}

function settleHook(
  item: Extract<ParentNarrativeRecoveryItem, { kind: "hook" }>,
  messageId: string,
  endedAt: string,
): ParentNarrativeRecoveryItem {
  const durationMs = item.record.ended_at
    ? item.record.duration_ms
    : Math.max(0, Date.parse(endedAt) - Date.parse(item.record.started_at));
  return { kind: "hook", record: {
    ...item.record,
    message_id: messageId,
    duration_ms: durationMs,
    ended_at: item.record.ended_at ?? endedAt,
  } };
}

function settleThought(
  item: Extract<ParentNarrativeRecoveryItem, { kind: "narrationSegment" }>,
  messageId: string,
  finalText: string,
  lastThoughtOrder: number,
): ParentNarrativeRecoveryItem {
  const thoughtText = item.record.text.trim();
  const isFinalResponse = finalText.length > 0 && thoughtText.length > 0
    && (thoughtText === finalText || (item.record.sort_order === lastThoughtOrder && finalText.endsWith(thoughtText)));
  return { kind: "narrationSegment", record: {
    ...item.record,
    message_id: messageId,
    is_final_response: isFinalResponse ? 1 : item.record.is_final_response,
  } };
}

function terminalToolStatus(outcome: TurnOutcome): "completed" | "failed" | "cancelled" {
  if (outcome === "errored" || outcome === "interrupted") return "failed";
  return outcome === "cancelled" ? "cancelled" : "completed";
}
