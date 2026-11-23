import * as NodeCrypto from "node:crypto";
import { diag } from "@mcode/shared/diagnostics";
import { inject, injectable } from "tsyringe";
import { logger, newHandoffUlid } from "@mcode/shared";
import { ProviderIdSchema } from "@mcode/contracts/models/settings";
import { toPreviewAnnotationBundleV2 } from "@mcode/contracts/models/browser-preview";
import { CanonicalAgentBoundary } from "../canonical/canonical-agent-boundary.js";
import { ParentAssistantTextCheckpointService } from "../turns/parent-assistant-text-checkpoint-service.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { ThreadStartupRepo } from "../../thread-startup/persistence/thread-startup-repo.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { HandoffStorage } from "../../handoff/persistence/handoff-storage.js";
import {
  buildFencedHandoff,
  HandoffBudgetExhaustedError,
  type HandoffMessageInput,
  loadHandoffMessages,
  targetInputCharacterCap,
  type FencedHandoff,
} from "../../handoff/v2/index.js";
import { ToolCallRecordRepo } from "../tools/persistence/tool-call-record-repo.js";
import { TurnRecoveryError } from "./turn-recovery-error.js";
import { launchTelemetry } from "../../../runtime/diagnostics/launch-telemetry.js";
import { chooseResumePath, continuationPrompt, NativeResumeWatch, type RestartContext, type ResumePathInput } from "./turn-resume.js";
import type { SendMessageCommand } from "../orchestration/agent-service.js";
import type { AgentTurnEnding } from "@mcode/contracts/compat/agent-model";
import type { IProviderRegistry } from "@mcode/contracts/providers/interfaces";
import type { Message } from "@mcode/contracts/models/message";
import type { Thread } from "@mcode/contracts/models/thread";
import type { TurnResumeParams, TurnResumeResult, TurnRetryParams, TurnRetryResult } from "@mcode/contracts/models/turn-recovery";

const UNPROVED_EXECUTION_REASON =
  "The provider could not prove that this execution was still active after restart.";
// Long enough for a provider to reopen its session, short enough to answer inside the client's request timeout.
const NATIVE_RESUME_WAIT_MS = 15_000;

/** Dispatches one turn command; resolves once admission completes. */
type TurnDispatch = (command: SendMessageCommand) => Promise<void>;

/** The latest attempt of a turn with its thread and accepted input, validated for a recovery action. */
export interface RecoverableTurn {
  readonly turnId: string;
  readonly executionId: string;
  readonly ending: AgentTurnEnding | null;
  readonly thread: Thread;
  readonly message: Message;
  /** Last message a seeded session replays; defaults to the turn's own prompt. */
  readonly historyThroughSequence?: number;
}

/** Command fields that attach an attempt to the turn's existing user row, which already owns the attachments. */
function reusedUserMessage(
  message: Message,
  stored: NonNullable<Message["attachments"]>,
  persisted: ReturnType<AttachmentService["prepareRetryAttachments"]>,
): Pick<SendMessageCommand, "persistedUserMessage" | "attachments"> {
  return {
    attachments: [],
    persistedUserMessage: { id: message.id, sequence: message.sequence, attachments: stored, persistedAttachments: persisted },
  };
}

/**
 * The continuation prompt only says "continue", so the user's request that the interrupted turn was working on
 * has to reach the fresh session. Whole-item selection can drop it when it is too large; a fence that lists the
 * task as omitted would send the model off with nothing to continue, so that case fails like an exhausted budget.
 */
function requireTaskInHandoff(handoff: FencedHandoff, rows: readonly HandoffMessageInput[], message: Message): void {
  // A failed resume attempt is itself a hidden message; its task is the latest visible user message before it.
  const task = message.is_internal
    ? rows.filter((row) => row.role === "user" && !row.isInternal && row.sequence < message.sequence).at(-1)
    : message;
  if (!task || handoff.selection.selectedSequences.includes(task.sequence)) return;
  throw new HandoffBudgetExhaustedError("The interrupted turn's request does not fit the available byte budget.");
}

/** Reconciles interrupted executions and admits explicit retries and resumes of ended attempts. */
@injectable()
export class TurnRecoveryService {
  constructor(
    @inject(CanonicalAgentBoundary) private readonly canonicalSink: CanonicalAgentBoundary,
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(AttachmentService) private readonly attachmentService: AttachmentService,
    @inject(ParentAssistantTextCheckpointService)
    private readonly parentAssistantTextCheckpoints: ParentAssistantTextCheckpointService,
    @inject(ThreadStartupRepo) private readonly startupRepo: ThreadStartupRepo,
    @inject(MessageRepo) private readonly messages: MessageRepo,
    @inject("IProviderRegistry") private readonly providers: IProviderRegistry,
    @inject(ToolCallRecordRepo) private readonly toolCalls: ToolCallRecordRepo,
    @inject(HandoffStorage) private readonly handoffStorage: HandoffStorage,
  ) {}

  /**
   * Interrupt executions for which no current provider can prove the exact live execution. Each one is stamped
   * with this startup's recovery incident id as provenance.
   */
  async reconcileOnStartup(): Promise<{ interrupted: string[] }> {
    await this.parentAssistantTextCheckpoints.importRecoveryJournals();
    launchTelemetry.mark("journal import");
    await this.reopenMaterializableTerminalCheckpoints();
    launchTelemetry.mark("terminal checkpoint reopening");
    await this.parentAssistantTextCheckpoints.retireTerminalCheckpoints();
    launchTelemetry.mark("terminal checkpoint retirement");
    await this.canonicalSink.interruptSavedFamilyChildren(UNPROVED_EXECUTION_REASON, "running");
    launchTelemetry.mark("family child interruption");
    const checkpoints = this.canonicalSink.listUnfinishedCheckpoints();
    const incident = { id: NodeCrypto.randomUUID(), createdAt: new Date().toISOString() };
    const interrupted: string[] = [];
    for (const checkpoint of checkpoints) {
      interrupted.push(await this.interruptUnfinishedCheckpoint(checkpoint, incident));
      launchTelemetry.mark("checkpoint interrupted");
    }
    // Parent recovery records unresolved deliveries as unavailable before this sweep closes the remaining children.
    await this.canonicalSink.interruptSavedFamilyChildren(UNPROVED_EXECUTION_REASON, "turnless");
    return { interrupted };
  }

  private async reopenMaterializableTerminalCheckpoints(): Promise<void> {
    for (const checkpoint of this.canonicalSink.listUnmaterializedTerminalCheckpoints()) {
      const hasChunks = this.parentAssistantTextCheckpoints.restoreChunks(checkpoint.executionId).length > 0;
      const hasNarrative = this.canonicalSink.loadParentNarrativeRecovery(checkpoint.turnId).length > 0;
      if (hasChunks || hasNarrative) await this.reopenTerminalCheckpoint(checkpoint.executionId);
    }
  }

  private async reopenTerminalCheckpoint(executionId: string): Promise<void> {
    if (!await this.canonicalSink.reopenUnmaterializedTerminalCheckpoint(executionId)) {
      throw new Error(`Unmaterialized terminal checkpoint was not recoverable: ${executionId}`);
    }
  }

  private async interruptUnfinishedCheckpoint(
    checkpoint: ReturnType<CanonicalAgentBoundary["listUnfinishedCheckpoints"]>[number],
    incident: { id: string; createdAt: string },
  ): Promise<string> {
    const chunkCount = this.parentAssistantTextCheckpoints.restoreChunks(checkpoint.executionId).length;
    await this.canonicalSink.interruptUnfinishedExecution({
      threadId: checkpoint.threadId, turnId: checkpoint.turnId, executionId: checkpoint.executionId,
      reason: UNPROVED_EXECUTION_REASON, cause: "app_closed", recoveryIncidentId: incident.id, endedAt: incident.createdAt,
    });
    diag.emit("turn.recovered", { th: checkpoint.threadId }, () => ({
      turn: checkpoint.turnId, execution: checkpoint.executionId, incident: incident.id,
      cause: "app_closed", reason: UNPROVED_EXECUTION_REASON,
    }));
    if (chunkCount > 0 && !await this.parentAssistantTextCheckpoints.retire(checkpoint.executionId)) {
      throw new Error(`Recovered assistant text checkpoint was not retired: ${checkpoint.executionId}`);
    }
    return checkpoint.executionId;
  }

  /**
   * Admit a new attempt of the latest errored turn without replacing its provider session. With
   * `reuseUserMessage` the attempt attaches to the turn's existing user row instead of storing a second copy,
   * for callers that retry on the user's behalf and must not add a visible message.
   */
  async retryErroredTurn(
    input: TurnRetryParams,
    dispatch: TurnDispatch,
    options: { readonly reuseUserMessage?: boolean } = {},
  ): Promise<TurnRetryResult> {
    const target = this.requireRecoverableTurn(input, "Errored");
    if (target.message.is_internal) {
      // A failed resume attempt resumes again, so it keeps the native-session guard or reseeds a fresh session
      // instead of sending the bare continuation prompt to a session that may no longer exist.
      const thread = { ...target.thread, model: input.model ?? target.thread.model };
      return { turnId: (await this.continueTurn({ ...target, thread }, dispatch, false,
        continuationPrompt(null), true)).turnId };
    }
    const turnId = NodeCrypto.randomUUID();
    await this.dispatchAttempt(turnId, {
      ...this.retryCommand(target, options.reuseUserMessage),
      model: input.model ?? this.optionalValue(target.thread.model),
    }, dispatch);
    return { turnId };
  }

  /**
   * Continue the latest interrupted turn as a new attempt, optionally on another model. The provider's own session
   * is tried first when it can be resumed; when the provider reports that session gone, a fresh session seeded with
   * the conversation takes over. A provider other than the thread's goes through the provider switch, which seeds
   * the new provider with its own budgeted handoff.
   */
  async resumeTurn(input: TurnResumeParams, dispatch: TurnDispatch, context?: RestartContext): Promise<TurnResumeResult> {
    const interrupted = this.requireRecoverableTurn(input, "Interrupted");
    const restart = context ?? (interrupted.ending?.outcome === "interrupted" && interrupted.ending.cause === "app_closed"
      ? {} : null);
    if (input.provider && input.provider !== interrupted.thread.provider) {
      return this.resumeOnOtherProvider(interrupted, input.provider, input.model, continuationPrompt(restart), dispatch);
    }
    const target = { ...interrupted, thread: { ...interrupted.thread, model: input.model ?? interrupted.thread.model } };
    return this.continueTurn(target, dispatch, this.limitedBeforeOutput(target), continuationPrompt(restart), true,
      context?.onLateFailure);
  }

  private async resumeOnOtherProvider(
    interrupted: RecoverableTurn,
    provider: NonNullable<TurnResumeParams["provider"]>,
    model: string | undefined,
    prompt: string,
    dispatch: TurnDispatch,
  ): Promise<TurnResumeResult> {
    const attempt = this.limitedBeforeOutput(interrupted)
      ? this.retryCommand(interrupted, true)
      : this.continuationCommand(interrupted, interrupted.executionId, prompt);
    const command = {
      ...attempt,
      provider,
      ...(model ? { model } : {}),
      // Seed a fresh session instead of resuming an earlier one on the target: a gone session there would send this
      // hidden continue through the switch's errored-turn retry.
      forceFreshSession: true,
    };
    const throughSequence = command.persistedUserMessage
      ? command.persistedUserMessage.sequence - 1
      : this.messages.getLatestSequenceIncludingInternal(interrupted.thread.id);
    this.seededResumeHandoff(interrupted, command, throughSequence);
    const turnId = NodeCrypto.randomUUID();
    await this.dispatchAttempt(turnId, command, dispatch);
    return { turnId, mode: "seeded-session" };
  }

  /** Start a hidden continuation for a finished parent without retrying its execution. */
  async wakeParent(input: { threadId: string; anchorTurnId: string }, dispatch: TurnDispatch, context: RestartContext): Promise<TurnResumeResult> {
    const turn = this.canonicalSink.loadTurn(input.anchorTurnId);
    if (!turn || turn.threadId !== input.threadId || !turn.executionId) {
      throw new TurnRecoveryError("TURN_RECOVERY_NOT_FOUND", "Parent turn not found");
    }
    const state = this.canonicalSink.loadTurnRetryState(input.threadId, turn.id);
    if (state.hasLaterTurn || state.hasRunningTurn) {
      throw new TurnRecoveryError("TURN_RECOVERY_CONFLICT", "Parent is no longer idle and latest");
    }
    this.requireTerminalStartup(input.threadId);
    // A wake follows a finished turn, so a seeded session must see that turn's reply, not just its prompt.
    const target = { turnId: turn.id, executionId: turn.executionId, ending: turn.ending,
      ...this.requireRecoveryInput(input.threadId, turn.id),
      historyThroughSequence: this.messages.getLatestSequenceIncludingInternal(input.threadId) };
    return this.continueTurn(target, dispatch, false, continuationPrompt(context), false, context.onLateFailure);
  }

  /** Check that the latest attempt is a usage-limit interruption that can be resumed, without consuming it. */
  requireResumableUsageLimitTurn(input: TurnResumeParams): RecoverableTurn {
    const target = this.requireRecoverableTurn(input, "Interrupted");
    if (target.ending?.outcome === "interrupted" && target.ending.cause === "usage_limit") return target;
    throw new TurnRecoveryError("TURN_RECOVERY_NOT_USAGE_LIMITED", "Only usage-limited turns can be scheduled to resume");
  }

  /**
   * A usage limit can reject the turn before the provider records the prompt. A native resume or provider switch
   * then sends the original input again.
   */
  private limitedBeforeOutput(target: RecoverableTurn): boolean {
    if (target.ending?.outcome !== "interrupted" || target.ending.cause !== "usage_limit") return false;
    if (target.message.is_internal) return false;
    const output = this.canonicalSink.loadTerminalProjection(target.turnId);
    return output.message === null && output.toolCallCount === 0;
  }

  private async continueTurn(
    target: RecoverableTurn,
    dispatch: TurnDispatch,
    resendPrompt = false,
    prompt = continuationPrompt(null),
    retry = true,
    onLateFailure?: (error: unknown) => void,
  ): Promise<TurnResumeResult> {
    if (chooseResumePath(this.resumePathInput(target.thread)) === "native-session") {
      return this.resumeNatively(target, dispatch, resendPrompt, prompt, retry, onLateFailure);
    }
    return { turnId: await this.dispatchSeededResume(target, retry ? target.executionId : undefined, dispatch, prompt), mode: "seeded-session" };
  }

  private resumePathInput(thread: Thread): ResumePathInput {
    const threadProvider = ProviderIdSchema.parse(thread.provider);
    const supportsSessionResume = this.providers.resolve(threadProvider).descriptor.capabilities.some((capability) => (
      capability.name === "session-resume" && capability.support === "supported"
    ));
    // Every turn start records its provider on the canonical thread, so this names the latest (interrupted) turn's provider.
    const turnProvider = this.canonicalSink.loadThread(thread.id)?.providerId ?? null;
    return { supportsSessionResume, sdkSessionId: thread.sdk_session_id, threadProvider, turnProvider };
  }

  private async resumeNatively(
    target: RecoverableTurn,
    dispatch: TurnDispatch,
    resendPrompt: boolean,
    prompt: string,
    retry: boolean,
    onLateFailure: ((error: unknown) => void) | undefined,
  ): Promise<TurnResumeResult> {
    const turnId = NodeCrypto.randomUUID();
    const watch = new NativeResumeWatch(turnId);
    let releaseRuntime!: () => void;
    const released = new Promise<void>((resolve) => { releaseRuntime = resolve; });
    try {
      await this.dispatchAttempt(turnId, {
        ...(resendPrompt ? this.retryCommand(target) : this.continuationCommand(target, retry ? target.executionId : undefined, prompt)),
        resumeRequired: true,
        onRuntimeReleased: releaseRuntime,
      }, dispatch);
    } catch (error) {
      watch.close();
      throw error;
    }
    // The fallback hangs off runtime release, not this request, so it still runs after the client stops waiting.
    const settled = released.then(() => this.settleNativeAttempt(watch, target, turnId, dispatch, prompt, retry));
    let decided = false;
    settled.catch((error: unknown) => {
      logger.error("Seeded resume fallback failed", { threadId: target.thread.id, turnId,
        error: error instanceof Error ? error.message : String(error) });
      // A failure before the decision reaches the caller as a rejection; after it, this is the only report.
      if (decided) onLateFailure?.(error);
    });
    return this.awaitNativeDecision(turnId, watch, settled).then((result) => {
      decided = true;
      return result;
    });
  }

  /** Runs after the native attempt released its runtime, so a seeded attempt can admit on the same thread. */
  private async settleNativeAttempt(
    watch: NativeResumeWatch,
    target: RecoverableTurn,
    turnId: string,
    dispatch: TurnDispatch,
    prompt: string,
    retry: boolean,
  ): Promise<TurnResumeResult> {
    watch.close();
    if (!watch.resumeUnavailable) return { turnId, mode: "native-session" };
    const executionId = this.canonicalSink.loadTurn(turnId)?.executionId;
    if (!executionId) throw new Error(`Native resume attempt lost its execution: ${turnId}`);
    return { turnId: await this.dispatchSeededResume(target, retry ? executionId : undefined, dispatch, prompt), mode: "seeded-session" };
  }

  private async awaitNativeDecision(
    turnId: string,
    watch: NativeResumeWatch,
    settled: Promise<TurnResumeResult>,
  ): Promise<TurnResumeResult> {
    const native: TurnResumeResult = { turnId, mode: "native-session" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitBound = new Promise<TurnResumeResult>((resolve) => {
      timer = setTimeout(() => resolve(native), NATIVE_RESUME_WAIT_MS);
    });
    try {
      return await Promise.race([watch.started.then(() => native), settled, waitBound]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async dispatchSeededResume(
    target: RecoverableTurn,
    retryOfExecutionId: string | undefined,
    dispatch: TurnDispatch,
    prompt: string,
  ): Promise<string> {
    // Built before dispatch so a history that cannot fit fails the resume instead of sending a truncated message.
    const command = this.continuationCommand(target, retryOfExecutionId, prompt);
    const handoff = this.seededResumeHandoff(target, command, target.historyThroughSequence ?? target.message.sequence);
    const turnId = NodeCrypto.randomUUID();
    await this.dispatchAttempt(turnId, {
      ...command,
      forceFreshSession: true,
      providerWireOverride: `${handoff.preamble}${prompt}`,
    }, dispatch);
    await this.writeRecoveryAudit(target.thread, handoff);
    return turnId;
  }

  /** Validate the fresh session's handoff before admission. Provider switches build their own handoff at dispatch. */
  private seededResumeHandoff(target: RecoverableTurn, command: SendMessageCommand, throughSequence: number): FencedHandoff {
    const { thread } = target;
    const fromProvider = ProviderIdSchema.parse(thread.provider);
    const toProvider = command.provider ?? fromProvider;
    const rows = loadHandoffMessages({ messageRepo: this.messages, toolCallRecordRepo: this.toolCalls, threadId: thread.id });
    const attachments = (command.persistedUserMessage?.persistedAttachments ?? []).map((attachment) => ({
      kind: attachment.mimeType.startsWith("image/") ? "image" as const : "file" as const,
    }));
    try {
      const handoff = buildFencedHandoff({
        kind: toProvider === fromProvider ? "recovery" : "switch",
        threadId: thread.id,
        fromProvider,
        toProvider,
        rows,
        afterSequence: 0,
        throughSequence,
        contextWindow: thread.context_window ?? null,
        inputCharacterCap: targetInputCharacterCap(this.providers.resolve(toProvider)),
        userText: command.content,
        attachments,
      });
      // A reused user row is sent as the new input, so it is intentionally outside the history window.
      if (!command.persistedUserMessage) requireTaskInHandoff(handoff, rows, target.message);
      return handoff;
    } catch (error) {
      if (!(error instanceof HandoffBudgetExhaustedError)) throw error;
      throw new TurnRecoveryError(
        error.code,
        `The conversation cannot be replayed into a fresh ${toProvider} session within its context window. ${error.message}`,
        { cause: error },
      );
    }
  }

  private async writeRecoveryAudit(thread: Thread, handoff: FencedHandoff): Promise<void> {
    if (handoff.preamble === "") return;
    const providerId = ProviderIdSchema.parse(thread.provider);
    try {
      await this.handoffStorage.writeHandoffAudit(thread.id, newHandoffUlid(), {
        kind: "recovery",
        fromProvider: providerId,
        toProvider: providerId,
        coveredSequences: handoff.selection.selectedSequences,
        omittedSequences: handoff.selection.omittedSequences,
        budgetBytes: handoff.selection.budgetBytes,
        droppedOptions: [],
        history: handoff.selection.text,
      });
    } catch (error) {
      // The audit is a record of what was sent; losing it must not fail an attempt the provider already accepted.
      logger.error("Recovery handoff audit was not written", { threadId: thread.id,
        error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async dispatchAttempt(turnId: string, command: SendMessageCommand, dispatch: TurnDispatch): Promise<void> {
    await dispatch({ ...command, sourceTurnId: turnId });
    if (!this.canonicalSink.loadTurn(turnId)) {
      throw new TurnRecoveryError("TURN_RECOVERY_NOT_ADMITTED", "Recovery did not admit a new attempt");
    }
  }

  private requireRecoverableTurn(
    input: { threadId: string; turnId: string },
    status: "Errored" | "Interrupted",
  ): RecoverableTurn {
    const turn = this.canonicalSink.loadTurn(input.turnId);
    if (!turn || turn.threadId !== input.threadId || !turn.executionId) {
      throw new TurnRecoveryError("TURN_RECOVERY_NOT_FOUND", "Turn not found in this thread");
    }
    if (this.canonicalSink.loadCheckpoint(turn.executionId)?.phase === "retried") {
      throw new TurnRecoveryError("TURN_RECOVERY_CONFLICT", "This attempt already has a newer attempt");
    }
    const state = this.canonicalSink.loadTurnRetryState(input.threadId, input.turnId);
    if (state.hasLaterTurn) throw new TurnRecoveryError("TURN_RECOVERY_NOT_LATEST", "Only the latest attempt can be recovered");
    if (state.hasRunningTurn) throw new TurnRecoveryError("TURN_RECOVERY_RUNNING", "The thread has a running turn");
    this.requireTerminalStartup(input.threadId);
    this.requireStatus(turn.status, status);
    return {
      turnId: turn.id, executionId: turn.executionId, ending: turn.ending,
      ...this.requireRecoveryInput(input.threadId, turn.id),
    };
  }

  private requireStatus(actual: string, required: "Errored" | "Interrupted"): void {
    if (actual === required) return;
    if (required === "Errored") throw new TurnRecoveryError("TURN_RECOVERY_NOT_ERRORED", "Only errored turns can be retried");
    throw new TurnRecoveryError("TURN_RECOVERY_NOT_INTERRUPTED", "Only interrupted turns can be resumed");
  }

  private requireRecoveryInput(threadId: string, turnId: string): { thread: Thread; message: Message } {
    const thread = this.threadRepo.findById(threadId);
    // A scheduled resume can outlive its thread, so a deleted thread is not recoverable.
    if (!thread || thread.deleted_at !== null) throw new TurnRecoveryError("TURN_RECOVERY_NOT_FOUND", "Thread not found");
    const message = this.canonicalSink.loadUserMessage(turnId);
    if (!message) throw new TurnRecoveryError("TURN_RECOVERY_INPUT_MISSING", "Accepted turn input not found");
    return { thread, message };
  }

  private requireTerminalStartup(threadId: string): void {
    const startup = this.startupRepo.findByThreadId(threadId);
    if (startup && ["pending", "running", "blocked"].includes(startup.state)) {
      throw new TurnRecoveryError("TURN_RECOVERY_STARTUP_ACTIVE", "The thread has a nonterminal startup");
    }
  }

  private retryCommand(target: RecoverableTurn, reuse = false): SendMessageCommand {
    const { thread, message, executionId } = target;
    const stored = message.attachments ?? [];
    const attachments = this.attachmentService.prepareRetryAttachments(thread.id, stored, { keepIds: reuse });
    return {
      ...threadContinuationSettings(thread),
      content: message.content,
      attachments,
      replyToMessageId: this.optionalValue(message.reply_to_message_id),
      quotedText: this.optionalValue(message.quoted_text),
      mentions: this.optionalValue(message.mentions),
      previewAnnotations: this.retryAnnotations(message, attachments),
      retryOfExecutionId: executionId,
      ...(reuse ? reusedUserMessage(message, stored, attachments) : {}),
    };
  }

  private retryAnnotations(message: Message, attachments: ReturnType<AttachmentService["prepareRetryAttachments"]>) {
    if (!message.previewAnnotations) return undefined;
    const bundle = toPreviewAnnotationBundleV2(message.previewAnnotations);
    const replacements = new Map(message.attachments?.map((attachment, index) => [attachment.id, attachments[index]]));
    return { ...bundle, pages: bundle.pages.map((page) => {
      const attachment = replacements.get(page.snapshot.id);
      if (!attachment) throw new Error(`Stored page snapshot not found: ${page.snapshot.id}`);
      return { ...page, snapshot: { ...page.snapshot, id: attachment.id, sourcePath: attachment.sourcePath } };
    }) };
  }

  private continuationCommand(target: RecoverableTurn, retryOfExecutionId: string | undefined, prompt: string): SendMessageCommand {
    return {
      ...threadContinuationSettings(target.thread),
      content: prompt,
      attachments: [],
      internalUserMessage: true,
      ...(retryOfExecutionId ? { retryOfExecutionId } : {}),
    };
  }

  private optionalValue<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
  }
}

/** Continue a thread with its persisted provider and composer selections. */
export function threadContinuationSettings(thread: Thread): Omit<SendMessageCommand, "content"> {
  return {
    threadId: thread.id, model: thread.model ?? undefined, permissionMode: thread.permission_mode ?? undefined,
    reasoningLevel: thread.reasoning_level ?? undefined, provider: ProviderIdSchema.parse(thread.provider),
    interactionMode: thread.interaction_mode ?? undefined, orchestrationMode: thread.orchestration_mode ?? undefined,
    thinking: thread.thinking ?? undefined,
    fastMode: thread.fast_mode ?? undefined, devinMode: thread.devin_mode ?? undefined,
  };
}
