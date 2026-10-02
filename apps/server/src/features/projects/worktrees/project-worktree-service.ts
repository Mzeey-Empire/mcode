import { inject, injectable } from "tsyringe";
import { sanitizeBranchForFolder, validateBranchName, logger } from "@mcode/shared";
import type { Thread } from "@mcode/contracts";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../persistence/workspace-repo.js";
import { GitWorktreeService } from "../git/git-worktree-service.js";
import { SandboxWorktreeCleanupPolicy } from "./sandbox-worktree-cleanup-policy.js";
import { ApplicationDatabaseWriter, DatabaseWriteOutcomeUnknown } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { projectLifecycleWriteOperations } from "../lifecycle/project-lifecycle-write-operations.js";

function managedWorktreeName(ref: string, threadId: string): string {
  return `${sanitizeBranchForFolder(ref).slice(0, 91)}-${threadId.slice(0, 8)}`;
}

/** Owns project worktree provisioning, rollback, and cleanup scheduling. */
@injectable()
export class ProjectWorktreeService {
  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter,
    @inject(GitWorktreeService) private readonly gitWorktrees: Pick<GitWorktreeService, "createWorktree" | "removeWorktree">,
    @inject(SandboxWorktreeCleanupPolicy) private readonly cleanupPolicy: Pick<SandboxWorktreeCleanupPolicy, "decide">,
  ) {}

  /** Provision a worktree for a newly-created thread and persist its path. */
  async provisionThreadWorktree(
    thread: Thread,
    workspaceId: string,
    branch: string,
    options: { branchless?: boolean } = {},
  ): Promise<Thread & { warnings?: string[] }> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    const worktreeName = managedWorktreeName(branch, thread.id);
    const info = await this.gitWorktrees.createWorktree(
      workspace.path,
      worktreeName,
      branch,
      { branchless: options.branchless },
    );

    const committed = await this.persistProvisionedWorktree(thread, workspace.path, { info, name: worktreeName, ref: branch });
    return {
      ...committed,
      warnings: info.warnings.length > 0 ? info.warnings : undefined,
    };
  }

  /** Provision a new worktree for an already-persisted delegated thread. */
  async provisionWorktree(
    threadId: string,
    workspaceId: string,
    placement: { baseRef: string; branchName?: string },
  ): Promise<Thread & { warnings?: string[] }> {
    const thread = this.requireProvisionableThread(threadId, workspaceId);
    const workspace = this.requireWorkspace(workspaceId);
    validateWorktreePlacement(placement);
    const provisioned = await this.createDelegatedWorktree(thread, workspace.path, placement);
    const committed = await this.persistProvisionedWorktree(thread, workspace.path, provisioned);
    return {
      ...committed,
      warnings: provisioned.info.warnings.length > 0 ? provisioned.info.warnings : undefined,
    };
  }

  /** Idempotently remove only the deterministic managed worktree for interrupted provisioning. */
  async cleanupInterruptedProvisioning(
    threadId: string,
    workspaceId: string,
    placement: { baseRef: string; branchName?: string },
  ): Promise<boolean> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const ref = placement.branchName ?? placement.baseRef;
    const name = managedWorktreeName(ref, threadId);
    return this.gitWorktrees.removeWorktree(workspace.path, name, { deleteBranch: false });
  }

  /** Enqueue checkout cleanup when Mcode owns the sandbox worktree. */
  async scheduleCleanup(threadId: string): Promise<boolean> {
    const thread = this.getWorktreeCleanupCandidate(threadId);
    if (!thread) return false;
    const worktreePath = thread.worktree_path;
    if (!worktreePath) return false;
    const workspace = this.workspaceRepo.findById(thread.workspace_id);
    if (!workspace) {
      logger.warn("Worktree cleanup skipped because the workspace no longer exists", {
        threadId,
        workspaceId: thread.workspace_id,
        worktreePath,
      });
      return false;
    }

    const firstDecision = await this.cleanupPolicy.decide({
      workspacePath: workspace.path,
      worktreePath,
      branch: thread.branch,
      checkoutState: thread.checkout_state,
    });
    if (firstDecision.action === "retain") return false;

    const current = this.getCurrentCleanupCandidate(threadId, worktreePath);
    if (!current || current.worktree_path !== worktreePath) return false;
    const currentDecision = await this.cleanupPolicy.decide({
      workspacePath: workspace.path,
      worktreePath: current.worktree_path,
      branch: current.branch,
      checkoutState: current.checkout_state,
    });
    if (currentDecision.action === "retain") return false;
    const committed = await this.writer.execute(projectLifecycleWriteOperations.scheduleWorktreeCleanup,
      [threadId, current.workspace_id, workspace.path, current.worktree_path, currentDecision.branch]);
    if (committed) logger.info("Worktree cleanup job enqueued", { threadId, worktreePath: current.worktree_path });
    return committed;
  }

  private requireProvisionableThread(threadId: string, workspaceId: string): Thread {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.workspace_id !== workspaceId || thread.mode !== "worktree") {
      throw new Error("Delegated worktree thread is not available for provisioning");
    }
    if (thread.worktree_path) throw new Error("Delegated worktree thread is already provisioned");
    return thread;
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace;
  }

  private async createDelegatedWorktree(
    thread: Thread,
    workspacePath: string,
    placement: { baseRef: string; branchName?: string },
  ): Promise<{ info: Awaited<ReturnType<GitWorktreeService["createWorktree"]>>; name: string; ref: string }> {
    const ref = placement.branchName ?? placement.baseRef;
    const name = managedWorktreeName(ref, thread.id);
    const info = await this.gitWorktrees.createWorktree(
      workspacePath,
      name,
      ref,
      delegatedWorktreeOptions(placement),
    );
    return { info, name, ref };
  }

  private async persistProvisionedWorktree(
    thread: Thread,
    workspacePath: string,
    provisioned: { info: Awaited<ReturnType<GitWorktreeService["createWorktree"]>>; name: string; ref: string },
  ): Promise<Thread> {
    try {
      const committed = await this.writer.execute(projectLifecycleWriteOperations.persistProvisionedWorktree,
        [thread.id, thread.workspace_id, provisioned.info.path]);
      if (!committed) throw new Error(`Failed to persist worktree path for thread ${thread.id}`);
      return committed;
    } catch (error) {
      // A lost acknowledgment may follow a commit; deleting that checkout would corrupt durable state.
      if (error instanceof DatabaseWriteOutcomeUnknown) throw error;
      await this.rollbackProvisionedWorktree(thread.id, workspacePath, provisioned);
      throw error;
    }
  }

  private async rollbackProvisionedWorktree(
    threadId: string, workspacePath: string,
    provisioned: { info: { createdBranch: boolean }; name: string; ref: string },
  ): Promise<void> {
    try {
      const cleaned = await this.gitWorktrees.removeWorktree(workspacePath, provisioned.name, rollbackOptions(provisioned));
      if (!cleaned) logger.warn("Rollback worktree cleanup returned false during thread creation", { threadId, worktreeName: provisioned.name, workspacePath });
    } catch (error) {
      logger.warn("Rollback worktree cleanup failed during thread creation", {
        threadId, worktreeName: provisioned.name, workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getWorktreeCleanupCandidate(threadId: string): Thread | null {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.deleted_at !== null || !thread.worktree_path) return null;
    return thread;
  }

  private getCurrentCleanupCandidate(threadId: string, worktreePath: string): Thread | null {
    const current = this.getWorktreeCleanupCandidate(threadId);
    return current?.worktree_path === worktreePath ? current : null;
  }
}

function validateWorktreePlacement(placement: { baseRef: string; branchName?: string }): void {
  validateBranchName(placement.baseRef);
  if (placement.branchName) validateBranchName(placement.branchName);
}

function delegatedWorktreeOptions(placement: { baseRef: string; branchName?: string }): { branchless: boolean; baseRef?: string } {
  return placement.branchName
    ? { branchless: false, baseRef: placement.baseRef }
    : { branchless: true };
}

function rollbackOptions(provisioned: { info: { createdBranch: boolean }; ref: string }): { branchName: string } | { deleteBranch: false } {
  return provisioned.info.createdBranch ? { branchName: provisioned.ref } : { deleteBranch: false };
}
