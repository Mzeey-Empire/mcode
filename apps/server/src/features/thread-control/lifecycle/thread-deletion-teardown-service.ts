import { inject, injectable } from "tsyringe";
import { GithubService } from "../../pull-requests/github/github-service.js";
import { CiWatcherService } from "../../pull-requests/status/ci-watcher.js";
import { GitWatcherService } from "../../projects/git/git-watcher-service.js";
import { ProjectActionService } from "../../projects/environment/project-action-service.js";
import { WorkspaceEnvironmentService } from "../../projects/environment/workspace-environment-service.js";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { ThreadTeardownService } from "./thread-teardown-service.js";

/** Stops every runtime resource that belongs to one thread before deletion. */
@injectable()
export class ThreadDeletionTeardownService {
  private acceptedProgress: Pick<import("../../agents/canonical/canonical-accepted-progress.js").CanonicalAcceptedProgress,
    "discardThreads" | "finishThreadDeletion"> | undefined;

  /** Compose retained-save disposal for direct deletion, delayed cleanup, and workspace cascades. */
  bindAcceptedProgress(progress: NonNullable<ThreadDeletionTeardownService["acceptedProgress"]>): void {
    this.acceptedProgress = progress;
  }

  /** Fence late admission while the exact in-flight save settles and persistent deletion runs. */
  async deletePersistentData<Result>(threadIds: readonly string[], remove: () => Promise<Result>): Promise<Result> {
    const progress = this.acceptedProgress;
    if (!progress) throw new Error("Conversation deletion requires its accepted progress boundary");
    try {
      await progress.discardThreads(threadIds);
      return await remove();
    } finally {
      for (const id of threadIds) progress.finishThreadDeletion(id);
    }
  }

  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(WorkspaceEnvironmentService)
    private readonly workspaceEnvironmentService: WorkspaceEnvironmentService,
    @inject(ProjectActionService) private readonly projectActionService: ProjectActionService,
    @inject(GithubService) private readonly githubService: GithubService,
    @inject(CiWatcherService) private readonly ciWatcherService: CiWatcherService,
    @inject(ThreadTeardownService) private readonly threadTeardownService: ThreadTeardownService,
    @inject(GitWatcherService) private readonly gitWatcherService: GitWatcherService,
  ) {}

  /** Stop thread work and detach its file watcher before persistent data is removed. */
  async teardownThread(threadId: string): Promise<void> {
    const releaseDeletionBarrier = this.workspaceEnvironmentService.beginThreadDeletion(threadId);
    let releaseActionAdmission: (() => void) | undefined;
    try {
      releaseActionAdmission = await this.projectActionService.beginThreadTeardown(threadId);
      const thread = this.threadRepo.findById(threadId);
      await this.workspaceEnvironmentService.cancelSetupForThread(threadId);
      await this.projectActionService.stopForThread(threadId);
      if (thread?.worktree_path) {
        await this.githubService.cancelForRepoPath(thread.worktree_path);
      }
      await this.ciWatcherService.teardownThread(threadId);
      await this.threadTeardownService.teardownThread(threadId);
      this.gitWatcherService.unwatchThreadWorktree(threadId);
    } finally {
      releaseActionAdmission?.();
      releaseDeletionBarrier();
    }
  }
}
