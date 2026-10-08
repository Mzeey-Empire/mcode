import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { inject, injectable } from "tsyringe";
import type {
  ContextWindowMode,
  CreateAndSendInput,
  ApprovalReviewMode,
  DevinMode,
  InteractionMode,
  OrchestrationMode,
  PermissionMode,
  ProviderId,
  ReasoningLevel,
  Thread,
  ThreadStartup,
  ThreadStartupStepDetail,
} from "@mcode/contracts";

import { ThreadService } from "../../thread-control/index.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { GitRepositoryService } from "../../projects/git/git-repository-service.js";
import { ThreadBranchingService, type BranchedThreadLifecycle } from "../../projects/worktrees/thread-branching-service.js";
import { PlanTurnService } from "../planning/plan-turn-service.js";
import { ThreadStartupConflictError, ThreadStartupService } from "../../thread-startup/thread-startup-service.js";
import { DatabaseWriteOutcomeUnknown } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import {
  TURN_ADMISSION_DISPATCH_COORDINATOR,
  type SendMessageCommand,
  TurnAdmissionDispatchCoordinator,
} from "./turn-admission-dispatch-coordinator.js";

const nonterminalStartupStates = new Set(["pending", "running", "blocked"]);

/** Command that provisions a thread and starts its first runtime turn. */
export type CreateAndSendCommand = Omit<
  CreateAndSendInput,
  "model" | "permissionMode" | "provider"
> & {
  model?: string;
  permissionMode?: PermissionMode | "default";
  provider?: ProviderId;
};

/** A newly provisioned thread plus its first admitted runtime command. */
export type CreatedInitialTurn =
  | { readonly kind: "queued"; readonly thread: Thread & { warnings?: string[] }; readonly startupId?: string }
  | { readonly kind: "replay"; readonly thread: Thread; readonly startupId: string }
  | { readonly kind: "dispatch"; readonly thread: Thread & { warnings?: string[] }; readonly command: SendMessageCommand; readonly startupId?: string };

/** Input for a direct or managed-worktree thread provisioned before its first turn. */
export interface CreateThreadForTurnInput {
  workspaceId: string;
  title: string;
  mode: "direct" | "worktree";
  branch: string;
  pullRequestNumber?: number;
  worktreeBranchMode?: "branchless" | "named";
  provider: ProviderId;
  model: string;
  permissionMode: PermissionMode | "default";
  approvalReviewMode?: ApprovalReviewMode;
  reasoningLevel?: ReasoningLevel;
  interactionMode?: InteractionMode;
  orchestrationMode?: OrchestrationMode;
  contextWindowMode?: ContextWindowMode;
  thinking?: boolean;
  codexFastMode?: boolean;
  devinMode?: DevinMode;
}

interface BranchedInitialTurnParams {
  workspaceId: string;
  content: string;
  model: string;
  permissionMode: PermissionMode | "default";
  approvalReviewMode?: ApprovalReviewMode;
  mode: "direct" | "worktree";
  branch: string;
  pullRequestNumber?: number;
  worktreeBranchMode?: "branchless" | "named";
  existingWorktreePath?: string;
  existingWorktreeBaseBranch?: string;
  attachments: SendMessageCommand["attachments"];
  reasoningLevel?: ReasoningLevel;
  provider: ProviderId;
  interactionMode?: InteractionMode;
  parentThreadId: string | undefined;
  forkedFromMessageId?: string;
  title: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  contextWindowMode?: ContextWindowMode;
  thinking?: boolean;
  codexFastMode?: boolean;
  devinMode?: DevinMode;
  displayContent?: string;
  mentions: SendMessageCommand["mentions"];
  previewAnnotations?: SendMessageCommand["previewAnnotations"];
  selectedTextComments?: SendMessageCommand["selectedTextComments"];
  goalObjective?: string;
  orchestrationMode?: OrchestrationMode;
}

class StartupCancelledError extends Error {
  constructor() {
    super("Thread startup was cancelled");
  }
}

/** Owns persistence and worktree provisioning for a thread before first-turn admission. */
@injectable()
export class ThreadCreationCoordinator {
  private readonly inFlightStartups = new Map<string, { fingerprint: string; result: Promise<CreatedInitialTurn> }>();

  constructor(
    @inject(ThreadRepo) private readonly threads: ThreadRepo,
    private readonly threadService: () => ThreadService,
    @inject(TURN_ADMISSION_DISPATCH_COORDINATOR) private readonly admissions: TurnAdmissionDispatchCoordinator,
    private readonly gitRepository: Pick<GitRepositoryService, "fetchBranch">,
    private readonly branching?: () => ThreadBranchingService | undefined,
    private readonly plans: () => PlanTurnService | undefined = () => undefined,
    private readonly startups: () => ThreadStartupService | undefined = () => undefined,
  ) {}

  /** Provision a thread and prepare its first command without acquiring runtime authority. */
  async createInitialTurn(command: CreateAndSendCommand): Promise<CreatedInitialTurn> {
    const params = this.initialTurnParams(command);
    if (!command.startupId) return this.provisionInitialTurn(command, params);

    const fingerprint = NodeCrypto.createHash("sha256").update(JSON.stringify(params)).digest("hex");
    const inFlight = this.inFlightStartups.get(command.startupId);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) throw new ThreadStartupConflictError(command.startupId);
      const created = await inFlight.result;
      return { kind: "replay", thread: created.thread, startupId: command.startupId };
    }
    const result = this.startAndProvisionInitialTurn(command, params, fingerprint);
    this.inFlightStartups.set(command.startupId, { fingerprint, result });
    try {
      return await result;
    } finally {
      this.inFlightStartups.delete(command.startupId);
    }
  }

  private async startAndProvisionInitialTurn(command: CreateAndSendCommand, params: BranchedInitialTurnParams, fingerprint: string): Promise<CreatedInitialTurn> {
    const started = await this.startStartup(command, params, fingerprint);
    return started?.existing ? this.replayStartup(started.startup) : this.provisionInitialTurn(command, params, started?.startup);
  }

  /** Enter the first runtime phase after direct thread provisioning. */
  async startInitialAgent(startupId: string | undefined): Promise<void> {
    if (startupId) await this.startups()?.advance(startupId, "agent");
  }

  /** Complete a startup after its initial command is handled or receives runtime admission. */
  async completeInitialAgent(startupId: string | undefined): Promise<void> {
    if (startupId) await this.startups()?.complete(startupId);
  }

  /** Preserve an initial provider dispatch failure on its current startup phase. */
  async failInitialAgent(startupId: string | undefined): Promise<void> {
    if (startupId) await this.startups()?.fail(startupId, {
      code: "AGENT_START_FAILED",
      message: "Agent startup failed",
      retryable: true,
    });
  }

  /** Advance a released automatic Setup Turn into agent startup. */
  async startQueuedAgent(threadId: string): Promise<string | null | undefined> {
    const startup = this.startups()?.findByThreadId(threadId);
    if (!startup) return undefined;
    if (startup.cancellation === "requested") {
      if (nonterminalStartupStates.has(startup.state)) {
        await this.startups()?.markCancelled(startup.startupId);
      }
      return null;
    }
    if (startup.state !== "running") return undefined;
    if (startup.phase === "setup") {
      await this.startups()?.advance(startup.startupId, "agent");
    }
    return startup.startupId;
  }

  /**
   * Confirm that cancellation has not won before the queued provider turn reserves runtime ownership.
   * A released queued Turn persists user intent, so only cancellation may veto it: when the startup
   * already reached a terminal non-cancelled state, the Turn drains as an ordinary send rather than
   * being dropped after claim.
   */
  canAdmitQueuedAgent(threadId: string, startupId: string | undefined): boolean {
    const startup = this.startups()?.findByThreadId(threadId);
    if (!startup) return startupId === undefined;
    if (startup.cancellation === "requested" || startup.state === "cancelled") {
      return false;
    }
    if (startupId === undefined) return true;
    if (startup.startupId !== startupId) return false;
    return startup.state !== "running" || startup.phase === "agent";
  }

  private initialTurnParams(command: CreateAndSendCommand): BranchedInitialTurnParams {
    const {
      workspaceId,
      content,
      model = "claude-sonnet-4-6",
      permissionMode = "default",
      approvalReviewMode,
      mode = "direct",
      branch = "main",
      pullRequestNumber,
      worktreeBranchMode = "branchless",
      existingWorktreePath,
      existingWorktreeBaseBranch,
      attachments = [],
      reasoningLevel,
      provider = "claude",
      interactionMode,
      parentThreadId,
      forkedFromMessageId,
      maxBudgetUsd,
      maxTurns,

      contextWindow: contextWindowMode,
      thinking,
      codexFastMode,
      devinMode,
      displayContent,
      mentions = [],
      previewAnnotations,
      selectedTextComments,
      goalObjective,
      orchestrationMode,
    } = command;
    const params: BranchedInitialTurnParams = {
      workspaceId, content, model, permissionMode, approvalReviewMode, mode, branch, pullRequestNumber, worktreeBranchMode,
      existingWorktreePath, existingWorktreeBaseBranch, attachments, reasoningLevel,
      provider, interactionMode, parentThreadId, forkedFromMessageId,
      title: titleFrom(displayContent ?? content), maxBudgetUsd, maxTurns,
      contextWindowMode, thinking, codexFastMode, devinMode, displayContent, mentions,
      previewAnnotations, selectedTextComments, goalObjective, orchestrationMode,
    };
    return params;
  }

  private async createStandaloneInitialTurn(
    command: CreateAndSendCommand,
    params: BranchedInitialTurnParams,
    startup?: ThreadStartup,
  ): Promise<CreatedInitialTurn> {
    const creation = {
      workspaceId: params.workspaceId,
      title: params.title,
      mode: params.mode,
      branch: params.branch,
      pullRequestNumber: params.pullRequestNumber,
      worktreeBranchMode: params.worktreeBranchMode,
      provider: params.provider,
      model: params.model,
      permissionMode: params.permissionMode,
      reasoningLevel: params.reasoningLevel,
      interactionMode: params.interactionMode,
      orchestrationMode: params.orchestrationMode,
      contextWindowMode: params.contextWindowMode,
      thinking: params.thinking,
      codexFastMode: params.codexFastMode,
      devinMode: params.devinMode,
    };
    try {
      await this.fetchInitialBranch(params, startup?.startupId);
      const thread = await this.createStandaloneThread(params, creation, startup?.startupId);
      await this.startManagedSetup(startup?.startupId, startup?.kind);
      const automatic = await this.admitInitialTurn(command, params, thread.id);
      return this.initialTurnResult(command, params, thread, automatic, startup?.startupId);
    } catch (error) {
      if (error instanceof StartupCancelledError || error instanceof DatabaseWriteOutcomeUnknown) throw error;
      await this.failStartup(startup?.startupId, error);
      throw error;
    }
  }

  /** Create and configure a thread without starting a provider runtime. */
  async create(input: CreateThreadForTurnInput, startupId?: string): Promise<Thread & { warnings?: string[] }> {
    const startupService = startupId ? this.startups() : undefined;
    const created = input.mode === "worktree"
      ? await this.createManagedThread(input, startupId)
      : startupId && startupService
        ? await startupService.createAndBindThread(startupId, { args: [
          input.workspaceId, input.title, "direct", input.branch, true, input.provider, undefined, undefined, undefined,
        ] })
        : await this.threads.create(input.workspaceId, input.title, "direct", input.branch, true, input.provider);
    return this.configure(created, input);
  }

  private async createStandaloneThread(
    params: BranchedInitialTurnParams,
    creation: CreateThreadForTurnInput,
    startupId: string | undefined,
  ): Promise<Thread & { warnings?: string[] }> {
    if (!params.existingWorktreePath) return await this.create(creation, startupId);
    const attached = await this.admissions.createAttachedExistingWorktreeThread({
      workspaceId: params.workspaceId,
      title: params.title,
      existingWorktreePath: params.existingWorktreePath,
      provider: params.provider,
      baseBranch: params.existingWorktreeBaseBranch,
    });
    const thread = await this.configure(attached, creation);
    if (startupId) {
      await this.startups()?.bindThread(startupId, thread.id);
      await this.startups()?.advance(startupId, "worktree", worktreeDetail(params.existingWorktreePath, "opened"));
    }
    await this.cancelIfRequested(startupId);
    return thread;
  }

  private async startManagedSetup(startupId: string | undefined, kind: string | undefined): Promise<void> {
    if (!startupId || (kind !== "managed-worktree" && kind !== "attached-worktree")) return;
    await this.startups()?.advance(startupId, "setup");
    if (kind === "attached-worktree") {
      await this.startups()?.skip(startupId, "setup", { phase: "setup", skipReason: "not-configured" });
    }
  }

  private async fetchInitialBranch(params: BranchedInitialTurnParams, startupId?: string): Promise<void> {
    if (params.pullRequestNumber === undefined || params.existingWorktreePath) return;
    if (startupId) await this.startups()?.advance(startupId, "fetch");
    await this.gitRepository.fetchBranch(params.workspaceId, params.branch, params.pullRequestNumber);
    await this.cancelIfRequested(startupId);
  }

  private async admitInitialTurn(
    command: CreateAndSendCommand,
    params: BranchedInitialTurnParams,
    threadId: string,
  ) {
    return await this.admissions.admitInitialAutomaticTurn({
      ...command,
      threadId,
      content: params.content,
      permissionMode: params.permissionMode,
      model: params.model,
      attachments: params.attachments,
      provider: params.provider,
      reasoningLevel: params.reasoningLevel,
      interactionMode: params.interactionMode,
      maxBudgetUsd: params.maxBudgetUsd,
      maxTurns: params.maxTurns,
      contextWindow: params.contextWindowMode,
      thinking: params.thinking,
      displayContent: params.displayContent,
      mentions: params.mentions,
      previewAnnotations: params.previewAnnotations,
      selectedTextComments: params.selectedTextComments,
      goalObjective: params.goalObjective,
      orchestrationMode: params.orchestrationMode,
      codexFastMode: params.codexFastMode,
      devinMode: params.devinMode,
    });
  }

  private initialTurnResult(
    command: CreateAndSendCommand,
    params: BranchedInitialTurnParams,
    thread: Thread & { warnings?: string[] },
    automatic: Awaited<ReturnType<TurnAdmissionDispatchCoordinator["admitInitialAutomaticTurn"]>>,
    startupId: string | undefined,
  ): CreatedInitialTurn {
    if (automatic.kind === "queued") return { kind: "queued", thread, ...(startupId ? { startupId } : {}) };
    return {
      kind: "dispatch",
      thread,
      ...(startupId ? { startupId } : {}),
      command: {
        ...command,
        threadId: thread.id,
        content: params.content,
        permissionMode: params.permissionMode,
        approvalReviewMode: params.approvalReviewMode,
        model: params.model,
        attachments: automatic.kind === "ready" ? [] : params.attachments,
        provider: params.provider,
        reasoningLevel: params.reasoningLevel,
        interactionMode: params.interactionMode,
        maxBudgetUsd: params.maxBudgetUsd,
        maxTurns: params.maxTurns,
        contextWindow: params.contextWindowMode,
        thinking: params.thinking,
        displayContent: params.displayContent,
        mentions: params.mentions,
        previewAnnotations: params.previewAnnotations,
        selectedTextComments: params.selectedTextComments,
        goalObjective: params.goalObjective,
        orchestrationMode: params.orchestrationMode,
        devinMode: params.devinMode,
        ...(automatic.kind === "ready" ? {
          persistedAttachmentData: automatic.attachments,
          cleanupPersistedAttachmentsOnHandledCommand: true,
        } : {}),
      },
    };
  }

  private async createManagedThread(
    input: CreateThreadForTurnInput,
    startupId: string | undefined,
  ): Promise<Thread & { warnings?: string[] }> {
    const created = await this.threadService().create(input.workspaceId, input.title, "worktree", input.branch, {
      branchless: input.worktreeBranchMode !== "named",
      provider: input.provider,
      ...this.managedLifecycle(startupId),
    });
    if (startupId && created.worktree_path) {
      await this.startups()?.advance(startupId, "worktree", worktreeDetail(created.worktree_path, "created"));
    }
    if (startupId && this.startups()?.isCancellationRequested(startupId)) {
      await this.threadService().delete(created.id, true);
      await this.startups()?.markCancelled(startupId);
      throw new StartupCancelledError();
    }
    return created;
  }

  private managedLifecycle(startupId: string | undefined): { lifecycle?: { onThreadPersisted(thread: Thread): Promise<void> } } {
    if (!startupId) return {};
    return {
      lifecycle: {
        onThreadPersisted: async (thread) => {
          await this.startups()?.bindThread(startupId, thread.id);
          await this.startups()?.advance(startupId, "worktree", worktreeDetail(thread.worktree_path, "created"));
          await this.cancelIfRequested(startupId);
        },
      },
    };
  }

  private async startStartup(command: CreateAndSendCommand, params: BranchedInitialTurnParams, fingerprint?: string) {
    if (!command.startupId) return undefined;
    const startupService = this.startups();
    if (!startupService) return undefined;
    const existing = startupService.get(command.startupId) !== null;
    const startup = await startupService.start({
      startupId: command.startupId,
      workspaceId: params.workspaceId,
      kind: params.mode === "worktree"
        ? params.existingWorktreePath ? "attached-worktree" : "managed-worktree"
        : "direct",
      fetch: params.pullRequestNumber !== undefined && !params.existingWorktreePath ? {
        ref: `pull/${params.pullRequestNumber}/head`,
        pullRequestNumber: params.pullRequestNumber,
        branch: params.branch,
      } : undefined,
    }, fingerprint);
    if (!existing) {
      await startupService.advance(startup.startupId, "thread");
      await this.cancelIfRequested(startup.startupId);
    }
    return { startup, existing };
  }

  private provisionInitialTurn(
    command: CreateAndSendCommand,
    params: BranchedInitialTurnParams,
    startup?: ThreadStartup,
  ): Promise<CreatedInitialTurn> {
    if (params.parentThreadId) {
      return this.createBranchedInitialTurn(params as BranchedInitialTurnParams & { parentThreadId: string }, startup);
    }
    return this.createStandaloneInitialTurn(command, params, startup);
  }

  private replayStartup(startup: ThreadStartup): CreatedInitialTurn {
    const thread = startup.threadId ? this.threads.findById(startup.threadId) : null;
    if (thread?.deleted_at) throw new Error(`Startup ${startup.startupId} belongs to a deleted thread`);
    if (startup.state === "interrupted") {
      throw new Error(`Startup ${startup.startupId} was interrupted; inspect the workspace before retrying`);
    }
    if (startup.state === "failed" || startup.state === "cancelled") {
      throw new Error(`Startup ${startup.startupId} failed or was cancelled; retry with a new startup ID`);
    }
    if (!thread) {
      throw new Error(`Startup ${startup.startupId} has no available thread yet; wait for its status to settle`);
    }
    return { kind: "replay", thread, startupId: startup.startupId };
  }

  private async cancelIfRequested(startupId: string | undefined): Promise<void> {
    if (!startupId || !this.startups()?.isCancellationRequested(startupId)) return;
    await this.startups()?.markCancelled(startupId);
    throw new StartupCancelledError();
  }

  private async failStartup(startupId: string | undefined, cause: unknown): Promise<void> {
    if (!startupId) return;
    const startup = this.startups()?.get(startupId);
    if (!startup || startup.state === "blocked") return;
    const error = startup.phase === "fetch"
      ? { code: "FETCH_FAILED", message: "Git fetch failed", retryable: true }
      : startup.phase === "thread"
        ? { code: "THREAD_CREATE_FAILED", message: "Thread creation failed", retryable: true }
        : startup.phase === "worktree"
          ? { code: "WORKTREE_PREPARATION_FAILED", message: "Worktree preparation failed", retryable: true }
          : { code: "SETUP_ADMISSION_FAILED", message: "Project Setup admission failed", retryable: true };
    await this.startups()?.fail(startupId, { ...error, detail: startupErrorDetail(cause, startup.phase === "fetch") });
  }

  /** Apply first-turn provider settings to an already-provisioned thread. */
  async configure(
    created: Thread & { warnings?: string[] },
    input: CreateThreadForTurnInput,
  ): Promise<Thread & { warnings?: string[] }> {
    await this.threads.updateModel(created.id, input.model);
    await this.threads.updateSettings(created.id, this.settings(input));
    return this.configuredThread(created, input);
  }

  private configuredThread(
    created: Thread & { warnings?: string[] },
    input: CreateThreadForTurnInput,
  ): Thread & { warnings?: string[] } {
    return {
      ...created,
      provider: input.provider,
      model: input.model,
      ...this.retainedSettings(created, input),
      ...this.fastModeSetting(created, input),
      ...this.warnings(created),
    };
  }

  private retainedSettings(created: Thread, input: CreateThreadForTurnInput) {
    return {
      reasoning_level: input.reasoningLevel ?? created.reasoning_level,
      interaction_mode: input.interactionMode ?? created.interaction_mode,
      orchestration_mode: input.orchestrationMode ?? created.orchestration_mode,
      permission_mode: input.permissionMode === "default" ? created.permission_mode : input.permissionMode,
      context_window_mode: input.contextWindowMode ?? created.context_window_mode,
      thinking: input.thinking ?? created.thinking,
      devin_mode: input.devinMode ?? created.devin_mode,
    };
  }

  private fastModeSetting(created: Thread, input: CreateThreadForTurnInput) {
    return {
      codex_fast_mode: input.provider === "codex" && input.codexFastMode !== undefined
        ? input.codexFastMode
        : created.codex_fast_mode,
    };
  }

  private warnings(created: Thread & { warnings?: string[] }) {
    return created.warnings?.length ? { warnings: created.warnings } : {};
  }

  private coreSettings(input: CreateThreadForTurnInput) {
    return {
      ...(input.reasoningLevel !== undefined && { reasoning_level: input.reasoningLevel }),
      ...(input.interactionMode !== undefined && { interaction_mode: input.interactionMode }),
      ...(input.orchestrationMode !== undefined && { orchestration_mode: input.orchestrationMode }),
      ...(input.permissionMode !== "default" && { permission_mode: input.permissionMode }),
      ...(input.contextWindowMode !== undefined && { context_window_mode: input.contextWindowMode }),
      ...(input.thinking !== undefined && { thinking: input.thinking }),
    };
  }

  private providerScopedSettings(input: CreateThreadForTurnInput) {
    return {
      ...(input.provider === "codex" && input.codexFastMode !== undefined && { codex_fast_mode: input.codexFastMode }),
      ...(input.provider === "devin" && input.devinMode !== undefined && { devin_mode: input.devinMode }),
    };
  }

  private settings(input: CreateThreadForTurnInput) {
    return {
      ...this.coreSettings(input),
      ...this.providerScopedSettings(input),
    };
  }

  private async createBranchedInitialTurn(
    params: BranchedInitialTurnParams & { parentThreadId: string },
    startup?: ThreadStartup,
  ): Promise<CreatedInitialTurn> {
    try {
      return await this.provisionBranchedInitialTurn(params, startup);
    } catch (error) {
      if (error instanceof DatabaseWriteOutcomeUnknown) throw error;
      await this.clearRemovedBranchedThreadBinding(startup);
      if (!(error instanceof StartupCancelledError)) await this.failStartup(startup?.startupId, error);
      throw error;
    }
  }

  private async clearRemovedBranchedThreadBinding(startup: ThreadStartup | undefined): Promise<void> {
    if (!startup) return;
    const boundThreadId = this.startups()?.get(startup.startupId)?.threadId;
    if (!boundThreadId) return;
    const thread = this.threads.findById(boundThreadId);
    if (!thread || thread.deleted_at) await this.startups()?.clearThreadBinding(startup.startupId);
  }

  private async provisionBranchedInitialTurn(
    params: BranchedInitialTurnParams & { parentThreadId: string },
    startup?: ThreadStartup,
  ): Promise<CreatedInitialTurn> {
    const branching = this.branching?.();
    if (!branching) throw new Error("Thread branching is not configured");
    await this.fetchInitialBranch(params, startup?.startupId);
    const provisioned = await branching.create({
      workspaceId: params.workspaceId,
      content: params.content,
      model: params.model,
      permissionMode: params.permissionMode,
      mode: params.mode,
      branch: params.branch,
      worktreeBranchMode: params.worktreeBranchMode,
      existingWorktreePath: params.existingWorktreePath,
      existingWorktreeBaseBranch: params.existingWorktreeBaseBranch,
      reasoningLevel: params.reasoningLevel,
      provider: params.provider,
      interactionMode: params.interactionMode,
      parentThreadId: params.parentThreadId,
      forkedFromMessageId: params.forkedFromMessageId,
      title: params.title,
      contextWindowMode: params.contextWindowMode,
      thinking: params.thinking,
      codexFastMode: params.codexFastMode,
      devinMode: params.devinMode,
      orchestrationMode: params.orchestrationMode,
    }, this.branchedLifecycle(startup));
    await this.finishBranchedStartup(startup, provisioned.thread);
    const providerWireOverride = params.interactionMode === "plan"
      ? this.plans()?.buildQuestionPrompt(provisioned.providerWireOverride) ?? provisioned.providerWireOverride
      : provisioned.providerWireOverride;
    return {
      kind: "dispatch",
      ...(startup ? { startupId: startup.startupId } : {}),
      thread: {
        ...provisioned.thread,
        ...(provisioned.warnings?.length ? { warnings: provisioned.warnings } : {}),
      },
      command: {
        threadId: provisioned.thread.id,
        content: params.content,
        permissionMode: params.permissionMode,
        approvalReviewMode: params.approvalReviewMode,
        model: params.model,
        attachments: params.attachments,
        reasoningLevel: params.reasoningLevel,
        provider: params.provider,
        interactionMode: params.interactionMode,
        maxBudgetUsd: params.maxBudgetUsd,
        maxTurns: params.maxTurns,
        contextWindow: provisioned.contextWindowMode,
        thinking: provisioned.thinking,
        codexFastMode: provisioned.codexFastMode,
        devinMode: provisioned.devinMode,
        providerWireOverride,
        displayContent: params.displayContent,
        mentions: params.mentions,
        previewAnnotations: params.previewAnnotations,
        selectedTextComments: params.selectedTextComments,
        goalObjective: params.goalObjective,
        orchestrationMode: params.orchestrationMode,
      },
    };
  }

  private branchedLifecycle(startup: ThreadStartup | undefined): BranchedThreadLifecycle | undefined {
    if (!startup) return undefined;
    const startupService = this.startups();
    if (!startupService) throw new Error(`Startup ${startup.startupId} has no lifecycle service`);
    return {
      createAndBindDirectThread: async (input) => {
        await this.cancelIfRequested(startup.startupId);
        const thread = await startupService.createAndBindThread(startup.startupId, input);
        if (startup.kind === "attached-worktree") {
          await startupService.advance(startup.startupId, "worktree", worktreeDetail(thread.worktree_path, "opened"));
        }
        return thread;
      },
      onManagedThreadPersisted: async (thread) => {
        await this.cancelIfRequested(startup.startupId);
        await startupService.bindThread(startup.startupId, thread.id);
        await startupService.advance(startup.startupId, "worktree", worktreeDetail(thread.worktree_path, "created"));
      },
    };
  }

  private async finishBranchedStartup(startup: ThreadStartup | undefined, thread: Thread): Promise<void> {
    if (!startup) return;
    if (startup.kind === "managed-worktree" && thread.worktree_path) {
      await this.startups()?.advance(startup.startupId, "worktree", worktreeDetail(thread.worktree_path, "created"));
    }
    if (startup.kind === "managed-worktree" || startup.kind === "attached-worktree") {
      await this.startups()?.advance(startup.startupId, "setup");
      await this.startups()?.skip(startup.startupId, "setup", { phase: "setup", skipReason: "not-configured" });
    }
    await this.cancelIfRequested(startup.startupId);
  }
}

function worktreeDetail(path: string | null | undefined, mode: "created" | "opened"): ThreadStartupStepDetail | undefined {
  return path ? { phase: "worktree", mode, folderName: NodePath.basename(path), path } : undefined;
}

function startupErrorDetail(error: unknown, fetch: boolean): string | undefined {
  // execFile's message starts with the command; stderr contains Git's actual cause.
  const stderr = fetch && error instanceof Error && "stderr" in error && typeof error.stderr === "string"
    ? error.stderr : undefined;
  const message = stderr?.trim() ? stderr : error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 2_000);
}

function titleFrom(content: string): string {
  const firstLine = content.split("\n")[0].trim();
  if (firstLine.length <= 50) return firstLine || "New Thread";
  const truncated = firstLine.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(" ");
  const cutPoint = lastSpace > 0 ? lastSpace : 50;
  return truncated.slice(0, cutPoint) + "...";
}
