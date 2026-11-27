import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type { ThreadMoveInput, ThreadMoveResult } from "@mcode/contracts/ws/methods";
import type { Workspace } from "@mcode/contracts/models/workspace";
import { logger } from "@mcode/shared";
import { broadcast } from "../../../application/transport/push.js";
import { DatabaseWriteOutcomeUnknown } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { isSQLiteBusyError } from "../../../runtime/persistence/sqlite/ledger-guard.js";
import type { BackgroundCommandStore } from "../../agents/background/background-command-store.js";
import type { TurnRuntimeController } from "../../agents/orchestration/turn-runtime-controller.js";
import type { AgentWorkload } from "../../agents/workload/agent-workload.js";
import type { WorkspaceEnvironmentService } from "../../projects/environment/workspace-environment-service.js";
import type { GitRepositoryService } from "../../projects/git/git-repository-service.js";
import type { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import { getManagedWorktreeBaseDir } from "../../projects/git/managed-worktree-paths.js";
import type { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import type { ThreadBranchingService } from "../../projects/worktrees/thread-branching-service.js";
import type { ThreadStartupService } from "../../thread-startup/thread-startup-service.js";
import type { ThreadControlMutationReservationService } from "../authority/thread-control-mutation-reservation-service.js";
import { resolveWorktreeStartCommit } from "../launch/thread-launch-service.js";
import type { ThreadRepo } from "../persistence/thread-repo.js";
import { isOpenNoProjectThread, type ThreadMoveWorktree } from "../persistence/thread-store.js";
import type { ThreadMovePlacement } from "../persistence/thread-write-operations.js";

type NewWorktreeSource = Extract<ThreadMoveInput["target"], { kind: "new-worktree" }>["source"];
type NewWorktreePlacement = Extract<ThreadMovePlacement, { kind: "new-worktree" }>;
type WorktreeRecord = Pick<ThreadMoveWorktree, "id" | "threadId" | "worktreePath" | "branch" | "detachedCommit" | "pathClaimed" | "state">;
type CommittedMove = Extract<Awaited<ReturnType<ThreadRepo["moveToProject"]>>, { status: "moved" }>;

/** Coordinates a move with the same reservation that guards turn admission. */
export class ThreadMoveService {
  constructor(
    private readonly threads: ThreadRepo,
    private readonly workspaces: WorkspaceRepo,
    private readonly reservations: ThreadControlMutationReservationService,
    private readonly git: Pick<GitRepositoryService, "getCurrentBranchAt" | "fetchBranch" | "resolveLocalBranchCommit" | "fetchOriginTrackingBranch">,
    private readonly branching: Pick<ThreadBranchingService, "resolveExistingWorktree">,
    private readonly runtime: Pick<TurnRuntimeController, "evictThreadProviderSessions">,
    private readonly backgroundCommands: Pick<BackgroundCommandStore, "list">,
    private readonly agentWorkload: Pick<AgentWorkload, "backgroundSubagentThreadIds">,
    private readonly newWorktrees: {
      checkouts: Pick<GitWorktreeService, "createWorktree" | "unlockWorktree" | "removeProvisionedWorktree">;
      startups: Pick<ThreadStartupService, "publish">;
      setup: Pick<WorkspaceEnvironmentService, "launchAutomaticSetup">;
    },
    private readonly now = () => new Date(),
  ) {}

  /** Move one open No project thread and publish its new placement after commit. */
  async moveToProject(input: ThreadMoveInput): Promise<ThreadMoveResult> {
    const { threadId } = input;
    const token = this.reservations.reserve(threadId, "moving");
    if (!token) {
      const holder = this.reservations.get(threadId)?.state;
      return { status: "busy", reason: holder === "pendingApproval" ? "needs-approval" : "running" };
    }
    try {
      return await this.moveReservedThread(input);
    } catch (error) {
      if (error instanceof DatabaseWriteOutcomeUnknown) return { status: "unconfirmed", error: error.message };
      return {
        status: "failed",
        cause: isSQLiteBusyError(error) ? "database-busy" : "other",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.reservations.release(threadId, token);
    }
  }

  /** Clean up unbound checkouts from interrupted moves before admitting turns. */
  async recoverInterruptedMoves(): Promise<void> {
    for (const move of this.threads.listProvisioningMoveWorktrees()) {
      await this.cleanupProvisioning(move, this.workspaces.findById(move.workspaceId)?.path);
    }
  }

  private async moveReservedThread({ threadId, workspaceId, target }: ThreadMoveInput): Promise<ThreadMoveResult> {
    const thread = this.threads.findById(threadId);
    if (!isOpenNoProjectThread(thread, thread && this.workspaces.findById(thread.workspace_id))) {
      return { status: "not-no-project" };
    }
    const project = this.workspaces.findById(workspaceId);
    if (project?.kind !== "project") return { status: "destination-missing" };
    const placement = target.kind === "new-worktree" ? target : await this.resolvePlacement(project, target);
    if (this.backgroundCommands.list(threadId, { running: true }).length > 0
      || this.agentWorkload.backgroundSubagentThreadIds().has(threadId)) {
      return { status: "busy", reason: "background" };
    }
    await this.runtime.evictThreadProviderSessions(threadId);
    const result = placement.kind === "new-worktree"
      ? await this.moveToNewWorktree(threadId, project, placement.source)
      : await this.commitMove(threadId, project, placement);
    if (result.status !== "moved") return result;
    this.publishMove(result);
    return { status: "moved", thread: result.thread };
  }

  private publishMove({ thread, marker, startup }: CommittedMove): void {
    broadcast("thread.movedToProject", { threadId: thread.id, thread, marker });
    if (startup) {
      this.newWorktrees.startups.publish(startup);
      this.newWorktrees.setup.launchAutomaticSetup(thread);
    }
  }

  private async commitMove(threadId: string, project: Workspace, placement: ThreadMovePlacement) {
    const now = this.now().toISOString();
    try {
      return await this.threads.moveToProject(threadId, project, placement, now);
    } catch (error) {
      if (!(error instanceof DatabaseWriteOutcomeUnknown)) throw error;
      try {
        const committed = this.threads.findCommittedProjectMove(threadId, project.id, placement, now);
        if (committed) return committed;
      } catch (readError) {
        logger.warn("Could not confirm the committed thread move", { threadId, error: String(readError) });
      }
      throw error;
    }
  }

  private async moveToNewWorktree(threadId: string, project: Workspace, source: NewWorktreeSource) {
    if (!project.is_git_repo) throw new Error("The destination project has no Git repository");
    const moveId = NodeCrypto.randomUUID();
    const name = `move-${moveId}`;
    const worktreePath = NodePath.join(getManagedWorktreeBaseDir(project.path), name);
    const startPoint = await this.resolveNewWorktreeCommit(project, source);
    const { branch, detachedCommit, options } = source.kind === "branch"
      ? { branch: source.baseBranch, detachedCommit: startPoint, options: { branchless: true, startPoint } }
      : { branch: source.branch, detachedCommit: null, options: { baseRef: startPoint } };
    const plan = { id: moveId, threadId, workspaceId: project.id, worktreePath, branch, detachedCommit };
    await this.threads.recordMoveWorktree({ ...plan, createdAt: this.now().toISOString() });
    const move: WorktreeRecord = { ...plan, pathClaimed: false, state: "provisioning" };
    try {
      await this.newWorktrees.checkouts.createWorktree(project.path, name, branch, {
        ...options,
        moveId,
        onPathClaimed: async () => {
          move.pathClaimed = true;
          await this.threads.markMoveWorktreePathClaimed(moveId, this.now().toISOString());
        },
      });
      await this.threads.markMoveWorktreeCreated(moveId, this.now().toISOString());
      move.state = "checkout-created";
      await this.newWorktrees.checkouts.unlockWorktree(project.path, worktreePath);
      const placement: NewWorktreePlacement = {
        kind: "new-worktree", moveId, branch, worktreePath,
        source: source.kind === "pr"
          ? { kind: source.kind, pullRequestNumber: source.pullRequestNumber }
          : { kind: source.kind, branch: source.baseBranch, startFromOrigin: source.startFromOrigin },
      };
      const result = await this.commitMove(threadId, project, placement);
      if (result.status === "moved") return result;
      await this.cleanupProvisioning(move, project.path);
      if (result.status === "failed") return result;
      return {
        status: "failed" as const,
        cause: "other" as const,
        error: result.status === "destination-missing"
          ? "The destination project was removed while the move was preparing."
          : "The thread is no longer an open No project thread.",
      };
    } catch (error) {
      // The writer may have committed the binding before losing its reply.
      if (!(error instanceof DatabaseWriteOutcomeUnknown)) await this.cleanupProvisioning(move, project.path);
      throw error;
    }
  }

  private async resolveNewWorktreeCommit(project: Workspace, source: NewWorktreeSource): Promise<string> {
    if (source.kind === "pr") {
      await this.git.fetchBranch(project.id, source.branch, source.pullRequestNumber);
    }
    const branch = source.kind === "pr" ? source.branch : source.baseBranch;
    const commit = await resolveWorktreeStartCommit(this.git, project.path, {
      baseRef: branch, startFromOrigin: source.kind === "branch" && source.startFromOrigin,
    });
    if (!commit) throw new Error(`No local branch ${branch}`);
    return commit;
  }

  private async cleanupProvisioning(move: WorktreeRecord, repoPath: string | undefined): Promise<void> {
    try {
      if (this.threads.findById(move.threadId)?.worktree_path === move.worktreePath) return;
      if (this.threads.hasOtherThreadAtWorktree(move.threadId, move.worktreePath)) {
        logger.warn("Interrupted move left a worktree used by another thread untouched", {
          moveId: move.id, worktreePath: move.worktreePath,
        });
        await this.threads.deleteProvisioningMoveWorktree(move.id);
        return;
      }
      const outcome = await this.newWorktrees.checkouts.removeProvisionedWorktree(repoPath, {
        ...move, checkoutCreated: move.state === "checkout-created",
      }, () => this.threads.markMoveWorktreeCreated(move.id, this.now().toISOString()));
      await this.threads.deleteProvisioningMoveWorktree(move.id);
      if (outcome === "unowned") {
        logger.warn("Interrupted move left an unrelated path untouched", { moveId: move.id, worktreePath: move.worktreePath });
      }
    } catch (error) {
      logger.warn("Interrupted move could not remove its worktree", { moveId: move.id, worktreePath: move.worktreePath, error: String(error) });
    }
  }

  private async resolvePlacement(
    project: Workspace,
    target: Exclude<ThreadMoveInput["target"], { kind: "new-worktree" }>,
  ): Promise<Exclude<ThreadMovePlacement, NewWorktreePlacement>> {
    if (target.kind === "existing-worktree") {
      const checkout = await this.branching.resolveExistingWorktree({ ...target, workspaceId: project.id });
      return { kind: target.kind, ...checkout };
    }
    const branch = project.is_git_repo ? await this.git.getCurrentBranchAt(project.path) : "main";
    if (!branch) throw new Error("The project root has no current branch");
    return { kind: target.kind, branch };
  }
}
