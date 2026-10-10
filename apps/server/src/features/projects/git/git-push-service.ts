/**
 * One push path for `git.push` and for commit requests, including Review task targets and the
 * CI bumps that follow a push.
 */
import { inject, injectable } from "tsyringe";
import { logger, validateBranchName } from "@mcode/shared";
import { CiWatcherService } from "../../pull-requests/status/ci-watcher.js";
import { ReviewWorktreeService } from "../../pull-requests/reviews/review-worktree-service.js";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import type { CommitPushDestination } from "./commits/commit-request.js";
import { gitExitCode } from "./execution/git-failure.js";
import type { GitExecutor } from "./execution/types.js";
import { GitRepositoryService } from "./git-repository-service.js";
import { PullRequestReviewGitService } from "./pull-request-review-git-service.js";

type ReviewPushTarget = Extract<
  ReturnType<ReviewWorktreeService["resolvePushTarget"]>,
  { kind: "review" }
>["target"];

const REMOTE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const PUSH_TIMEOUT_MS = 60_000;

/** A `git.push` request for the branch checked out in a workspace. */
export interface CheckedOutBranchPush {
  workspaceId: string;
  workspacePath: string;
  branch: string;
  threadId?: string;
}

/** A commit request's push of the exact SHA it made. */
export interface CommitPush {
  workspaceId: string;
  repoPath: string;
  sha: string;
  destination: CommitPushDestination;
}

/** Pushes branches and commit SHAs to standard or Review task targets without force. */
@injectable()
export class GitPushService {
  constructor(
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject(GitRepositoryService)
    private readonly gitRepository: Pick<GitRepositoryService, "push" | "getCurrentBranchAt">,
    @inject(PullRequestReviewGitService)
    private readonly pullRequestReviews: Pick<PullRequestReviewGitService, "pushPullRequestReviewBranch">,
    @inject(ReviewWorktreeService)
    private readonly reviewWorktrees: Pick<ReviewWorktreeService, "resolvePushTarget">,
    @inject(CiWatcherService)
    private readonly ciWatcher: Pick<CiWatcherService, "findByWorkspaceBranch" | "scheduleBumpAfterPush">,
    @inject("ThreadRepo") private readonly threadRepo: Pick<ThreadRepo, "findById">,
  ) {}

  /** Push the checked-out branch, using a linked Review task's persisted target when there is one. */
  async pushCheckedOutBranch(request: CheckedOutBranchPush): Promise<void> {
    const resolution = request.threadId
      ? this.reviewWorktrees.resolvePushTarget(request.threadId)
      : { kind: "standard" as const };
    if (resolution.kind === "invalid_review") throw invalidReviewLink();
    if (resolution.kind === "review") {
      const target = this.matchReviewTarget(resolution.target, request.workspaceId, request.branch);
      await this.assertReviewCheckout(target);
      await this.pullRequestReviews.pushPullRequestReviewBranch(
        target.worktreePath,
        target.pushRemote,
        target.pushRef,
        target.expectedHeadRepositoryUrl,
      );
    } else {
      await this.gitRepository.push(request.workspacePath, request.branch);
    }
    this.scheduleBumps(request.workspaceId, request.branch);
  }

  /**
   * Resolve where a commit request will push. It is captured before the commit so a later
   * change to the thread's Review link or checkout cannot redirect the push.
   */
  captureDestination(workspaceId: string, threadId: string | null, branch: string): CommitPushDestination {
    const resolution = threadId ? this.reviewWorktrees.resolvePushTarget(threadId) : { kind: "standard" as const };
    if (resolution.kind === "invalid_review") throw invalidReviewLink();
    if (resolution.kind === "standard") {
      validateBranchName(branch);
      return { kind: "standard", remote: "origin", branch };
    }
    const target = this.matchReviewTarget(resolution.target, workspaceId, branch);
    return {
      kind: "review",
      worktreePath: target.worktreePath,
      remote: target.pushRemote,
      pushRef: target.pushRef,
      localBranch: target.localBranch,
      expectedHeadRepositoryUrl: target.expectedHeadRepositoryUrl,
    };
  }

  /** Push `sha` to the captured destination, never force, then bump CI watchers. */
  async pushCommit(request: CommitPush): Promise<void> {
    if (!OBJECT_ID.test(request.sha)) throw new Error("Invalid commit SHA to push.");
    const { destination } = request;
    if (destination.kind === "review") {
      await this.pullRequestReviews.pushPullRequestReviewBranch(
        destination.worktreePath,
        destination.remote,
        destination.pushRef,
        destination.expectedHeadRepositoryUrl,
        request.sha,
      );
      this.scheduleBumps(request.workspaceId, destination.localBranch);
      return;
    }
    await this.pushStandardCommit(request.repoPath, request.sha, destination);
    this.scheduleBumps(request.workspaceId, destination.branch);
  }

  private async pushStandardCommit(
    repoPath: string,
    sha: string,
    destination: Extract<CommitPushDestination, { kind: "standard" }>,
  ): Promise<void> {
    if (!REMOTE_NAME.test(destination.remote)) throw new Error("Invalid push remote.");
    validateBranchName(destination.branch);
    await this.gitExecutor.exec(
      ["-C", repoPath, "push", destination.remote, `${sha}:refs/heads/${destination.branch}`],
      { timeout: PUSH_TIMEOUT_MS },
    );
    await this.setUpstreamIfMissing(repoPath, destination.remote, destination.branch);
  }

  private async setUpstreamIfMissing(repoPath: string, remote: string, branch: string): Promise<void> {
    try {
      if (await this.hasUpstream(repoPath, branch)) return;
      await this.gitExecutor.exec(["-C", repoPath, "branch", `--set-upstream-to=${remote}/${branch}`, branch]);
    } catch (error) {
      // The push already landed. Tracking is a convenience, so a failure here must not
      // report the push itself as failed.
      logger.warn("Pushed commit but could not set the branch upstream", {
        branch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async hasUpstream(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.gitExecutor.exec(
        ["-C", repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`],
      );
      return true;
    } catch (error) {
      if (gitExitCode(error) !== null) return false;
      throw error;
    }
  }

  private matchReviewTarget(target: ReviewPushTarget, workspaceId: string, branch: string): ReviewPushTarget {
    if (target.workspaceId !== workspaceId || target.localBranch !== branch) {
      throw new Error("Review task push target does not match the requested Workspace branch.");
    }
    return target;
  }

  private async assertReviewCheckout(target: ReviewPushTarget): Promise<void> {
    const currentBranch = await this.gitRepository.getCurrentBranchAt(target.worktreePath);
    if (currentBranch !== target.localBranch) {
      throw new Error(
        `Review task checkout is on ${currentBranch ?? "detached HEAD"}, expected ${target.localBranch}.`,
      );
    }
  }

  private scheduleBumps(workspaceId: string, branch: string): void {
    // Fresh CI runs appear 3-15s after push. Schedule bumps so the UI surfaces
    // "pending" without waiting a full passive poll cycle.
    const threadIds = this.ciWatcher.findByWorkspaceBranch((id) => this.threadRepo.findById(id), workspaceId, branch);
    for (const threadId of threadIds) this.ciWatcher.scheduleBumpAfterPush(threadId);
  }
}

function invalidReviewLink(): Error {
  return new Error("The Review task link changed. Reload the task before pushing.");
}
