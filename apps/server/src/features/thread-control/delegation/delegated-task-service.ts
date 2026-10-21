import * as NodeCrypto from "node:crypto";
import {
  DelegateTaskInputSchema, TaskStatusInputSchema, TaskCancelInputSchema, ProviderIdSchema,
  type DelegateTaskInput, type DelegateTaskResult, type TaskStatusInput, type TaskStatusResult,
  type TaskCancelInput, type TaskCancelResult, type ThreadControlError, type TaskState, type Thread,
  type SubagentRosterEntry, type SubagentStatus,
} from "@mcode/contracts";
import type { InternalThreadControlAuthority } from "@mcode/thread-orchestration";
import type { ThreadRepo } from "../persistence/thread-repo.js";
import type { ThreadControlService } from "../authority/thread-control-service.js";
import type { ThreadControlApprovalRepo } from "../authority/persistence/thread-control-approval-repo.js";
import type { ThreadStartupService } from "../../thread-startup/thread-startup-service.js";
import { cancelThreadStartup, type CancelThreadStartupDeps } from "../../thread-startup/cancel-thread-startup.js";
import type { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import type { CanonicalAgentBoundary } from "../../agents/canonical/canonical-agent-boundary.js";
import type { DelegationTargetResolver } from "../../agents/collaboration/delegation-target-resolver.js";
import type { ApprovalService } from "../../agents/approvals/approval-service.js";
import type { CreateAndSendCommand, CreateAndSendOptions } from "../../agents/turns/thread-creation-coordinator.js";
import type { DelegatedTaskRepo } from "./delegated-task-repo.js";
import type { DelegatedTask, DelegatedTaskPlan } from "./delegated-task-store.js";
import { deriveTaskState } from "./task-state.js";

/** Existing owners used by delegation; the control reference is delayed at composition. */
export interface DelegatedTaskDeps {
  tasks: DelegatedTaskRepo;
  threads: Pick<ThreadRepo, "findById">;
  startups: Pick<ThreadStartupService, "get">;
  approvals: ThreadControlApprovalRepo;
  canonical: Pick<CanonicalAgentBoundary, "loadTurn" | "loadTerminalProjection">;
  targets: Pick<DelegationTargetResolver, "resolve">;
  git: Pick<GitWorktreeService, "resolveHeadCommit">;
  control: Pick<ThreadControlService, "threadStop" | "publishThreadApproval" | "cancelDelegationApproval">;
  approvalService: Pick<ApprovalService, "listPendingApprovals">;
  cancellation: CancelThreadStartupDeps;
  commands: { createAndSend(command: CreateAndSendCommand, options: CreateAndSendOptions): Promise<Pick<Thread, "id">> };
}

type TaskRejection = { status: "rejected"; error: ThreadControlError };

/** Owns durable delegation admission while startup, turn and approval owners retain lifecycle state. */
export class DelegatedTaskService {
  private readonly launching = new Map<string, Promise<void>>();
  private readonly rosterListeners = new Set<(coordinatorThreadId: string) => void>();

  constructor(private readonly deps: DelegatedTaskDeps) {}

  /** Observe task changes using the roster's existing debounced publisher. */
  onRosterChanged(listener: (coordinatorThreadId: string) => void): () => void {
    this.rosterListeners.add(listener);
    return () => { this.rosterListeners.delete(listener); };
  }

  /** Refresh task projections after a committed startup or approval transition. */
  taskChanged(taskId: string): void {
    const task = this.deps.tasks.get(taskId);
    if (task) this.notifyRoster(task.coordinatorThreadId);
  }

  private notifyRoster(coordinatorThreadId: string): void {
    for (const listener of this.rosterListeners) listener(coordinatorThreadId);
  }

  /** Project the same original task state used by task_status. */
  rosterEntries(coordinatorThreadId: string): SubagentRosterEntry[] {
    const callsByTurn = new Map<string, ReturnType<DelegatedTaskRepo["sourceCalls"]>>();
    return this.deps.tasks.listByCoordinator(coordinatorThreadId).map((task) => {
      let calls = callsByTurn.get(task.plan.creatorTurnId);
      if (!calls) {
        calls = this.deps.tasks.sourceCalls(coordinatorThreadId, task.plan.creatorTurnId);
        callsByTurn.set(task.plan.creatorTurnId, calls);
      }
      const call = calls.find((source) => source.clientRequestId === task.clientRequestId);
      const snapshot = this.snapshot(task);
      const status = rosterStatus(snapshot.state);
      return {
        id: `task:${task.taskId}`, provider: task.plan.providerId, model: task.plan.modelId,
        title: task.plan.title, prompt: task.plan.prompt, subagentType: null, reasoningEffort: null, stepCount: 0,
        status, startedAt: new Date(task.createdAt).toISOString(),
        endedAt: this.deps.canonical.loadTurn(task.taskId)?.endedAt ?? null,
        tier: snapshot.threadId ? "transcript" : "meta", canStop: status === "running",
        childThreadId: snapshot.threadId ?? null, sourceToolCallId: call?.id ?? null,
        sourceMessageId: call?.messageId ?? null, parentEntryId: null,
      };
    });
  }

  /** Claim or replay a pinned task without repeating launch side effects. */
  async delegate(authority: InternalThreadControlAuthority, input: DelegateTaskInput): Promise<DelegateTaskResult> {
    const parsed = DelegateTaskInputSchema().parse(input);
    const fingerprint = NodeCrypto.createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
    const existing = this.deps.tasks.findByRequest(authority.sourceThreadId, parsed.clientRequestId);
    if (existing) return this.replay(existing, fingerprint);
    if (authority.permissionMode === "supervised" && parsed.permissionMode === "full") {
      return rejection("forbidden", "A delegated task cannot exceed its Coordinator's permission mode");
    }
    const plan = await this.preparePlan(authority, parsed);
    if ("status" in plan) return plan;
    const claimed = await this.deps.tasks.claim({
      coordinatorThreadId: authority.sourceThreadId, clientRequestId: parsed.clientRequestId,
      inputFingerprint: fingerprint, plan,
    });
    if (claimed.kind === "conflict") return rejection("conflict", "clientRequestId already names a different task");
    this.notifyRoster(claimed.task.coordinatorThreadId);
    await this.advance(claimed.task);
    return this.receipt(claimed.task);
  }

  /** Read the task's original canonical turn, including resumable Interrupted outcomes. */
  async status(authority: InternalThreadControlAuthority, input: TaskStatusInput): Promise<TaskStatusResult> {
    const { taskId } = TaskStatusInputSchema().parse(input);
    const task = this.deps.tasks.find(taskId, authority.sourceThreadId);
    if (!task) return notFound();
    return this.snapshot(task);
  }

  /** Cancel pending admission or use the existing stop authority for a bound child. */
  async cancel(authority: InternalThreadControlAuthority, input: TaskCancelInput): Promise<TaskCancelResult> {
    const { taskId } = TaskCancelInputSchema().parse(input);
    const task = this.deps.tasks.find(taskId, authority.sourceThreadId);
    if (!task) return notFound();
    return this.cancelTask(task, (threadId) => this.deps.control.threadStop(authority, { threadId }));
  }

  /** Stop an owned delegated child with authenticated user authority. */
  async stopForUser(coordinatorThreadId: string, childThreadId: string): Promise<boolean> {
    const task = this.deps.tasks.listByCoordinator(coordinatorThreadId)
      .find((candidate) => this.deps.startups.get(candidate.taskId)?.threadId === childThreadId);
    if (!task) return false;
    await this.cancelTask(task, async (threadId) => {
      const startup = this.deps.startups.get(task.taskId);
      const turn = this.deps.canonical.loadTurn(task.taskId);
      if (!turn && startup && ["pending", "running", "blocked"].includes(startup.state)) {
        await cancelThreadStartup(this.deps.cancellation, task.taskId);
      } else {
        await this.deps.cancellation.agentService.stopSession(threadId, { by: "user" });
      }
      return { status: "stopped" };
    });
    return true;
  }

  private async cancelTask(task: DelegatedTask, stop: (threadId: string) => Promise<
    { status: "stopped" } | Awaited<ReturnType<ThreadControlService["threadStop"]>>
  >): Promise<TaskCancelResult> {
    try {
      const taskId = task.taskId;
      const current = this.snapshot(task);
      if (current.state.status === "finished") return { taskId, state: current.state };
      if (this.deps.approvals.status(taskId) === "pending") {
        await this.deps.control.cancelDelegationApproval(taskId);
        return { taskId, state: this.snapshot(task).state };
      }
      const startup = this.deps.startups.get(taskId);
      if (!startup?.threadId) {
        if (startup) await cancelThreadStartup(this.deps.cancellation, taskId);
        return { taskId, state: this.snapshot(task).state };
      }
      const stopped = await stop(startup.threadId);
      if (stopped.status === "rejected") return { status: "rejected", error: stopped.error };
      return { taskId, state: this.snapshot(task).state,
        ...(stopped.status === "pending_approval" ? { stopApprovalId: stopped.approvalId } : {}) };
    } finally {
      this.notifyRoster(task.coordinatorThreadId);
    }
  }

  /** Resume a human-approved task from its persisted plan, including crash recovery. */
  async launch(taskId: string): Promise<void> {
    const task = this.deps.tasks.get(taskId);
    if (!task) throw new Error("Delegated task receipt was not found");
    await this.advance(task, true);
  }

  private async replay(task: DelegatedTask, fingerprint: string): Promise<DelegateTaskResult> {
    if (task.inputFingerprint !== fingerprint) return rejection("conflict", "clientRequestId already names a different task");
    await this.advance(task);
    return this.receipt(task);
  }

  private async preparePlan(authority: InternalThreadControlAuthority, input: DelegateTaskInput): Promise<DelegatedTaskPlan | TaskRejection> {
    const source = this.deps.threads.findById(authority.sourceThreadId);
    if (!source || source.deleted_at) return notFound();
    if (input.isolation === "shared" && source.mode === "worktree" && !source.worktree_path) {
      return rejection("invalid_placement", "The Coordinator's worktree is unavailable");
    }
    const target = await this.deps.targets.resolve(input);
    if (target.status !== "resolved") {
      if (target.status === "discovery_failed") return rejection("internal_error", "Provider target discovery failed", true);
      return rejection(target.status === "invalid_provider" ? "invalid_provider" : "invalid_model", "The requested provider and model are unavailable");
    }
    return {
      workspaceId: source.workspace_id, title: input.title, prompt: input.prompt,
      providerId: target.providerId, modelId: target.modelId,
      permissionMode: input.permissionMode ?? authority.permissionMode, coordinatorPermissionMode: authority.permissionMode,
      checkout: await this.checkout(source, input.isolation), messageId: NodeCrypto.randomUUID(),
      creatorTurnId: authority.sourceTurnId, creatorToolCallId: authority.sourceToolCallId,
      creatorProviderId: ProviderIdSchema.parse(authority.sourceProviderId), userId: authority.userId,
    };
  }

  private async checkout(source: Thread, isolation: DelegateTaskInput["isolation"]): Promise<DelegatedTaskPlan["checkout"]> {
    if (isolation === "worktree") return {
      kind: "new_worktree", baseBranch: source.base_branch ?? source.branch,
      commit: await this.deps.git.resolveHeadCommit(source.workspace_id, source.mode, source.worktree_path),
    };
    if (source.mode === "worktree" && source.worktree_path) return { kind: "attached", path: source.worktree_path, baseBranch: source.base_branch ?? source.branch };
    return { kind: "direct", branch: source.branch };
  }

  private async advance(task: DelegatedTask, accepted = false): Promise<void> {
    const inFlight = this.launching.get(task.taskId);
    if (inFlight) {
      await inFlight;
      return;
    }
    if (this.deps.startups.get(task.taskId)) {
      return;
    }
    const launch = this.advanceUnstarted(task, accepted);
    this.launching.set(task.taskId, launch);
    try {
      await launch;
    } finally {
      this.launching.delete(task.taskId);
      this.notifyRoster(task.coordinatorThreadId);
    }
  }

  private async advanceUnstarted(task: DelegatedTask, accepted: boolean): Promise<void> {
    const plan = task.plan;
    if (plan.checkout.kind === "new_worktree" && plan.coordinatorPermissionMode === "supervised") {
      let approval = this.deps.approvals.status(task.taskId);
      if (!approval) {
        await this.deps.approvals.createDelegate({
          approvalId: task.taskId, threadId: task.coordinatorThreadId, sourceThreadId: task.coordinatorThreadId,
          workspaceId: plan.workspaceId, callerId: plan.userId, turnId: plan.creatorTurnId,
          execution: { providerId: plan.providerId, modelId: plan.modelId, permissionMode: plan.permissionMode, interactionMode: "build" },
          subject: { kind: "delegate_task", taskId: task.taskId, title: plan.title, providerId: plan.providerId,
            modelId: plan.modelId, isolation: "worktree", commit: plan.checkout.commit.slice(0, 12) },
        });
        this.deps.control.publishThreadApproval(task.taskId);
        approval = this.deps.approvals.status(task.taskId);
      }
      if (approval !== "approved" && !(accepted && approval === "processing")) return;
    }
    await this.deps.commands.createAndSend(this.command(task), this.options(task));
  }

  private command(task: DelegatedTask): CreateAndSendCommand {
    const { plan } = task;
    const checkout = plan.checkout;
    const command: CreateAndSendCommand = {
      workspaceId: plan.workspaceId, startupId: task.taskId, title: plan.title, content: plan.prompt,
      provider: plan.providerId, model: plan.modelId, permissionMode: plan.permissionMode, interactionMode: "build", attachments: [],
    };
    switch (checkout.kind) {
      case "direct":
        return { ...command, mode: "direct", branch: checkout.branch };
      case "attached":
        return { ...command, mode: "worktree", branch: checkout.baseBranch,
          existingWorktreeBaseBranch: checkout.baseBranch, existingWorktreePath: checkout.path };
      case "new_worktree":
        return { ...command, mode: "worktree", branch: checkout.baseBranch,
          existingWorktreeBaseBranch: checkout.baseBranch, worktreeBranchMode: "branchless" };
    }
  }

  private options(task: DelegatedTask): CreateAndSendOptions {
    return {
      messageId: task.plan.messageId,
      lineage: { delegation: {
        coordinatorThreadId: task.coordinatorThreadId, creatorTurnId: task.plan.creatorTurnId,
        creatorToolCallId: task.plan.creatorToolCallId,
      } },
      turn: { sourceTurnId: task.taskId, sourceThreadId: task.coordinatorThreadId,
        sourceProviderId: task.plan.creatorProviderId, originSourceTurnId: task.plan.creatorTurnId },
      ...(task.plan.checkout.kind === "new_worktree" ? { worktreeStart: { commit: task.plan.checkout.commit } } : {}),
      ...(task.plan.checkout.kind === "attached" ? { setupSkip: { reason: "delegation", sourceThreadId: task.coordinatorThreadId } } : {}),
    };
  }

  private receipt(task: DelegatedTask): Exclude<DelegateTaskResult, TaskRejection> {
    return { ...this.snapshot(task), effectivePermissionMode: task.plan.permissionMode };
  }

  private snapshot(task: DelegatedTask): { taskId: string; threadId?: string; state: TaskState } {
    const startup = this.deps.startups.get(task.taskId);
    const turn = this.deps.canonical.loadTurn(task.taskId);
    const threadId = startup?.threadId;
    const ending = turn?.ending;
    const state = deriveTaskState({
      turn, startup, approval: this.deps.approvals.status(task.taskId), launching: this.launching.has(task.taskId),
      summary: turn?.status === "Completed" ? this.deps.canonical.loadTerminalProjection(task.taskId).message?.content : undefined,
      error: ending?.outcome === "errored" ? ending.failure.message : undefined,
      needsInput: this.needsInput(threadId),
    });
    return { taskId: task.taskId, ...(threadId ? { threadId } : {}), state };
  }

  private needsInput(threadId: string | undefined): boolean {
    if (!threadId) return false;
    return this.deps.approvals.listPendingByThread(threadId).length > 0
      || this.deps.approvalService.listPendingApprovals(threadId).length > 0;
  }
}

function rejection(code: ThreadControlError["code"], message: string, retryable = false): TaskRejection {
  return { status: "rejected", error: { code, message, retryable } };
}

function notFound(): TaskRejection { return rejection("not_found", "Task not found"); }

function rosterStatus(state: TaskState): SubagentStatus {
  if (state.status !== "finished") return "running";
  switch (state.outcome) {
    case "completed": return "done";
    case "failed": return "failed";
    case "cancelled":
    case "interrupted":
    case "denied": return "stopped";
  }
}
