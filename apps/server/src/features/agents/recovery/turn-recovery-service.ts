import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import { ProviderIdSchema } from "@mcode/contracts";
import { CanonicalAgentBoundary } from "../canonical/canonical-agent-boundary.js";
import { ParentAssistantTextCheckpointService } from "../turns/parent-assistant-text-checkpoint-service.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { ThreadStartupRepo } from "../../thread-startup/persistence/thread-startup-repo.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { buildConversationReplay, replayBudgetChars } from "../../handoff/artifacts/handoff-builder.js";
import { TurnRecoveryError } from "./turn-recovery-error.js";
import {
  buildSeededResumeWire,
  chooseResumePath,
  NativeResumeWatch,
  RESUME_CONTINUATION_PROMPT,
  seededReplayBudget,
  type ResumePathInput,
} from "./turn-resume.js";
import type { SendMessageCommand } from "../orchestration/agent-service.js";
import type {
  IProviderRegistry,
  Message,
  Thread,
  TurnResumeParams,
  TurnResumeResult,
  TurnRetryParams,
  TurnRetryResult,
} from "@mcode/contracts";

const UNPROVED_EXECUTION_REASON =
  "The provider could not prove that this execution was still active after restart.";
// Long enough for a provider to reopen its session, short enough to answer inside the client's request timeout.
const NATIVE_RESUME_WAIT_MS = 15_000;
const SEED_HISTORY_MAX_ROWS = 500;
// Seed history is read by bytes; four bytes per character covers any UTF-8 text the character budget admits.
const SEED_HISTORY_BYTES_PER_CHAR = 4;

/** Dispatches one turn command; resolves once admission completes. */
type TurnDispatch = (command: SendMessageCommand) => Promise<void>;

/** The latest attempt of a turn with its thread and accepted input, validated for a recovery action. */
interface RecoverableTurn {
  readonly executionId: string;
  readonly thread: Thread;
  readonly message: Message;
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
  ) {}

  /**
   * Interrupt executions for which no current provider can prove the exact live execution. Each one is stamped
   * with this startup's recovery incident id as provenance; the thread's Interrupted notice offers Resume.
   */
  async reconcileOnStartup(): Promise<{ interrupted: string[] }> {
    await this.parentAssistantTextCheckpoints.importRecoveryJournals();
    await this.reopenMaterializableTerminalCheckpoints();
    await this.parentAssistantTextCheckpoints.retireTerminalCheckpoints();
    await this.canonicalSink.interruptSavedFamilyChildren(UNPROVED_EXECUTION_REASON);
    const checkpoints = this.canonicalSink.listUnfinishedCheckpoints();
    if (checkpoints.length === 0) return { interrupted: [] };
    const incident = { id: NodeCrypto.randomUUID(), createdAt: new Date().toISOString() };
    const interrupted: string[] = [];
    for (const checkpoint of checkpoints) interrupted.push(await this.interruptUnfinishedCheckpoint(checkpoint, incident));
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
    if (chunkCount > 0 && !await this.parentAssistantTextCheckpoints.retire(checkpoint.executionId)) {
      throw new Error(`Recovered assistant text checkpoint was not retired: ${checkpoint.executionId}`);
    }
    return checkpoint.executionId;
  }

  /** Admit a new attempt of the latest errored turn without replacing its provider session. */
  async retryErroredTurn(input: TurnRetryParams, dispatch: TurnDispatch): Promise<TurnRetryResult> {
    const target = this.requireRecoverableTurn(input, "Errored");
    const attachments = this.attachmentService.prepareRetryAttachments(target.thread.id, target.message.attachments ?? []);
    const turnId = NodeCrypto.randomUUID();
    await this.dispatchAttempt(turnId, {
      ...this.retryCommand(target.thread, target.message, attachments, target.executionId),
      model: input.model ?? this.optionalValue(target.thread.model),
    }, dispatch);
    return { turnId };
  }

  /**
   * Continue the latest interrupted turn as a new attempt. The provider's own session is tried first when it can
   * be resumed; when the provider reports that session gone, a fresh session seeded with the conversation takes over.
   */
  async resumeTurn(input: TurnResumeParams, dispatch: TurnDispatch): Promise<TurnResumeResult> {
    const target = this.requireRecoverableTurn(input, "Interrupted");
    if (chooseResumePath(this.resumePathInput(target.thread)) === "native-session") {
      return this.resumeNatively(target, dispatch);
    }
    return { turnId: await this.dispatchSeededResume(target, target.executionId, dispatch), mode: "seeded-session" };
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

  private async resumeNatively(target: RecoverableTurn, dispatch: TurnDispatch): Promise<TurnResumeResult> {
    const turnId = NodeCrypto.randomUUID();
    const watch = new NativeResumeWatch(turnId);
    let releaseRuntime!: () => void;
    const released = new Promise<void>((resolve) => { releaseRuntime = resolve; });
    try {
      await this.dispatchAttempt(turnId, {
        ...this.continuationCommand(target, target.executionId),
        resumeRequired: true,
        onRuntimeReleased: releaseRuntime,
      }, dispatch);
    } catch (error) {
      watch.close();
      throw error;
    }
    // The fallback hangs off runtime release, not this request, so it still runs after the client stops waiting.
    const settled = released.then(() => this.settleNativeAttempt(watch, target, turnId, dispatch));
    settled.catch((error: unknown) => {
      logger.error("Seeded resume fallback failed", { threadId: target.thread.id, turnId,
        error: error instanceof Error ? error.message : String(error) });
    });
    return this.awaitNativeDecision(turnId, watch, settled);
  }

  /** Runs after the native attempt released its runtime, so a seeded attempt can admit on the same thread. */
  private async settleNativeAttempt(
    watch: NativeResumeWatch,
    target: RecoverableTurn,
    turnId: string,
    dispatch: TurnDispatch,
  ): Promise<TurnResumeResult> {
    watch.close();
    if (!watch.resumeUnavailable) return { turnId, mode: "native-session" };
    const executionId = this.canonicalSink.loadTurn(turnId)?.executionId;
    if (!executionId) throw new Error(`Native resume attempt lost its execution: ${turnId}`);
    return { turnId: await this.dispatchSeededResume(target, executionId, dispatch), mode: "seeded-session" };
  }

  /** Answer once the provider accepts the native attempt, the attempt settles, or the wait bound passes. */
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
    retryOfExecutionId: string,
    dispatch: TurnDispatch,
  ): Promise<string> {
    const turnId = NodeCrypto.randomUUID();
    await this.dispatchAttempt(turnId, {
      ...this.continuationCommand(target, retryOfExecutionId),
      forceFreshSession: true,
      providerWireOverride: this.seededResumeWire(target),
    }, dispatch);
    return turnId;
  }

  /** Replay the visible conversation through the interrupted turn's input, sized for the thread's model. */
  private seededResumeWire(target: RecoverableTurn): string {
    const providerId = ProviderIdSchema.parse(target.thread.provider);
    const budget = seededReplayBudget(providerId, replayBudgetChars(target.thread.model ?? ""));
    const history = this.messages.listByThreadUpToSequenceBudgeted(target.thread.id, target.message.sequence, {
      maxBytes: budget * SEED_HISTORY_BYTES_PER_CHAR,
      maxRows: SEED_HISTORY_MAX_ROWS,
    });
    return buildSeededResumeWire(buildConversationReplay(history.messages, budget));
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
    return { executionId: turn.executionId, ...this.requireRecoveryInput(input.threadId, turn.id) };
  }

  private requireStatus(actual: string, required: "Errored" | "Interrupted"): void {
    if (actual === required) return;
    if (required === "Errored") throw new TurnRecoveryError("TURN_RECOVERY_NOT_ERRORED", "Only errored turns can be retried");
    throw new TurnRecoveryError("TURN_RECOVERY_NOT_INTERRUPTED", "Only interrupted turns can be resumed");
  }

  private requireRecoveryInput(threadId: string, turnId: string): { thread: Thread; message: Message } {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new TurnRecoveryError("TURN_RECOVERY_NOT_FOUND", "Thread not found");
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

  private retryCommand(
    thread: Thread,
    message: Message,
    attachments: ReturnType<AttachmentService["prepareRetryAttachments"]>,
    executionId: string,
  ): SendMessageCommand {
    return {
      ...this.threadSettings(thread),
      content: message.content,
      attachments,
      replyToMessageId: this.optionalValue(message.reply_to_message_id),
      quotedText: this.optionalValue(message.quoted_text),
      mentions: this.optionalValue(message.mentions),
      previewAnnotations: this.optionalValue(message.previewAnnotations),
      // A retried resume attempt keeps its continuation prompt out of the transcript.
      ...(message.is_internal ? { internalUserMessage: true } : {}),
      retryOfExecutionId: executionId,
    };
  }

  /** A hidden continuation prompt carrying the thread's current turn settings. */
  private continuationCommand(target: RecoverableTurn, retryOfExecutionId: string): SendMessageCommand {
    return {
      ...this.threadSettings(target.thread),
      content: RESUME_CONTINUATION_PROMPT,
      attachments: [],
      internalUserMessage: true,
      retryOfExecutionId,
    };
  }

  private threadSettings(thread: Thread): Omit<SendMessageCommand, "content"> {
    return {
      threadId: thread.id,
      model: this.optionalValue(thread.model),
      permissionMode: this.optionalValue(thread.permission_mode),
      reasoningLevel: this.optionalValue(thread.reasoning_level),
      provider: ProviderIdSchema.parse(thread.provider),
      interactionMode: this.optionalValue(thread.interaction_mode),
      orchestrationMode: this.optionalValue(thread.orchestration_mode),
      contextWindow: this.optionalValue(thread.context_window_mode),
      thinking: this.optionalValue(thread.thinking),
      codexFastMode: this.optionalValue(thread.codex_fast_mode),
      devinMode: this.optionalValue(thread.devin_mode),
    };
  }

  private optionalValue<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
  }
}
