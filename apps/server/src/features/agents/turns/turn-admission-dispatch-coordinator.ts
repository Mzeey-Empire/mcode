import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import { previewAnnotationPageSnapshotName, toPreviewAnnotationBundleV2, isDiffAnnotationPayload, isFileAnnotationPayload } from "@mcode/contracts/models/browser-preview";
import { type AttachmentMeta, type StoredAttachment } from "@mcode/contracts/models/attachment";
import { type ContextWindowMode } from "@mcode/contracts/models/settings";
import { type DevinMode, type InteractionMode, type PermissionMode } from "@mcode/contracts/models/enums";
import { type IAgentProvider, type IProviderRegistry, type ProviderId, type TurnRequest } from "@mcode/contracts/providers/interfaces";
import { type MessageMention } from "@mcode/contracts/models/mention";
import { type ProviderModelInfo } from "@mcode/contracts/providers/models";
import { type SendMessageInput } from "@mcode/contracts/ws/methods";
import { type SystemNoticeMetadata } from "@mcode/contracts/models/message";
import { type Thread } from "@mcode/contracts/models/thread";
import { type TurnRuntimeSnapshot } from "@mcode/contracts/models/turn-runtime";
import { logger, validateBranchName } from "@mcode/shared";
import { broadcast } from "../../../application/transport/push.js";
import { publishSynthesizedAgentEvents } from "../canonical/synthesized-agent-event-publication.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { FileService } from "../../projects/files/file-service.js";
import { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import { WorkspaceEnvironmentService } from "../../projects/index.js";
import { WorkspaceEnvironmentServiceError } from "../../projects/environment/workspace-environment-errors.js";
import { isAutomaticSetupThread } from "../../projects/environment/workspace-environment-service.js";
import { normalizeWorktreePath } from "../../projects/git/worktree-path.js";
import type { ThreadStartupThreadCreation } from "../../thread-startup/thread-startup-service.js";
import { injectMentionFileContents, validateMessageMentions } from "./message-mentions.js";
import type { WorkspaceEnvironmentQueuedTurnSubmission } from "../../projects/environment/workspace-environment-automatic-repository.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { ProviderAvailabilityService } from "../../providers/availability/provider-availability-service.js";
import type { SettingsService } from "../../settings/settings-service.js";
import {
  ProviderCliMissingError,
  ProviderDisabledError,
} from "../../providers/availability/provider-availability-errors.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { CompletionHolds } from "../../thread-control/lifecycle/completion-holds.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { TurnRevertStore } from "./persistence/turn-revert-store.js";
import {
  type DataOnlyParentTurnStartInput,
  type ParentUserMessageWrite,
} from "../canonical/canonical-parent-turn-write.js";
import {
  GoalLifecycleService,
  type GoalCommandEffectReceipt,
} from "../goals/goal-lifecycle-service.js";
import { PlanTurnService, type PlanTurnClassification } from "../planning/plan-turn-service.js";
import type { TurnResumeScheduler } from "../recovery/turn-resume-scheduler.js";
import {
  type ParentTurnDurability,
} from "./parent-turn-durability.js";
import { appendSelectedTextComments, appendPlanComments } from "./selected-text-comment-append.js";
import { ApprovalReviewPolicy, type ApprovalReviewDecision } from "./approval-review-policy.js";
import type { ExecutionIdentity } from "../execution/execution-mailbox-protocol.js";
import type { ExecutionParentStartContext } from "../execution/provider-execution-event-state.js";
import type { ProviderSwitchService, ProviderSwitchTicket } from "./provider-switch-service.js";


/** Automatic setup dispatch contract exposed to the turn command facade. */
export type { WorkspaceEnvironmentQueuedTurnSubmission };

/** Injection token for the complete first-turn admission coordinator. */
export const TURN_ADMISSION_DISPATCH_COORDINATOR = "TurnAdmissionDispatchCoordinator";

/** An existing-worktree choice rejected before a thread is persisted. */
export class ExistingWorktreePlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExistingWorktreePlacementError";
  }
}

class TurnAdmissionOwnershipLostError extends Error {}

/** Why a turn's runtime slot was released; absent for a turn that ran to its terminal state. */
export type RuntimeReleaseCause = "admission-failed";

/** A complete command accepted by a parent-turn admission coordinator. */
export type SendMessageCommand = Omit<SendMessageInput, "permissionMode" | "provider"> & {
  permissionMode?: PermissionMode | "default";
  provider?: ProviderId;
  /** Assistant message whose plan-question batch is settled by this send. */
  markPlanAnswerForMessageId?: string;
  /** Provider payload used instead of the persisted user-facing content. */
  providerWireOverride?: string;
  /** Server-built fork history, prepended only to the provider's first-turn payload. */
  handoffPreamble?: string;
  /** Server-assigned turn identity used by thread-control creation results. */
  sourceTurnId?: string;
  /** Source thread identity for a cross-thread user message origin. */
  sourceThreadId?: string;
  /** Source provider identity for a cross-thread user message origin. */
  sourceProviderId?: string;
  /** Source turn identity for a cross-thread user message origin. */
  originSourceTurnId?: string;
  /** Existing shared mutation reservation supplied by thread-control approval dispatch. */
  mutationReservationToken?: string;
  /** Request whose plan acceptance commits with canonical parent start. */
  planImplement?: { requestId: string };
  setupSkip?: {
    reason: Extract<import("@mcode/contracts/thread-startup").ThreadStartupStepDetail, { phase: "setup" }>["skipReason"] & ("plan-implement" | "delegation");
    sourceThreadId: string;
  };
  /** Resolves the authoritative first-turn handshake before provider I/O continues. */
  onTurnStarted?: (snapshot: TurnRuntimeSnapshot) => void;
  /** Reports whether admission produced a turn before provider dispatch. */
  onAdmissionComplete?: (turnAdmitted: boolean) => void;
  /** Starts a new provider execution instead of continuing the thread's prior native session. */
  forceFreshSession?: boolean;
  /** Interrupted execution consumed atomically when the replacement turn starts. */
  retryOfExecutionId?: string;
  /** Continues the thread's native provider session or fails; never opens a fresh one. */
  resumeRequired?: boolean;
  /** Stores the user row hidden from the transcript, for server-authored continuation prompts. */
  internalUserMessage?: boolean;
  /**
   * Runs once this turn's runtime releases its active slot, so a follow-up turn on the thread can admit.
   * `admission-failed` means the turn never reached a provider, so no terminal event will follow.
   */
  onRuntimeReleased?: (cause?: RuntimeReleaseCause) => void;
  /** First-Turn message and attachment data already committed by the automatic Setup gate. */
  persistedUserMessage?: {
    readonly id: string;
    readonly sequence: number;
    readonly attachments: readonly StoredAttachment[];
    readonly persistedAttachments: readonly AttachmentMeta[];
  };
  /** Attachment records already persisted before a concurrent automatic-gate release. */
  persistedAttachmentData?: {
    readonly stored: readonly StoredAttachment[];
    readonly persisted: readonly AttachmentMeta[];
  };
  /** Whether a handled native command must clean pre-persisted automatic-gate attachments. */
  cleanupPersistedAttachmentsOnHandledCommand?: boolean;
  /** Admits a turn the provider already started; `content` is its opening notice, not a prompt. */
  providerOriginated?: boolean;
  /** Server-authored Coordinator wake; retains tool eligibility and persisted settings. */
  delegationWake?: boolean;
  /** Server-only timeline attribution for an admitted user-role message. */
  systemNotice?: SystemNoticeMetadata;
};

/** An opaque receipt for a command effect that can be activated or rolled back. */
export type CommandEffectReceipt = GoalCommandEffectReceipt;

/** A runtime admission owned by the AgentService. */
export interface TurnRuntimeLease {
  readonly threadId: string;
  readonly turnExecutionId: string;
  readonly mutationReservationToken: string;
  readonly generation: number;
}

/** The only runtime authority available to turn admission. */
export interface TurnRuntimeAdmissionAuthority {
  reserve(command: SendMessageCommand): TurnRuntimeLease;
  activate(lease: TurnRuntimeLease): void;
  abort(lease: TurnRuntimeLease): Promise<void>;
  release(lease: TurnRuntimeLease): void;
  owns(lease: TurnRuntimeLease): boolean;
}

/** The model catalog admission reads to learn whether the turn's model declares Fast. */
export interface TurnModelCatalog {
  listModels(providerId: ProviderId): Promise<ProviderModelInfo[]>;
}

/** Commits a new parent turn through its exact execution mailbox. */
export interface TurnParentStartOwner {
  start(input: {
    readonly execution: ExecutionIdentity;
    readonly ownerEpoch: number;
    readonly providerId: string;
    readonly parentTurn: DataOnlyParentTurnStartInput;
    readonly parentLive?: ExecutionParentStartContext;
    readonly publishParentStart?: boolean;
  }): Promise<void>;
}

/** The thread-control action selected during generic dispatch preparation. */
export interface ThreadControlLeaseDirective {
  readonly sessionId: string;
  readonly sourceThreadId: string;
  readonly sourceTurnId: string;
  readonly sourceProviderId: ProviderId;
  readonly permissionMode: "supervised" | "full";
}

/** A provider-ready turn package with no persistence or provider-selection work left. */
export interface PreparedTurnDispatch {
  readonly kind: "dispatch";
  readonly lease: TurnRuntimeLease;
  readonly parentStartInput: DataOnlyParentTurnStartInput;
  readonly provider: IAgentProvider;
  readonly providerId: ProviderId;
  readonly request: TurnRequest;
  readonly cwd: string;
  readonly commandEffect: CommandEffectReceipt | null;
  readonly threadControl: ThreadControlLeaseDirective | null;
  readonly contextSeed: number;
  readonly contextWindow: number | null;
  /** Discard any pooled provider session first, so a fresh-session turn cannot inherit its native history. */
  readonly replaceSession?: true;
  /** A switch whose history cannot fit the target: the turn ends with this error instead of reaching the provider. */
  readonly dispatchRefusal?: Error;
}

/** The stable outcome of handling a complete send command. */
export type TurnAdmissionResult =
  | { readonly kind: "handled" }
  | { readonly kind: "queued" }
  | PreparedTurnDispatch;

interface PreparedCommand {
  plan: PlanTurnClassification;
  readonly command: SendMessageCommand;
  readonly thread: ReturnType<ThreadRepo["findById"]> extends infer T ? Exclude<T, null> : never;
  readonly workspace: ReturnType<WorkspaceRepo["findById"]> extends infer T ? Exclude<T, null> : never;
  readonly providerId: ProviderId;
  readonly provider: IAgentProvider;
  readonly mentions: readonly MessageMention[];
  readonly commentMentions: readonly MessageMention[];
  readonly commandEffect: CommandEffectReceipt | null;
  readonly content: string;
  readonly automaticAttachments: PersistedAttachmentData | null;
  /** Present when this send changes the thread's provider; the change commits only once the target accepts the turn. */
  readonly providerSwitch?: ProviderSwitchTicket;
}

interface PersistedAttachmentData {
  readonly stored: readonly StoredAttachment[];
  readonly persisted: readonly AttachmentMeta[];
  /** Staged draft images whose file already belonged to an earlier message. */
  readonly reused?: readonly string[];
}

/** The copies this admission wrote. A reused draft image belongs to an admitted message and survives a rollback. */
function ownCopies(data: PersistedAttachmentData): StoredAttachment[] {
  const reused = new Set(data.reused);
  return data.stored.filter((attachment) => !reused.has(attachment.id));
}

/** Owns complete message admission, durable parent-turn projection, and dispatch preparation. */
export class TurnAdmissionDispatchCoordinator {
  private readonly approvalReviews = new ApprovalReviewPolicy();
  constructor(
    private readonly threads: ThreadRepo,
    private readonly workspaces: WorkspaceRepo,
    private readonly messages: MessageRepo,
    private readonly reverts: TurnRevertStore,
    private readonly worktrees: GitWorktreeService,
    private readonly attachments: AttachmentService,
    private readonly providers: IProviderRegistry,
    private readonly availability: ProviderAvailabilityService,
    private readonly parentTurns: ParentTurnDurability,
    private readonly settings: Pick<SettingsService, "get">,
    private readonly plans: PlanTurnService,
    private readonly goals: GoalLifecycleService,
    private readonly environment: WorkspaceEnvironmentService | undefined,
    private readonly files: FileService | undefined,
    private readonly platform: NodeJS.Platform,
    private readonly models: TurnModelCatalog,
    private readonly parentStartOwner: TurnParentStartOwner,
    private readonly resumeScheduler?: Pick<TurnResumeScheduler, "unschedule">,
    private readonly providerSwitch?: ProviderSwitchService,
    private readonly completionHolds: CompletionHolds = new CompletionHolds(),
  ) {}

  /** Admit one command and return an immutable package for the runtime owner. */
  async admit(
    command: SendMessageCommand,
    runtime: TurnRuntimeAdmissionAuthority,
    canReserve?: () => boolean,
  ): Promise<TurnAdmissionResult> {
    this.completionHolds.cancel(command.threadId);
    await this.resumeScheduler?.unschedule(command.threadId);
    const release = command.stagedDraftImageIds?.length
      ? this.attachments.leaseDraftImages(command.threadId, command.stagedDraftImageIds)
      : undefined;
    try {
      const admitted = await this.admitLeased(command, runtime, canReserve);
      // A schedule can be requested while preparation awaits I/O and the old attempt is still latest.
      await this.resumeScheduler?.unschedule(command.threadId);
      command.onAdmissionComplete?.(admitted.kind === "dispatch");
      return admitted;
    } finally {
      release?.();
    }
  }

  private async admitLeased(
    command: SendMessageCommand,
    runtime: TurnRuntimeAdmissionAuthority,
    canReserve?: () => boolean,
  ): Promise<TurnAdmissionResult> {
    const prepared = await this.prepare(command);
    if (prepared.kind !== "ready") return prepared;
    if (canReserve && !canReserve()) {
      this.completeCommandEffect(prepared.value.commandEffect);
      await this.cleanupAutomaticDraftCopies(prepared.value);
      return { kind: "handled" };
    }
    let lease: TurnRuntimeLease | undefined;
    try {
      this.completionHolds.cancel(command.threadId);
      lease = runtime.reserve(prepared.value.providerSwitch?.command ?? command);
      this.reserveCommandEffect(prepared.value.commandEffect);
      return await this.commit(prepared.value, lease, runtime);
    } catch (error) {
      await this.rollbackAdmission(prepared.value, lease, runtime);
      if (error instanceof TurnAdmissionOwnershipLostError) return { kind: "handled" };
      throw error;
    }
  }

  private async rollbackAdmission(
    prepared: PreparedCommand,
    lease: TurnRuntimeLease | undefined,
    runtime: TurnRuntimeAdmissionAuthority,
  ): Promise<void> {
    if (prepared.providerSwitch) this.providerSwitch?.discard(prepared.providerSwitch);
    await this.cleanupAutomaticDraftCopies(prepared);
    if (lease) {
      await runtime.abort(lease);
      runtime.release(lease);
    }
    await this.rollbackCommandEffect(prepared.commandEffect);
  }

  /** Activate a deferred command effect at the provider-dispatch boundary. */
  async activateCommandEffect(receipt: CommandEffectReceipt | null): Promise<void> {
    if (receipt) await this.goals.dispatchCommandEffect(receipt);
  }

  /** Roll back a dispatched command effect after the turn can no longer run. */
  async rollbackCommandEffect(receipt: CommandEffectReceipt | null): Promise<void> {
    if (!receipt) return;
    try {
      await this.goals.rollbackCommandEffect(receipt);
    } catch (error) {
      logger.warn("Failed to roll back command side effect", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Discard a completed command effect once it no longer needs rollback. */
  completeCommandEffect(receipt: CommandEffectReceipt | null): void {
    if (receipt) this.goals.completeCommandEffect(receipt);
  }

  /** Mark a committed turn active before its provider receives TurnStarted. */
  async markDispatchActive(threadId: string): Promise<void> {
    await this.threads.updateStatus(threadId, "active");
    await this.threads.advanceActivity(threadId, new Date().toISOString());
  }

  /** Load the message already persisted by the automatic setup gate. */
  queuedMessage(threadId: string, messageId: string) {
    const message = this.messages.findByIdInThread(threadId, messageId);
    if (!message) throw new Error(`Queued Turn message was not found for Thread: ${threadId}`);
    return message;
  }

  /** Rehydrate an automatic-gate submission as one complete turn command. */
  queuedCommand(submission: WorkspaceEnvironmentQueuedTurnSubmission): SendMessageCommand {
    const message = submission.planImplement ? null : this.queuedMessage(submission.threadId, submission.messageId);
    return {
      threadId: submission.threadId,
      messageId: submission.messageId,
      planImplement: submission.planImplement,
      content: submission.content,
      displayContent: submission.displayContent,
      model: submission.model,
      permissionMode: submission.permissionMode,
      attachments: [],
      provider: submission.provider as ProviderId,
      reasoningLevel: submission.reasoningLevel as SendMessageCommand["reasoningLevel"],
      interactionMode: submission.interactionMode as InteractionMode | undefined,
      orchestrationMode: submission.orchestrationMode as SendMessageCommand["orchestrationMode"],
      maxBudgetUsd: submission.maxBudgetUsd,
      maxTurns: submission.maxTurns,
      contextWindow: submission.contextWindow as ContextWindowMode | undefined,
      thinking: submission.thinking,
      fastMode: submission.fastMode,
      goalObjective: submission.goalObjective,
      replyToMessageId: submission.replyToMessageId,
      quotedText: submission.quotedText,
      selectedTextComments: submission.selectedTextComments ? [...submission.selectedTextComments] : undefined,
      planCommentIds: submission.planCommentIds,
      markPlanAnswerForMessageId: submission.markPlanAnswerForMessageId,
      sourceTurnId: submission.sourceTurnId,
      sourceThreadId: submission.sourceThreadId,
      sourceProviderId: submission.sourceProviderId as ProviderId | undefined,
      originSourceTurnId: submission.originSourceTurnId,
      mentions: [...submission.mentions],
      previewAnnotations: submission.previewAnnotations,
      persistedUserMessage: message ? {
        id: message.id,
        sequence: message.sequence,
        attachments: submission.attachments,
        persistedAttachments: submission.persistedAttachments,
      } : undefined,
    };
  }

  /** Attach a direct thread to a verified existing worktree. */
  async createAttachedExistingWorktreeThread(params: {
    workspaceId: string;
    title: string;
    existingWorktreePath: string;
    provider: ProviderId;
    baseBranch?: string;
    lineage?: Parameters<ThreadRepo["create"]>[6];
  }, createAndBind?: (input: ThreadStartupThreadCreation) => Promise<Thread>): Promise<Thread> {
    const workspace = this.workspaces.findById(params.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${params.workspaceId}`);
    const known = await this.worktrees.listWorktrees(params.workspaceId);
    const matched = known.find((worktree) => this.sameWorktreePath(worktree.path, params.existingWorktreePath));
    if (!matched) throw new ExistingWorktreePlacementError("Path is not a recognized worktree");
    const detached = matched.branch === "(detached)";
    const branch = detached ? params.baseBranch : matched.branch;
    const baseBranch = this.requireAttachedBranch(branch, detached);
    if (createAndBind) {
      return createAndBind({ args: [params.workspaceId, params.title, "worktree", baseBranch, false,
        params.provider, params.lineage, detached ? "branchless" : "named", detached ? baseBranch : null], worktreePath: matched.path });
    }
    const thread = await this.threads.create(
      params.workspaceId, params.title, "worktree", baseBranch, false, params.provider, params.lineage,
      detached ? "branchless" : "named", detached ? baseBranch : null,
    );
    await this.threads.updateWorktreePath(thread.id, matched.path);
    return { ...thread, worktree_path: matched.path };
  }

  private requireAttachedBranch(branch: string | undefined, detached: boolean): string {
    if (!branch) throw new ExistingWorktreePlacementError("Base branch is required when attaching a detached worktree");
    if (detached && branch === "HEAD") throw new ExistingWorktreePlacementError("Base branch cannot be HEAD when attaching a detached worktree");
    validateBranchName(branch);
    return branch;
  }

  /** Persist and gate a worktree thread's first turn before runtime admission starts. */
  async admitInitialAutomaticTurn(command: SendMessageCommand): Promise<
    | { readonly kind: "not-managed" }
    | { readonly kind: "queued" }
    | { readonly kind: "ready"; readonly attachments: PersistedAttachmentData }
  > {
    this.completionHolds.cancel(command.threadId);
    const release = command.stagedDraftImageIds?.length
      ? this.attachments.leaseDraftImages(command.threadId, command.stagedDraftImageIds)
      : undefined;
    try {
      return await this.admitLeasedInitialAutomaticTurn(command);
    } finally {
      release?.();
    }
  }

  private async cleanupAutomaticDraftCopies(prepared: PreparedCommand): Promise<void> {
    if (prepared.command.stagedDraftImageIds?.length && prepared.automaticAttachments) {
      await this.attachments.removeStoredAttachments(prepared.command.threadId, ownCopies(prepared.automaticAttachments));
    }
  }

  private async admitLeasedInitialAutomaticTurn(command: SendMessageCommand): Promise<
    | { readonly kind: "not-managed" }
    | { readonly kind: "queued" }
    | { readonly kind: "ready"; readonly attachments: PersistedAttachmentData }
  > {
    const thread = this.requireThread(command.threadId);
    if (!isAutomaticSetupThread(thread) || !this.environment) {
      return { kind: "not-managed" };
    }
    const providerId = this.selectProvider(thread.provider, command.provider);
    const workspace = this.requireWorkspace(thread.workspace_id);
    const mentions = this.validateMentions({
      workspaceId: workspace.id,
      threadId: thread.id,
      content: command.content,
      mentions: command.mentions ?? [],
      providerId,
    });
    const attachments = await this.persistCommandAttachments(command);
    try {
      const admission = await this.environment.admitAutomaticTurn(
        this.automaticSubmission(command, thread, providerId, mentions, attachments),
      );
      return admission.queued ? { kind: "queued" } : { kind: "ready", attachments };
    } catch (error) {
      await this.attachments.removeStoredAttachments(command.threadId, ownCopies(attachments));
      throw error;
    }
  }

  /** The command to run, plus the ticket when its provider differs from the thread's and history exists to carry over. */
  private openProviderSwitch(
    command: SendMessageCommand,
    currentProvider: string,
  ): Pick<PreparedCommand, "command" | "providerSwitch"> {
    const ticket = this.providerSwitch?.open(command, currentProvider);
    // A thread with no earlier messages has no history or native session to protect, so its first provider choice applies at once.
    if (!ticket || !this.hasEarlierMessages(command)) return { command };
    return { command: ticket.command, providerSwitch: ticket };
  }

  private sameWorktreePath(left: string, right: string): boolean {
    return normalizeWorktreePath(left, this.platform) === normalizeWorktreePath(right, this.platform);
  }

  private async prepare(command: SendMessageCommand): Promise<{ kind: "ready"; value: PreparedCommand } | { kind: "handled" } | { kind: "queued" }> {
    if (command.previewAnnotations) command = { ...command, previewAnnotations: toPreviewAnnotationBundleV2(command.previewAnnotations) };
    this.requireCompleteProvenance(command);
    const thread = this.requireThread(command.threadId);
    this.requireSendableThread(thread);
    const providerId = this.selectProvider(thread.provider, command.provider);
    this.assertProviderAvailable(command.threadId, providerId);
    const workspace = this.requireWorkspace(thread.workspace_id);
    const mentions = this.validateMentions({
      workspaceId: workspace.id,
      threadId: command.threadId,
      content: command.content,
      mentions: command.mentions ?? [],
      providerId,
    });
    const commentMentions = this.validateCommentMentions(command, workspace.id, providerId);
    const automatic = await this.admitAutomaticSetup(command, thread, mentions, providerId);
    if (automatic.kind !== "continue") return automatic;
    try {
      const provider = this.providers.resolve(providerId);
      const routed = command.providerOriginated
        ? { kind: "ready" as const, content: command.content, commandEffect: null }
        : await this.routeCommand(command, provider);
      if (routed.kind === "handled") {
        await this.cleanupHandledAttachments(command.threadId, automatic.handledCommandAttachmentCleanup);
        return routed;
      }
      return {
        kind: "ready",
        value: {
          ...this.openProviderSwitch(command, thread.provider),
          thread,
          workspace,
          providerId,
          provider,
          mentions,
          commentMentions,
          commandEffect: routed.commandEffect,
          content: routed.content,
          automaticAttachments: automatic.attachments,
          plan: { kind: "none" },
        },
      };
    } catch (error) {
      if (command.stagedDraftImageIds?.length && automatic.attachments) {
        await this.attachments.removeStoredAttachments(command.threadId, ownCopies(automatic.attachments));
      }
      throw error;
    }
  }

  private async commit(
    initial: PreparedCommand,
    lease: TurnRuntimeLease,
    runtime: TurnRuntimeAdmissionAuthority,
  ): Promise<PreparedTurnDispatch> {
    const prepared = initial.providerSwitch ? await this.planProviderSwitch(initial) : initial;
    await this.preparePlanFile(prepared.command, prepared.providerId);
    prepared.plan = this.plans.classify(prepared.command);
    const cwd = this.resolveWorkingDirectory(prepared);
    const review = await this.approvalReviews.resolve({
      requestedMode: prepared.command.approvalReviewMode,
      permissionMode: this.effectivePermissionMode(prepared.command.permissionMode, prepared.thread.permission_mode ?? "supervised"),
      interactionMode: this.effectiveInteractionMode(prepared),
      model: prepared.command.model ?? "claude-sonnet-4-6",
      provider: prepared.provider,
    });
    runtime.activate(lease);
    const attachmentData = await this.persistAttachments(prepared);
    try {
      return await this.commitWithAttachments(prepared, lease, attachmentData, cwd, review, runtime);
    } catch (error) {
      if (prepared.command.stagedDraftImageIds?.length && !prepared.command.persistedUserMessage) {
        await this.attachments.removeStoredAttachments(prepared.command.threadId, ownCopies(attachmentData));
      }
      throw error;
    }
  }

  private hasEarlierMessages(command: SendMessageCommand): boolean {
    return command.persistedUserMessage
      ? command.persistedUserMessage.sequence > 1
      : this.messages.getLatestSequenceIncludingInternal(command.threadId) > 0;
  }

  /** Settle a switch's history and target session once the thread is reserved, so the previous turn's rows are final. */
  private async planProviderSwitch(prepared: PreparedCommand): Promise<PreparedCommand> {
    const ticket = prepared.providerSwitch;
    if (!ticket || !this.providerSwitch) return prepared;
    const { command } = prepared;
    const throughSequence = command.persistedUserMessage
      ? command.persistedUserMessage.sequence - 1
      : this.messages.getLatestSequenceIncludingInternal(command.threadId);
    await this.providerSwitch.plan(ticket, { thread: prepared.thread, throughSequence });
    return { ...prepared, command: ticket.command };
  }

  private async preparePlanFile(command: SendMessageCommand, providerId: ProviderId): Promise<void> {
    if ((command.interactionMode ?? this.threads.findById(command.threadId)?.interaction_mode) === "plan"
      || command.planCommentIds?.length || command.markPlanAnswerForMessageId) {
      await this.plans.prepareTurn(command.threadId);
      await this.plans.prepareNativeQuestions(command.threadId, providerId);
    }
  }

  private async commitWithAttachments(
    prepared: PreparedCommand,
    lease: TurnRuntimeLease,
    attachmentData: PersistedAttachmentData,
    cwd: string,
    review: ApprovalReviewDecision,
    runtime: TurnRuntimeAdmissionAuthority,
  ): Promise<PreparedTurnDispatch> {
    const sourceTurnId = prepared.command.sourceTurnId ?? NodeCrypto.randomUUID();
    const parentStartInput = this.prepareParentTurnStartInput(prepared, lease, sourceTurnId, attachmentData, review);
    const revertNotice = prepared.command.providerOriginated
      ? { revertIds: [], paths: [] } : this.reverts.pendingAgentNotice(prepared.thread.id);
    parentStartInput.revertNoticeIds = revertNotice.revertIds;
    let wirePayload = await this.buildWirePayload(prepared, revertNotice.paths);
    if (!runtime.owns(lease)) throw new TurnAdmissionOwnershipLostError();
    await this.commitParentStart(prepared, lease, sourceTurnId, parentStartInput);
    if (prepared.command.planCommentIds?.length) {
      const { comments, versions } = this.plans.sentComments(prepared.thread.id, prepared.command.planCommentIds);
      wirePayload = appendPlanComments(wirePayload, comments, versions);
    }
    await this.publishCommittedEffects(prepared, sourceTurnId);
    const request = await this.buildTurnRequest(prepared, lease, sourceTurnId, attachmentData, cwd, wirePayload, review);
    return {
      kind: "dispatch",
      lease,
      parentStartInput,
      provider: prepared.provider,
      providerId: prepared.providerId,
      request,
      cwd,
      commandEffect: prepared.commandEffect,
      threadControl: this.threadControlDirective(prepared, sourceTurnId),
      contextSeed: prepared.thread.last_context_tokens ?? 0,
      contextWindow: prepared.thread.context_window,
      ...this.sessionDirectives(prepared),
    };
  }

  private sessionDirectives(prepared: PreparedCommand): Pick<PreparedTurnDispatch, "replaceSession" | "dispatchRefusal"> {
    const refusal = prepared.providerSwitch?.plan?.refusal;
    return {
      ...(prepared.command.forceFreshSession ? { replaceSession: true as const } : {}),
      ...(refusal ? { dispatchRefusal: refusal } : {}),
    };
  }

  private requireCompleteProvenance(command: SendMessageCommand): void {
    const values = [command.sourceThreadId, command.originSourceTurnId, command.sourceProviderId];
    const any = values.some((value) => value !== undefined);
    const complete = values.every((value) => typeof value === "string" && value.length > 0);
    if (any && !complete) throw new Error("Cross-thread messages require a complete thread provenance tuple");
  }

  private requireThread(threadId: string): Exclude<ReturnType<ThreadRepo["findById"]>, null> {
    const thread = this.threads.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
  }

  private requireSendableThread(thread: Exclude<ReturnType<ThreadRepo["findById"]>, null>): void {
    if (["failed", "stopped", "archived", "deleted"].includes(thread.status)) {
      throw new Error(`Cannot send message to terminal thread: ${thread.id}`);
    }
    if (thread.deleted_at != null) throw new Error(`Cannot send message to deleted thread: ${thread.id}`);
  }

  private selectProvider(threadProvider: string | null, requested: ProviderId | undefined): ProviderId {
    return requested ?? (threadProvider as ProviderId) ?? "claude";
  }

  private assertProviderAvailable(threadId: string, providerId: ProviderId): void {
    try {
      this.availability.assertUsable(providerId);
    } catch (error) {
      this.publishProviderUnavailable(threadId, providerId, error);
      throw error;
    }
  }

  private publishProviderUnavailable(threadId: string, providerId: ProviderId, error: unknown): void {
    if (!(error instanceof ProviderDisabledError) && !(error instanceof ProviderCliMissingError)) return;
    publishSynthesizedAgentEvents(this.parentTurns, threadId, [{
      type: AgentEventType.ProviderUnavailable,
      threadId,
      providerId,
      reason: error instanceof ProviderDisabledError ? "disabled" : "cli_missing",
      configuredPath: error instanceof ProviderCliMissingError ? error.configuredPath : undefined,
    }]);
  }

  private requireWorkspace(workspaceId: string): Exclude<ReturnType<WorkspaceRepo["findById"]>, null> {
    const workspace = this.workspaces.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace;
  }

  private validateMentions(input: {
    workspaceId: string;
    threadId: string;
    content: string;
    mentions: readonly MessageMention[];
    providerId: ProviderId;
  }): MessageMention[] {
    return validateMessageMentions(this.files, input, input.content, input.mentions);
  }

  private validateCommentMentions(command: SendMessageCommand, workspaceId: string, providerId: ProviderId): MessageMention[] {
    const comments = [
      ...(command.selectedTextComments ?? []),
      ...(command.previewAnnotations?.annotations.filter(isDiffAnnotationPayload) ?? []),
      ...(command.previewAnnotations?.annotations.filter(isFileAnnotationPayload) ?? []),
    ];
    return comments.flatMap((comment) => this.validateMentions({
      workspaceId,
      threadId: command.threadId,
      providerId,
      content: comment.note,
      mentions: comment.mentions ?? [],
    }));
  }

  private async admitAutomaticSetup(
    command: SendMessageCommand,
    thread: Exclude<ReturnType<ThreadRepo["findById"]>, null>,
    mentions: readonly MessageMention[],
    providerId: ProviderId,
  ): Promise<
    | {
      kind: "continue";
      attachments: PersistedAttachmentData | null;
      handledCommandAttachmentCleanup: readonly StoredAttachment[] | null;
    }
    | { kind: "queued" }
  > {
    if (!this.isBlockedAutomaticSetup(command, thread)) {
      const attachments = this.suppliedAttachments(command);
      return {
        kind: "continue",
        attachments,
        handledCommandAttachmentCleanup: command.cleanupPersistedAttachmentsOnHandledCommand
          ? attachments?.stored ?? null
          : null,
      };
    }
    if (command.resendOfSteerId) {
      // A resend is claimed in the transaction that starts its turn. Queued behind Setup it would
      // dispatch later without that claim, so the held steer would never close; it waits client-side instead.
      throw new WorkspaceEnvironmentServiceError("WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
        "Send again can run once Project Setup finishes.");
    }
    const attachments = await this.persistCommandAttachments(command);
    try {
      const admission = await this.environment!.admitAutomaticTurn(this.automaticSubmission(command, thread, providerId, mentions, attachments));
      return admission.queued
        ? { kind: "queued" }
        : {
          kind: "continue",
          attachments,
          handledCommandAttachmentCleanup: ownCopies(attachments),
        };
    } catch (error) {
      await this.attachments.removeStoredAttachments(command.threadId, ownCopies(attachments));
      throw error;
    }
  }

  private isBlockedAutomaticSetup(command: SendMessageCommand, thread: Exclude<ReturnType<ThreadRepo["findById"]>, null>): boolean {
    if (command.setupSkip) {
      this.requireImplementCheckout(command.setupSkip.sourceThreadId, thread);
      return false;
    }
    return isAutomaticSetupThread(thread)
      && this.environment !== undefined
      && !command.persistedUserMessage
      && this.environment.getAutomaticSetup({ threadId: command.threadId }).gate === "blocked";
  }

  private requireImplementCheckout(sourceThreadId: string, thread: PreparedCommand["thread"]): void {
    const source = this.threads.findById(sourceThreadId);
    if (!source || source.deleted_at || !source.worktree_path || !thread.worktree_path
      || thread.worktree_managed || !this.sameWorktreePath(source.worktree_path, thread.worktree_path)) {
      throw new Error("Plan implementation must attach to its source worktree");
    }
  }

  private suppliedAttachments(command: SendMessageCommand): PersistedAttachmentData | null {
    if (!command.persistedAttachmentData) return null;
    return {
      stored: [...command.persistedAttachmentData.stored],
      persisted: [...command.persistedAttachmentData.persisted],
    };
  }

  private async persistCommandAttachments(command: SendMessageCommand): Promise<PersistedAttachmentData> {
    const persisted = await this.attachments.persist(command.threadId, [
      ...(command.attachments ?? []),
      ...this.pageSnapshotAttachments(command),
    ]);
    if (!command.stagedDraftImageIds?.length) return persisted;
    try {
      const drafts = await this.attachments.persistDraftImages(command.threadId, command.stagedDraftImageIds);
      return { stored: [...persisted.stored, ...drafts.stored], persisted: [...persisted.persisted, ...drafts.persisted], reused: drafts.reused };
    } catch (error) {
      await this.attachments.removeStoredAttachments(command.threadId, persisted.stored);
      throw error;
    }
  }

  private pageSnapshotAttachments(command: SendMessageCommand): AttachmentMeta[] {
    if (!command.previewAnnotations) return [];
    const names = new Set((command.attachments ?? []).map((attachment) => attachment.name.toLowerCase()));
    const attachedIds = new Set((command.attachments ?? []).map((attachment) => attachment.id));
    // Staged snapshots persist through persistDraftImages under the same id.
    for (const stagingId of command.stagedDraftImageIds ?? []) attachedIds.add(stagingId);
    return toPreviewAnnotationBundleV2(command.previewAnnotations).pages.filter((page) => !attachedIds.has(page.snapshot.id)).map((page) => {
      const baseName = previewAnnotationPageSnapshotName(page);
      let name = baseName;
      for (let index = 2; names.has(name.toLowerCase()); index += 1) {
        const suffix = ` (${index}).png`;
        name = `${baseName.slice(0, -4).slice(0, 120 - suffix.length)}${suffix}`;
      }
      names.add(name.toLowerCase());
      const { id, mimeType, sizeBytes, sourcePath } = page.snapshot;
      return { id, name, mimeType, sizeBytes, sourcePath };
    });
  }

  private automaticSubmission(
    command: SendMessageCommand,
    thread: Exclude<ReturnType<ThreadRepo["findById"]>, null>,
    provider: ProviderId,
    mentions: readonly MessageMention[],
    attachments: PersistedAttachmentData,
  ) {
    const messageId = command.messageId ?? NodeCrypto.randomUUID();
    return {
      threadId: thread.id,
      messageId,
      content: command.displayContent ?? command.content,
      attachments: [...attachments.stored],
      mentions: [...mentions],
      previewAnnotations: command.previewAnnotations,
      submission: {
        threadId: thread.id,
        messageId,
        content: command.content,
        displayContent: command.displayContent ?? command.content,
        model: command.model ?? "claude-sonnet-4-6",
        permissionMode: command.permissionMode ?? "default",
        attachments: [...attachments.stored],
        persistedAttachments: [...attachments.persisted],
        mentions: [...mentions],
        previewAnnotations: command.previewAnnotations,
        provider,
        reasoningLevel: command.reasoningLevel,
        interactionMode: command.interactionMode,
        orchestrationMode: command.orchestrationMode,
        maxBudgetUsd: command.maxBudgetUsd,
        maxTurns: command.maxTurns,
        contextWindow: command.contextWindow,
        thinking: command.thinking,
        fastMode: command.fastMode,
        goalObjective: command.goalObjective,
        replyToMessageId: command.replyToMessageId,
        quotedText: command.quotedText,
        selectedTextComments: command.selectedTextComments,
        planCommentIds: command.planCommentIds,
        markPlanAnswerForMessageId: command.markPlanAnswerForMessageId,
        planImplement: command.planImplement,
        sourceTurnId: command.sourceTurnId,
        sourceThreadId: command.sourceThreadId,
        sourceProviderId: command.sourceProviderId,
        originSourceTurnId: command.originSourceTurnId,
      },
    };
  }

  private async routeCommand(command: SendMessageCommand, provider: IAgentProvider): Promise<{ kind: "handled" } | { kind: "ready"; content: string; commandEffect: CommandEffectReceipt | null }> {
    const outcome = await this.goals.routeCommand(
      { threadId: command.threadId, content: command.content, provider },
      command.goalObjective,
    );
    if (outcome.kind === "handled") {
      logger.info("Handled mcode-native command", { threadId: command.threadId });
      return { kind: "handled" };
    }
    if (outcome.kind === "rewrite") {
      return {
        kind: "ready",
        content: outcome.content,
        commandEffect: "commandEffect" in outcome ? outcome.commandEffect : null,
      };
    }
    return { kind: "ready", content: command.content, commandEffect: null };
  }

  private reserveCommandEffect(receipt: CommandEffectReceipt | null): void {
    if (receipt) this.goals.reserveCommandEffect(receipt);
  }

  private async cleanupHandledAttachments(
    threadId: string,
    attachments: readonly StoredAttachment[] | null,
  ): Promise<void> {
    if (attachments) await this.attachments.removeStoredAttachments(threadId, [...attachments]);
  }

  private resolveWorkingDirectory(prepared: PreparedCommand): string {
    const cwd = this.worktrees.resolveWorkingDir(prepared.workspace.path, prepared.thread.mode, prepared.thread.worktree_path);
    if (!NodePath.isAbsolute(cwd) || !NodeFS.existsSync(cwd) || !NodeFS.statSync(cwd).isDirectory()) {
      throw new Error(`cwd is not a valid absolute directory: ${cwd}`);
    }
    return cwd;
  }

  private async persistAttachments(prepared: PreparedCommand): Promise<PersistedAttachmentData> {
    if (prepared.command.persistedUserMessage) {
      return {
        stored: [...prepared.command.persistedUserMessage.attachments],
        persisted: [...prepared.command.persistedUserMessage.persistedAttachments],
      };
    }
    return prepared.automaticAttachments ?? this.persistCommandAttachments(prepared.command);
  }

  private async commitParentStart(
    prepared: PreparedCommand,
    lease: TurnRuntimeLease,
    sourceTurnId: string,
    input: DataOnlyParentTurnStartInput,
  ): Promise<void> {
    const precedingMessageId = input.userMessage.messageId;
    if (!precedingMessageId) throw new Error("Worker-owned turn needs its committed user message identity");
    const planFeature = this.planFeature(prepared.plan);
    await this.parentStartOwner.start({
      execution: { threadId: lease.threadId, turnId: sourceTurnId, executionId: lease.turnExecutionId },
      ownerEpoch: lease.generation,
      providerId: prepared.providerId,
      parentTurn: input,
      parentLive: { planFeature, precedingMessageId },
      publishParentStart: true,
    });
    if (input.reopenThread) {
      const reopened = this.threads.findById(lease.threadId);
      if (reopened) broadcast("thread.lifecycleChanged", { thread: reopened });
    }
  }

  private prepareParentTurnStartInput(
    prepared: PreparedCommand,
    lease: TurnRuntimeLease,
    sourceTurnId: string,
    attachments: PersistedAttachmentData,
    review: ApprovalReviewDecision,
  ): DataOnlyParentTurnStartInput {
    const command = prepared.command;
    const userMessage: ParentUserMessageWrite = command.persistedUserMessage
      ? { kind: "existing", messageId: command.persistedUserMessage.id }
      : {
          kind: "create",
          messageId: command.messageId ?? NodeCrypto.randomUUID(),
          content: command.displayContent ?? command.content,
          sequence: this.messages.getLatestSequenceIncludingInternal(command.threadId) + 1,
          attachments: attachments.stored.length > 0 ? [...attachments.stored] : undefined,
          replyToMessageId: command.replyToMessageId,
          quotedText: command.quotedText,
          ...(command.internalUserMessage ? { isInternal: true } : {}),
          mentions: prepared.mentions.length > 0 ? [...prepared.mentions] : undefined,
          previewAnnotations: command.previewAnnotations,
          origin: this.messageOrigin(command),
          selectedTextComments: command.selectedTextComments,
          systemNotice: this.systemNotice(command),
        };
    return {
      thread: {
        id: prepared.thread.id,
        workspaceId: prepared.workspace.id,
        providerId: prepared.providerId,
        createdAt: prepared.thread.created_at,
      },
      turnId: sourceTurnId,
      executionId: lease.turnExecutionId,
      permissionMode: this.effectivePermissionMode(command.permissionMode, prepared.thread.permission_mode ?? "supervised"),
      approvalReviewMode: review.mode,
      approvalReviewReason: review.reason,
      providerIdentities: this.resumeIdentities(prepared),
      retryOfExecutionId: command.retryOfExecutionId,
      ...(command.resendOfSteerId ? { resendOfSteerId: command.resendOfSteerId } : {}),
      userMessage,
      reopenThread: prepared.thread.user_completed_at !== null,
      answeredPlanQuestionMessageId: command.markPlanAnswerForMessageId,
      planImplement: command.planImplement,
      planCommentIds: command.planCommentIds,
    };
  }

  private effectivePermissionMode(requested: PermissionMode | "default" | undefined, persisted: PermissionMode): "full" | "supervised" {
    return requested === "full" || (requested === "default" && persisted === "full") ? "full" : "supervised";
  }

  private systemNotice(command: SendMessageCommand): SystemNoticeMetadata | undefined {
    if (command.providerOriginated) return { kind: "provider-turn", presentation: "timeline" };
    return command.systemNotice;
  }

  private resumeIdentities(prepared: PreparedCommand) {
    const { providerId } = prepared;
    const sessionId = this.storedSessionId(prepared);
    if (!sessionId) return [];
    return [{
      providerId,
      scope: providerId === "codex" ? "thread" as const : "session" as const,
      value: sessionId,
      provenance: "native" as const,
    }];
  }

  private messageOrigin(command: SendMessageCommand) {
    if (!command.sourceThreadId || !command.originSourceTurnId || !command.sourceProviderId) return undefined;
    return {
      type: "thread" as const,
      sourceThreadId: command.sourceThreadId,
      sourceTurnId: command.originSourceTurnId,
      sourceProviderId: command.sourceProviderId,
    };
  }

  private async publishCommittedEffects(prepared: PreparedCommand, sourceTurnId: string): Promise<void> {
    this.publishPlanAnswer(prepared.command);
    if (prepared.providerSwitch) this.armProviderSwitch(prepared, sourceTurnId);
    else await this.persistThreadSettings(prepared);
    await this.plans.admitted(prepared.command.threadId, prepared.plan);
  }

  /** The thread keeps its provider, model and session until the target accepts this turn. */
  private armProviderSwitch(prepared: PreparedCommand, sourceTurnId: string): void {
    const { command, providerSwitch } = prepared;
    if (!providerSwitch) return;
    this.providerSwitch?.arm(providerSwitch, {
      threadId: command.threadId,
      turnId: sourceTurnId,
      settings: { ...this.threadSettings(command, prepared.providerId), model: command.model ?? "claude-sonnet-4-6" },
    });
  }

  private publishPlanAnswer(command: SendMessageCommand): void {
    if (!command.markPlanAnswerForMessageId) return;
    broadcast("plan.answered", { threadId: command.threadId, assistantMessageId: command.markPlanAnswerForMessageId });
  }

  private async persistThreadSettings(prepared: PreparedCommand): Promise<void> {
    const command = prepared.command;
    // A turn the server or provider started carries no composer selection, so it must not overwrite the user's.
    if (command.providerOriginated || command.delegationWake) return;
    const model = command.model ?? "claude-sonnet-4-6";
    await this.threads.updateSettings(command.threadId, {
      ...this.threadSettings(command, prepared.providerId),
      model,
      ...(command.provider === undefined ? {} : { provider: prepared.providerId }),
    });
    broadcast("thread.modelUpdated", {
      threadId: command.threadId,
      model,
      provider: command.provider ?? (prepared.thread.provider as ProviderId) ?? "claude",
    });
  }

  private threadSettings(command: SendMessageCommand, providerId: ProviderId) {
    const settings: Record<string, unknown> = {};
    this.assignSetting(settings, "reasoning_level", command.reasoningLevel);
    this.assignSetting(settings, "interaction_mode", command.interactionMode);
    this.assignSetting(settings, "orchestration_mode", command.orchestrationMode);
    this.assignPermissionSetting(settings, command.permissionMode);
    this.assignSetting(settings, "context_window_mode", command.contextWindow);
    this.assignSetting(settings, "thinking", command.thinking);
    this.assignSetting(settings, "fast_mode", command.fastMode);
    this.assignDevinMode(settings, command.devinMode, providerId);
    return settings;
  }

  private assignSetting(target: Record<string, unknown>, key: string, value: unknown): void {
    if (value !== undefined) target[key] = value;
  }

  private assignPermissionSetting(target: Record<string, unknown>, value: PermissionMode | "default" | undefined): void {
    if (value !== undefined && value !== "default") target.permission_mode = value;
  }

  private assignDevinMode(target: Record<string, unknown>, value: DevinMode | undefined, providerId: ProviderId): void {
    if (providerId === "devin" && value !== undefined) target.devin_mode = value;
  }

  private async buildWirePayload(prepared: PreparedCommand, revertedPaths: readonly string[]): Promise<string> {
    let payload = this.withPlanInstructions(prepared);
    if (prepared.plan.kind === "questions" && prepared.command.providerWireOverride === undefined) {
      payload = this.plans.buildQuestionPrompt(payload);
    }
    if (prepared.command.replyToMessageId && prepared.command.providerWireOverride === undefined) {
      payload = this.withReplyContext(prepared, payload);
    }
    const providerPayload = appendSelectedTextComments(
      prepared.command.providerWireOverride ?? payload,
      prepared.command.selectedTextComments,
    );
    const wirePayload = prepared.providerId === "codex" ? providerPayload : await this.injectMentionFileContents(prepared, providerPayload);
    const withNotice = revertedPaths.length === 0 ? wirePayload
      : `Note from Mcode: the user reverted your earlier changes to: ${revertedPaths.join(", ")} (restored to their state before that turn).\n${wirePayload}`;
    return this.withHandoffPreamble(prepared, withNotice);
  }

  /** Switches and forks carry history inline; the stored user message stays what was typed. */
  private withHandoffPreamble(prepared: PreparedCommand, payload: string): string {
    return `${prepared.providerSwitch?.plan?.handoff.preamble ?? prepared.command.handoffPreamble ?? ""}${payload}`;
  }

  private withPlanInstructions(prepared: PreparedCommand): string {
    if (prepared.plan.kind !== "revise" && prepared.plan.kind !== "planning") return prepared.content;
    let content = prepared.content;
    if (prepared.plan.kind === "revise" && !this.plans.usesNativeQuestions(prepared.command.threadId)) {
      content += `\n\n${this.plans.buildPlanOutputInstructions()}`;
    }
    if (prepared.plan.planFilePath) content += `\n\nMcode plan file: ${prepared.plan.planFilePath}`;
    return content;
  }

  private effectiveInteractionMode(prepared: PreparedCommand): InteractionMode {
    return prepared.plan.kind === "questions" ? "plan" : "build";
  }

  private planFeature(plan: PlanTurnClassification): "questions" | "output" | "none" {
    if (plan.kind === "planning" || plan.kind === "revise") return "output";
    return plan.kind === "questions" ? "questions" : "none";
  }

  private providerPlanTurn(plan: PlanTurnClassification): TurnRequest["planTurn"] {
    return "planFilePath" in plan ? plan : undefined;
  }

  private withReplyContext(prepared: PreparedCommand, payload: string): string {
    const command = prepared.command;
    const target = this.messages.findByIdInThread(command.threadId, command.replyToMessageId!);
    if (!target) return payload;
    const body = command.quotedText ? command.quotedText.slice(0, 2000) : target.content.slice(0, 2000);
    const original = command.quotedText ?? target.content;
    const suffix = body.length < original.length ? "..." : "";
    return `<reply-to role="${target.role}" sequence="${target.sequence}">\n${escapeXml(body)}${suffix}\n</reply-to>\n\n${payload}`;
  }

  private injectMentionFileContents(prepared: PreparedCommand, text: string): Promise<string> {
    return injectMentionFileContents(this.files, { workspaceId: prepared.workspace.id, threadId: prepared.command.threadId },
      [...prepared.mentions, ...prepared.commentMentions], text);
  }

  private async buildTurnRequest(
    prepared: PreparedCommand,
    lease: TurnRuntimeLease,
    sourceTurnId: string,
    attachments: PersistedAttachmentData,
    cwd: string,
    message: string,
    review: ApprovalReviewDecision,
  ): Promise<TurnRequest> {
    const settings = await this.settings.get();
    const model = prepared.command.model ?? "claude-sonnet-4-6";
    const guardrails = this.guardrails(prepared.command, settings);
    const mentions = [...prepared.mentions, ...prepared.commentMentions];
    return {
      sessionId: `mcode-${prepared.command.threadId}`,
      turnExecutionId: lease.turnExecutionId,
      turnId: sourceTurnId,
      deliveryAttempt: 1,
      workspaceId: prepared.workspace.id,
      threadId: prepared.command.threadId,
      message,
      mentions: mentions.length > 0 ? mentions : undefined,
      cwd,
      model,
      fallbackModel: this.fallbackModel(settings, model),
      permissionMode: this.effectivePermissionMode(prepared.command.permissionMode, prepared.thread.permission_mode ?? "supervised"),
      approvalReviewMode: review.mode,
      interactionMode: this.effectiveInteractionMode(prepared),
      planTurn: this.providerPlanTurn(prepared.plan),
      orchestrationMode: prepared.command.orchestrationMode ?? prepared.thread.orchestration_mode ?? "standard",
      attachments: attachments.persisted.length > 0 ? attachments.persisted : undefined,
      reasoningLevel: prepared.command.reasoningLevel,
      ...guardrails,
      resumeFrom: this.resumeFrom(prepared, attachments),
      ...(prepared.command.resumeRequired ? { resumeRequired: true } : {}),
      providerOptions: await this.providerOptions(prepared, settings, model),
    } as TurnRequest;
  }

  private fallbackModel(settings: ReturnType<SettingsService["get"]>, model: string): string | undefined {
    const fallback = settings.model.defaults.fallbackId;
    return fallback && fallback !== model ? fallback : undefined;
  }

  private guardrails(command: SendMessageCommand, settings: ReturnType<SettingsService["get"]>) {
    const maxBudgetUsd = this.effectiveBudget(command, settings);
    const maxTurns = this.effectiveTurns(command, settings);
    return {
      ...(maxBudgetUsd > 0 ? { maxBudgetUsd } : {}),
      ...(maxTurns > 0 ? { maxTurns } : {}),
    };
  }

  private async providerOptions(prepared: PreparedCommand, settings: ReturnType<SettingsService["get"]>, model: string) {
    const options = this.providerSpecificOptions(prepared.providerId, this.providerDefaults(prepared, settings));
    // Adapters treat an absent `fastMode` as standard, so the catalog is consulted only when Fast is on.
    const fastMode = this.fastModeDefault(prepared.command, prepared, settings);
    if (!fastMode || !(await this.modelSupportsFastMode(prepared.providerId, model))) return options;
    return { ...options, fastMode };
  }

  private async modelSupportsFastMode(providerId: ProviderId, modelId: string): Promise<boolean> {
    try {
      const models = await this.models.listModels(providerId);
      return models.some((entry) => entry.id === modelId && entry.supportsFastMode === true);
    } catch (error) {
      logger.warn("Model catalog unavailable; sending the turn without Fast mode", {
        providerId, modelId, error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private providerDefaults(prepared: PreparedCommand, settings: ReturnType<SettingsService["get"]>) {
    const command = prepared.command;
    return {
      contextWindow: this.contextWindowDefault(command, prepared, settings),
      thinking: this.thinkingDefault(command, prepared, settings),
      devinMode: command.devinMode ?? prepared.thread.devin_mode ?? undefined,
    };
  }

  private contextWindowDefault(
    command: SendMessageCommand,
    prepared: PreparedCommand,
    settings: ReturnType<SettingsService["get"]>,
  ): ContextWindowMode {
    return command.contextWindow
      ?? (prepared.thread.context_window_mode as ContextWindowMode | null)
      ?? settings.model.defaults.contextWindow;
  }

  private thinkingDefault(
    command: SendMessageCommand,
    prepared: PreparedCommand,
    settings: ReturnType<SettingsService["get"]>,
  ): boolean {
    return command.thinking ?? prepared.thread.thinking ?? settings.model.defaults.thinking;
  }

  private fastModeDefault(
    command: SendMessageCommand,
    prepared: PreparedCommand,
    settings: ReturnType<SettingsService["get"]>,
  ): boolean {
    // Only Codex has a global Fast default so far; other providers start standard.
    const globalDefault = prepared.providerId === "codex" ? settings.provider?.codex?.fastMode : undefined;
    return command.fastMode ?? prepared.thread.fast_mode ?? globalDefault ?? false;
  }

  private providerSpecificOptions(
    providerId: ProviderId,
    defaults: { contextWindow: ContextWindowMode; thinking: boolean; devinMode: DevinMode | undefined },
  ) {
    if (providerId === "claude") return { contextWindowMode: defaults.contextWindow, thinking: defaults.thinking };
    if (providerId === "devin") return { mode: defaults.devinMode };
    return {};
  }

  private effectiveBudget(command: SendMessageCommand, settings: ReturnType<SettingsService["get"]>): number {
    return command.maxBudgetUsd ?? settings.agent.guardrails.maxBudgetUsd;
  }

  private effectiveTurns(command: SendMessageCommand, settings: ReturnType<SettingsService["get"]>): number {
    return command.maxTurns ?? settings.agent.guardrails.maxTurns;
  }

  private resumeFrom(prepared: PreparedCommand, attachments: PersistedAttachmentData): string | undefined {
    const nextSequence = prepared.command.persistedUserMessage?.sequence
      ?? this.messages.getLatestSequenceIncludingInternal(prepared.command.threadId);
    void attachments;
    return nextSequence > 1 ? this.storedSessionId(prepared) : undefined;
  }

  /** The thread's native session id, or undefined when this turn must not resume it (forced fresh, or another provider owns it). */
  private storedSessionId({ command, thread, providerId, providerSwitch }: PreparedCommand): string | undefined {
    // A switch resumes the target's own session only when its plan kept one; the thread's session belongs to the old provider.
    if (providerSwitch) return providerSwitch.plan?.resumeSessionId ?? undefined;
    if (command.forceFreshSession || providerId !== thread.provider) return undefined;
    return thread.sdk_session_id ?? undefined;
  }

  private threadControlDirective(prepared: PreparedCommand, sourceTurnId: string): ThreadControlLeaseDirective | null {
    if (!supportsInternalThreadControl(prepared.providerId)) return null;
    return {
      sessionId: `mcode-${prepared.command.threadId}`,
      sourceThreadId: prepared.command.threadId,
      sourceTurnId,
      sourceProviderId: prepared.providerId,
      permissionMode: this.effectivePermissionMode(prepared.command.permissionMode, prepared.thread.permission_mode ?? "supervised"),
    };
  }

}

/** Return whether a provider receives the internal thread-control lease. */
export function supportsInternalThreadControl(provider: ProviderId): boolean {
  return provider === "claude" || provider === "codex" || provider === "cursor" || provider === "copilot";
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

