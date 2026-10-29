import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Normalized lifecycle of a linked PR, including unverified legacy links. */
export const ThreadPullRequestStateSchema = z.enum(["open", "draft", "merged", "closed", "unresolved"]);
/** Lifecycle shown for a linked pull request. */
export type ThreadPullRequestState = z.infer<typeof ThreadPullRequestStateSchema>;

const threadPullRequestSchema = lazySchema(() => z.object({
  number: z.number().int().positive(),
  state: ThreadPullRequestStateSchema,
  title: z.string().max(512).nullable(),
  url: z.string().url().nullable(),
}).strict());
/** Persisted or legacy pull-request link exposed to clients. */
export type ThreadPullRequest = z.infer<ReturnType<typeof threadPullRequestSchema>>;

/** Validate a linked pull request for transport. */
export const ThreadPullRequestSchema: () => z.ZodType<ThreadPullRequest> = threadPullRequestSchema;

const STATE_RANK: Record<ThreadPullRequestState, number> = {
  open: 0, draft: 1, unresolved: 2, merged: 3, closed: 4,
};

/** Order by attention, then newest PR number, without mutating the input. */
export function rankPullRequests(prs: readonly ThreadPullRequest[]): ThreadPullRequest[] {
  return [...prs].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.number - a.number);
}

/** Only a nonempty set consisting entirely of merged PRs is all-merged. */
export function pullRequestsSettledMerged(prs: readonly ThreadPullRequest[]): boolean {
  return prs.length > 0 && prs.every((pr) => pr.state === "merged");
}
