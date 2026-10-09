import { z } from "zod";
import { PullRequestTargetSchema, type PullRequestTargetsListParams } from "@mcode/contracts";

/** Repository identity and paging arguments for the GitHub target query. */
export type RepositoryPullRequestTargetsRequest = Omit<PullRequestTargetsListParams, "workspaceId"> & {
  owner: string;
  name: string;
  signal: AbortSignal;
};

const targetFields = "number title headRefName author { login } isCrossRepository url";
const targetNodeSchema = PullRequestTargetSchema().extend({
  author: z.object({ login: z.string().max(100) }).nullable(),
});
const exactTargetSchema = z.object({ repository: z.object({
  pullRequest: targetNodeSchema.extend({ state: z.enum(["OPEN", "CLOSED", "MERGED"]) }).nullable(),
}) });

/** Exact-number lookup used before the first numeric search page. */
export const exactPullRequestTargetQuery = `query ExactPullRequestTarget($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { state ${targetFields} } }
}`;

/** Return an exact-number target only while the pull request is open. */
export function parseExactPullRequestTarget(data: unknown) {
  const node = exactTargetSchema.parse(data).repository.pullRequest;
  if (!node || node.state !== "OPEN") return null;
  return PullRequestTargetSchema().parse({ ...node, author: node.author?.login ?? null });
}
const connectionSchema = z.object({
  nodes: z.array(targetNodeSchema),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});
const searchPageSchema = z.object({ search: connectionSchema.extend({ issueCount: z.number().int().nonnegative() }) });
const repositoryPageSchema = z.object({ repository: z.object({
  pullRequests: connectionSchema.extend({ totalCount: z.number().int().nonnegative() }),
}) });

/** GraphQL repository connection for an unfiltered open-PR page. */
export const repositoryPullRequestTargetsQuery = `query RepositoryPullRequestTargets(
  $owner: String!, $name: String!, $first: Int!, $after: String
) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount pageInfo { hasNextPage endCursor } nodes { ${targetFields} }
    }
  }
}`;

/** GraphQL search connection for repository-scoped open PR targets. */
export const searchPullRequestTargetsQuery = `query SearchPullRequestTargets($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: ISSUE, first: $first, after: $after) {
    issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${targetFields} } }
  }
}`;

/** Validate GitHub's target connection before exposing rows across the RPC boundary. */
export function parsePullRequestTargetPage(data: unknown, searched: boolean) {
  const connection = searched
    ? searchPageSchema.parse(data).search
    : repositoryPageSchema.parse(data).repository.pullRequests;
  if (connection.pageInfo.hasNextPage && !connection.pageInfo.endCursor) {
    throw new Error("GitHub returned a page without its continuation cursor");
  }
  return {
    ok: true as const,
    items: connection.nodes.map((node) => ({ ...node, author: node.author?.login ?? null })),
    total: "issueCount" in connection ? connection.issueCount : connection.totalCount,
    nextCursor: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null,
  };
}
