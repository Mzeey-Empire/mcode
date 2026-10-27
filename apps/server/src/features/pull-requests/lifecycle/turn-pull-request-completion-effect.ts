import { logger } from "@mcode/shared";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import type { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import type { GithubService } from "../github/github-service.js";
import { normalizeThreadPullRequestState } from "../github/github-pull-request-normalizers.js";
import type { PullRequestLinkFunnel } from "../links/pull-request-link-funnel.js";

/** Refreshes a feature-branch pull-request link after a turn is terminally published. */
export class TurnPullRequestCompletionEffect {
  constructor(
    private readonly threads: ThreadRepo,
    private readonly workspaces: WorkspaceRepo,
    private readonly github: GithubService,
    private readonly funnel: PullRequestLinkFunnel,
  ) {}

  /** Start a non-blocking pull-request refresh for one completed turn. */
  schedule(threadId: string): void {
    void this.refresh(threadId).catch((error: unknown) => {
      logger.debug("PR lookup failed on completed turn", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async refresh(threadId: string): Promise<void> {
    const target = this.target(threadId);
    if (!target) return;
    const pr = await this.github.getBranchPr(target.branch, target.workspacePath);
    if (!pr) return;
    await this.funnel.observe(target.threadId, [{
      number: pr.number, state: normalizeThreadPullRequestState(pr.state), title: pr.title, url: pr.url,
    }], "turn-settled");
  }

  private target(threadId: string): {
    threadId: string;
    branch: string;
    workspacePath: string;
  } | null {
    const thread = this.threads.findById(threadId);
    if (!thread || thread.branch === "main" || thread.branch === "master") return null;
    const workspace = this.workspaces.findById(thread.workspace_id);
    if (!workspace) return null;
    return {
      threadId: thread.id,
      branch: thread.branch,
      workspacePath: workspace.path,
    };
  }
}
