import { PullRequestIdentitySchema, PullRequestReviewLinkSchema, type PullRequestReviewLink as ReviewLinkDto } from "@mcode/contracts";
import type { PullRequestReviewLink } from "./persistence/pull-request-review-link-store.js";

/** Validate a persisted link before the worker commits or a main read publishes it. */
export function reviewLinkProjection(link: PullRequestReviewLink): ReviewLinkDto {
  if (!link.primaryThreadId) throw new Error("Review link has no canonical task.");
  const url = new URL(link.pullRequestUrl);
  const [owner, repository, segment, number] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repository || segment !== "pull" || Number(number) !== link.pullRequestNumber) {
    throw new Error("Review link has an invalid pull request URL.");
  }
  const identity = PullRequestIdentitySchema().parse({
    provider: link.provider, repositoryNodeId: link.repositoryNodeId, owner, repository, number: link.pullRequestNumber,
  });
  return PullRequestReviewLinkSchema().parse({
    identity, pullRequestUrl: link.pullRequestUrl, pullRequestState: link.pullRequestState,
    threadId: link.primaryThreadId, worktreeId: link.worktreeId, workspaceId: link.workspaceId,
    worktreePath: link.worktreePath, worktreeManaged: link.worktreeManaged, checkoutState: "named",
    localBranch: link.localBranch, headOid: link.headOid, pushRemote: link.pushRemote, pushRef: link.pushRef,
  });
}
