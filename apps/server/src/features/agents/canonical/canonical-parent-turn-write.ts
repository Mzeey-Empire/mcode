import type { Database } from "bun:sqlite";
import * as NodeCrypto from "node:crypto";
import {
  ParentNarrativeRecoveryItemSchema,
  TurnFileEffectSummarySchema,
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
import type { ExecutionIdentity } from "../execution/execution-mailbox-protocol.js";
import { ParentAssistantTextCheckpointService } from "../turns/parent-assistant-text-checkpoint-service.js";
import { TURN_DIFF_MAX_BYTES, parseTurnDiff } from "../turns/turn-diff-patch.js";
import { TurnDiffRepo } from "../turns/persistence/turn-diff-repo.js";
import { TurnSnapshotRepo } from "../turns/persistence/turn-snapshot-repo.js";
import type { PreparedExecutionFileEvidence } from "../turns/turn-execution-file-evidence.js";
import type { SelectedTurnDiff } from "../turns/turn-diff-service.js";
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

/** Project prepared user-message data on the transaction's SQLite connection. */
export function projectParentUserMessage(messages: MessageRepo, threadId: string, userMessage: ParentUserMessageWrite) {
  if (userMessage.kind === "existing") {
    const existing = messages.findByIdInThread(threadId, userMessage.messageId);
    if (!existing || existing.role !== "user") {
      throw new Error(`Queued user message not found: ${userMessage.messageId}`);
    }
    return existing;
  }
  return messages.create(
    threadId,
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
  projection: ParentTurnProjection | { readonly kind: "writer-staged"; readonly messageId?: string };
  deliveryAttempt?: number;
  selectedTurnDiff?: SelectedTurnDiff;
  fileEvidence?: PreparedExecutionFileEvidence;
}

/** Cloneable terminal data whose compatibility rows are staged on the writer connection. */
export interface DataOnlyParentTerminalProjectionInput {
  threadId: string;
  executionId: string;
  outcome: TurnOutcome;
  endedAt: string;
  assistant: { content: string; model: string | null; attachments: readonly StoredAttachment[]; messageId?: string };
  narrative: readonly ParentNarrativeRecoveryItem[];
}

/** Assistant body and assigned ID that must exist before its live message is published. */
export interface DataOnlyParentLiveMessageInput {
  readonly precedingMessageId: string;
  readonly messageId: string;
  readonly content: string;
  readonly model: string | null;
  readonly attachments: readonly StoredAttachment[];
}

/** A staged projection ready for the canonical terminal commit. */
export interface StagedParentTerminalProjection {
  projection: ParentTurnProjection;
  messageId: string | null;
  toolCallCount: number;
}

/** Recovery data for an execution whose owning worker has been lost. */
export interface LostParentExecutionInput {
  threadId: string;
  turnId: string;
  executionId: string;
  reason: string;
  recoveryIncidentId: string;
  assignedMessageId?: string;
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
  private readonly assistantTextCheckpoints: ParentAssistantTextCheckpointService;
  private readonly turnDiffs: TurnDiffRepo;
  private readonly turnSnapshots: TurnSnapshotRepo;
  private readonly markThreadFilesChanged: ReturnType<Database["prepare"]>;

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
    this.assistantTextCheckpoints = new ParentAssistantTextCheckpointService(db);
    this.turnDiffs = new TurnDiffRepo(db);
    this.turnSnapshots = new TurnSnapshotRepo(db);
    this.markThreadFilesChanged = db.prepare("UPDATE threads SET has_file_changes = 1 WHERE id = ? AND has_file_changes = 0");
  }

  /** Import fsynced text before the interruption transaction reads its durable prefix. */
  importRecoveryJournals(): void {
    this.assistantTextCheckpoints.importRecoveryJournals();
  }

  /** Apply the existing interrupted-turn contract on the writer connection. Caller owns the transaction. */
  interruptLostExecution(input: LostParentExecutionInput): CanonicalAgentCommitResult {
    const turn = this.canonical.loadTurnByExecution(input.executionId);
    const checkpoint = this.canonical.loadCheckpoint(input.executionId);
    if (!isUnfinishedLostTurn(turn, checkpoint, input)) {
      throw new Error(`Unfinished parent execution not found: ${input.executionId}`);
    }
    const existingAssistant = this.canonical.loadTerminalProjection(input.turnId).message;
    const assignedAssistant = this.assignedAssistantForLoss(input, existingAssistant);
    const recoveredNarrative = this.canonical.loadParentNarrativeRecovery(input.turnId);
    const text = existingAssistant || assignedAssistant ? "" : this.assistantTextCheckpoints.restore(input.executionId);
    const assistant = existingAssistant ?? assignedAssistant ?? this.stageRecoveredAssistant(input, text, recoveredNarrative.length);
    this.canonical.markUnresolvedCodexChildDeliveriesUnknown(input.executionId);
    const result = this.canonical.interruptUnfinishedExecution(
      input.executionId,
      input.reason,
      assistant ?? undefined,
      recoveredNarrative.length > 0
        ? (message, narrative) => this.narrative.persistRecoveredNarrative(message.id, narrative)
        : undefined,
      recoveredNarrative,
      input.recoveryIncidentId,
    );
    if (result.outcome !== "committed") throw new Error(`Parent interruption did not commit: ${input.executionId}`);
    this.threads.updateStatus(input.threadId, "interrupted");
    return result;
  }

  private assignedAssistantForLoss(
    input: LostParentExecutionInput,
    terminal: ReturnType<CanonicalAgentBoundary["loadTerminalProjection"]>["message"],
  ) {
    if (!input.assignedMessageId) return null;
    const assigned = this.messages.findByIdInThreadIncludingInternal(input.threadId, input.assignedMessageId);
    if (!assigned || assigned.role !== "assistant" || !assigned.is_internal
      || terminal && terminal.id !== assigned.id) {
      throw new Error(`Assigned assistant message was not staged: ${input.assignedMessageId}`);
    }
    return assigned;
  }

  /** Retire provisional text only after the canonical interruption and receipt commit. */
  retireInterruptedText(executionId: string): void {
    if (!this.assistantTextCheckpoints.retire(executionId)) {
      throw new Error(`Interrupted assistant text checkpoint was not retired: ${executionId}`);
    }
  }

  private stageRecoveredAssistant(input: LostParentExecutionInput, text: string, narrativeCount: number) {
    if (text.length === 0 && narrativeCount === 0) return null;
    const id = deriveTurnAssistantMessageId(input.threadId, `recovery:${input.executionId}`);
    const existing = this.messages.findByIdInThreadIncludingInternal(input.threadId, id);
    if (existing) return existing;
    return this.messages.createAssistantIdempotent({
      id,
      threadId: input.threadId,
      content: text,
      sequence: this.messages.getLatestSequenceIncludingInternal(input.threadId) + 1,
      model: this.threads.findById(input.threadId)?.model ?? null,
      isInternal: true,
    });
  }

  /** Commit the user message, optional thread reopen and plan answer with canonical start. */
  start(input: DataOnlyParentTurnStartInput): CanonicalAgentCommitResult {
    return this.canonical.startParentTurn({
      ...input,
      projectUserMessage: () => {
        if (input.reopenThread && !this.threads.reopen(input.thread.id)) {
          throw new Error(`Thread not found: ${input.thread.id}`);
        }
        const message = projectParentUserMessage(this.messages, input.thread.id, input.userMessage);
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

  /** Stage the exact live body on this writer connection for terminal reuse. */
  stageLiveAssistant(execution: ExecutionIdentity, input: DataOnlyParentLiveMessageInput): boolean {
    if (!this.canStageLiveAssistant(execution, input)) return false;
    const existing = this.messages.findByIdInThreadIncludingInternal(execution.threadId, input.messageId);
    if (existing) return Boolean(existing.is_internal && this.matchesAssistantBody(existing, input));
    return this.createLiveAssistant(execution.threadId, input);
  }

  private canStageLiveAssistant(execution: ExecutionIdentity, input: DataOnlyParentLiveMessageInput): boolean {
    const turn = this.canonical.loadTurnByExecution(execution.executionId);
    const checkpoint = this.canonical.loadCheckpoint(execution.executionId);
    return Boolean(turn && turn.id === execution.turnId && turn.threadId === execution.threadId
      && checkpoint?.turnId === execution.turnId && checkpoint.terminalOutcome === null)
      && deriveTurnAssistantMessageId(execution.threadId, input.precedingMessageId) === input.messageId;
  }

  private createLiveAssistant(threadId: string, input: DataOnlyParentLiveMessageInput): boolean {
    const preceding = this.messages.findByIdInThreadIncludingInternal(threadId, input.precedingMessageId);
    if (!preceding || preceding.sequence !== this.messages.getLatestSequenceIncludingInternal(threadId)) return false;
    this.messages.createAssistantIdempotent({
      id: input.messageId,
      threadId,
      content: input.content,
      sequence: preceding.sequence + 1,
      model: input.model,
      attachments: [...input.attachments],
      isInternal: true,
    });
    const staged = this.messages.findByIdInThreadIncludingInternal(threadId, input.messageId);
    return Boolean(staged?.is_internal && this.matchesAssistantBody(staged, input));
  }

  /** Stage an internal assistant and its terminal narrative without publishing them. */
  stageTerminalProjection(input: DataOnlyParentTerminalProjectionInput): StagedParentTerminalProjection {
    if (!input.threadId || !input.executionId || !Number.isFinite(Date.parse(input.endedAt))) {
      throw new Error("Invalid parent terminal projection identity or end time");
    }
    if (input.assistant.messageId !== undefined && !/^[0-9a-f]{64}$/.test(input.assistant.messageId)) {
      throw new Error("Invalid parent assistant message identity");
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
    if (input.assistant.messageId && persisted.message?.id !== input.assistant.messageId) {
      throw new Error(`Canonical terminal projection has a different assistant identity: ${input.executionId}`);
    }
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
    const id = input.assistant.messageId ?? deriveTurnAssistantMessageId(input.threadId, `execution:${input.executionId}`);
    const existing = this.messages.findByIdInThreadIncludingInternal(input.threadId, id);
    if (existing) {
      if (!existing.is_internal) throw new Error(`Staged assistant projection is already public: ${id}`);
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

  private matchesAssistantBody(
    message: NonNullable<ReturnType<MessageRepo["findByIdInThread"]>>,
    input: DataOnlyParentLiveMessageInput,
  ): boolean {
    return message.role === "assistant" && message.content === input.content
      && message.model === input.model
      && JSON.stringify(message.attachments ?? []) === JSON.stringify(input.attachments);
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
    const staged = "kind" in input.projection
      ? this.loadStagedTerminalProjection(input.threadId, input.executionId, input.projection.messageId)
      : input.projection;
    this.assertStagedAssistant(input.threadId, staged);
    const fileEvidence = input.fileEvidence;
    const selectedTurnDiff = selectTerminalDiff(input, staged.message !== null);
    const projection: ParentTurnProjection = {
      message: staged.message
        ? {
            ...staged.message,
            is_internal: false,
            outcome: input.outcome,
            outcomeExecutionId: input.executionId,
          }
        : null,
      narrative: staged.narrative,
    };
    return this.canonical.finishParentTurnBatched({
      ...input,
      projectTurn: () => projection,
      finalizeCompatibility: () => {
        if (!projection.message) return;
        this.messages.setAssistantOutcome(projection.message.id, input.outcome, input.executionId);
        this.messages.publishAssistant(projection.message.id);
        if (fileEvidence?.snapshot) {
          const snapshot = fileEvidence.snapshot;
          this.turnSnapshots.create({
            messageId: projection.message.id,
            threadId: snapshot.threadId,
            refBefore: snapshot.refBefore,
            refAfter: snapshot.refAfter,
            filesChanged: [...snapshot.filesChanged],
            fileEffects: snapshot.fileEffects,
            worktreePath: null,
          });
          if (fileEvidence.fileEffects.fileCount > 0 || fileEvidence.filesChanged.length > 0) {
            this.markThreadFilesChanged.run(input.threadId);
          }
        }
        if (selectedTurnDiff) this.turnDiffs.create({
          id: NodeCrypto.randomUUID(), message_id: projection.message.id, ...selectedTurnDiff,
        });
      },
    }, onBatchWrite);
  }

  private loadStagedTerminalProjection(threadId: string, executionId: string, messageId?: string): ParentTurnProjection {
    if (messageId !== undefined && !/^[0-9a-f]{64}$/.test(messageId)) {
      throw new Error("Invalid staged assistant message identity");
    }
    const id = messageId ?? deriveTurnAssistantMessageId(threadId, `execution:${executionId}`);
    const message = this.messages.findByIdInThreadIncludingInternal(threadId, id);
    if (!message && messageId) throw new Error(`Staged assistant projection not found: ${messageId}`);
    if (!message) return { message: null, narrative: [] };
    if (message.role !== "assistant" || !message.is_internal) {
      throw new Error(`Staged assistant projection is not private: ${id}`);
    }
    return { message, narrative: this.narrative.loadForMessages([message]) };
  }

  private assertStagedAssistant(threadId: string, projection: ParentTurnProjection): void {
    const projected = projection.message;
    if (!projected) return;
    const staged = stagedAssistantSchema.nullable().parse(this.stagedAssistant.get(projected.id, threadId));
    if (!staged || staged.role !== "assistant" || staged.content !== projected.content) {
      throw new Error(`Staged assistant projection not found: ${projected.id}`);
    }
  }
}

function selectTerminalDiff(input: DataOnlyParentTurnFinishInput, hasAssistant: boolean): SelectedTurnDiff | null | undefined {
  if (input.fileEvidence) assertExecutionFileEvidence(input, hasAssistant);
  const selected = input.fileEvidence?.selectedTurnDiff ?? input.selectedTurnDiff;
  if (selected && (input.outcome !== "completed" || !hasAssistant
    || !validSelectedTurnDiff(selected, input.threadId))) {
    throw new Error("Invalid selected turn diff for terminal assistant");
  }
  return selected;
}

function assertExecutionFileEvidence(input: DataOnlyParentTurnFinishInput, hasAssistant: boolean): void {
  const evidence = input.fileEvidence;
  if (!evidence || !hasAssistant || input.selectedTurnDiff
    || !validExecutionFileEvidence(evidence, input.threadId, input.turnId,
      input.executionId, input.deliveryAttempt)) {
    throw new Error("Invalid execution file evidence for terminal assistant");
  }
}

function validExecutionFileEvidence(
  evidence: PreparedExecutionFileEvidence,
  threadId: string,
  turnId: string,
  executionId: string,
  deliveryAttempt: number | undefined,
): boolean {
  if (!sameTerminalFileOwner(evidence, threadId, turnId, executionId, deliveryAttempt)
    || !TurnFileEffectSummarySchema().safeParse(evidence.fileEffects).success
    || evidence.fileEffects.fileCount !== evidence.fileEffects.effects.length) return false;
  const paths = evidence.fileEffects.effects.filter((effect) => effect.scope === "workspace")
    .map((effect) => effect.path);
  if (JSON.stringify(evidence.filesChanged) !== JSON.stringify(paths)) return false;
  const snapshot = evidence.snapshot;
  if (!snapshot) return evidence.fileEffects.fileCount === 0 && paths.length === 0;
  return validExecutionSnapshot(snapshot, evidence, paths);
}

function sameTerminalFileOwner(
  evidence: PreparedExecutionFileEvidence,
  threadId: string,
  turnId: string,
  executionId: string,
  deliveryAttempt: number | undefined,
): boolean {
  return Number.isSafeInteger(deliveryAttempt) && deliveryAttempt !== undefined && deliveryAttempt >= 1
    && evidence.threadId === threadId && evidence.turnId === turnId
    && evidence.executionId === executionId && evidence.deliveryAttempt === deliveryAttempt;
}

function validExecutionSnapshot(
  snapshot: NonNullable<PreparedExecutionFileEvidence["snapshot"]>,
  evidence: PreparedExecutionFileEvidence,
  paths: readonly string[],
): boolean {
  return snapshot.threadId === evidence.threadId && snapshot.executionId === evidence.executionId
    && snapshot.worktreePath === null && isSnapshotRef(snapshot.refBefore) && isSnapshotRef(snapshot.refAfter)
    && JSON.stringify(snapshot.filesChanged) === JSON.stringify(paths)
    && JSON.stringify(snapshot.fileEffects) === JSON.stringify(evidence.fileEffects);
}

function isSnapshotRef(ref: string): boolean {
  return ref === "" || /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(ref);
}

function validSelectedTurnDiff(selected: SelectedTurnDiff, threadId: string): boolean {
  if (selected.thread_id !== threadId || !Number.isSafeInteger(selected.revision) || selected.revision < 0) return false;
  if (selected.source === "git") return selected.patch === null;
  if (selected.source !== "native" && selected.source !== "tracked") return false;
  return validSelectedPatch(selected.source, selected.patch);
}

function validSelectedPatch(source: "native" | "tracked", patch: string | null): boolean {
  if (typeof patch !== "string" || Buffer.byteLength(patch, "utf8") > TURN_DIFF_MAX_BYTES) return false;
  return source === "native" && patch.length === 0 || parseTurnDiff(patch) !== null;
}

function isUnfinishedLostTurn(
  turn: ReturnType<CanonicalAgentBoundary["loadTurnByExecution"]>,
  checkpoint: ReturnType<CanonicalAgentBoundary["loadCheckpoint"]>,
  input: LostParentExecutionInput,
): boolean {
  return Boolean(turn && checkpoint && turn.id === input.turnId
    && checkpoint.threadId === input.threadId && checkpoint.turnId === input.turnId
    && checkpoint.terminalOutcome === null);
}

function settleTerminalNarrative(
  items: readonly ParentNarrativeRecoveryItem[],
  messageId: string,
  outcome: TurnOutcome,
  endedAt: string,
  assistantContent: string,
): ParentNarrativeRecoveryItem[] {
  const finalText = assistantContent.trim();
  let lastThoughtOrder = -Infinity;
  for (const item of items) {
    if (item.kind === "narrationSegment") lastThoughtOrder = Math.max(lastThoughtOrder, item.record.sort_order);
  }
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
