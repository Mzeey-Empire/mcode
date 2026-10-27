import { inject, injectable } from "tsyringe";
import type { Thread } from "@mcode/contracts/models/thread";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { GitRepositoryService } from "../../projects/git/git-repository-service.js";
import { GitWorktreeService } from "../../projects/git/git-worktree-service.js";

/** Owns branch creation and checkout-state synchronization for thread handoffs. */
@injectable()
export class HandoffCheckoutService {
  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(GitRepositoryService) private readonly gitRepository: GitRepositoryService,
    @inject(GitWorktreeService) private readonly gitWorktrees: GitWorktreeService,
  ) {}

  /** Create a named branch in a thread's resolved checkout and persist its state. */
  async createBranchForThread(
    workspaceId: string,
    threadId: string | undefined,
    name: string,
  ): Promise<string> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    let path = workspace.path;
    if (threadId) {
      const thread = this.threadRepo.findById(threadId);
      if (!thread) throw new Error(`Thread not found: ${threadId}`);
      if (thread.workspace_id !== workspaceId) {
        throw new Error(`Thread ${threadId} does not belong to workspace ${workspaceId}`);
      }
      path = this.gitWorktrees.resolveWorkingDir(
        workspace.path,
        thread.mode,
        thread.worktree_path,
      );
    }

    const branch = await this.gitRepository.createBranch(path, name);
    if (threadId) {
      const updated = await this.threadRepo.updateCheckoutToNamedBranch(threadId, branch);
      if (!updated) {
        throw new Error(
          `Failed to update checkout state for thread ${threadId}`,
        );
      }
    }
    return branch;
  }

  /**
   * Record the commit hash of a detached thread that predates `head_sha`, or whose creation path
   * never read it. Every other thread is skipped so startup does not spawn Git for each worktree.
   */
  async backfillDetachedHeadSha(threadId: string): Promise<{ thread: Thread; changed: boolean } | null> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.checkout_state !== "branchless" || thread.head_sha) return null;
    return this.syncCheckoutFromHead(threadId);
  }

  /** Synchronize a worktree thread's persisted checkout state from its Git HEAD. */
  async syncCheckoutFromHead(threadId: string): Promise<{ thread: Thread; changed: boolean } | null> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.mode !== "worktree" || !thread.worktree_path) return null;

    const currentBranch = await this.gitRepository.getCurrentBranchAt(thread.worktree_path);
    const detached = !currentBranch || currentBranch === "HEAD";
    const branch = detached ? "HEAD" : currentBranch;
    const checkoutState = detached ? "branchless" : "named";
    const baseBranch = detached ? detachedBaseBranch(thread) : null;

    // Only a detached checkout needs a hash to be told apart. A named branch is identified by its name.
    const headSha = detached ? await this.gitRepository.getHeadShaAt(thread.worktree_path) : null;

    return this.threadRepo.updateCheckoutFromHead(
      threadId,
      branch,
      checkoutState,
      baseBranch,
      headSha,
    );
  }
}

/** The branch a detached thread started from: its recorded base, else the named branch it just left. */
function detachedBaseBranch(thread: Pick<Thread, "base_branch" | "branch">): string | null {
  return thread.base_branch ?? (thread.branch !== "HEAD" ? thread.branch : null);
}
