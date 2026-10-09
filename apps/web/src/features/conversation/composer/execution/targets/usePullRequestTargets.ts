import { useMemo } from "react";
import type { PullRequestError, PullRequestTarget } from "@mcode/contracts";

import { getTransport } from "@/transport";
import { toPullRequestTarget, type PullRequestBranchTarget } from "./branch-target";
import { createTargetPageCache, useTargetPageList, type TargetPageList } from "./target-page-cache";

/** Which pull request list to page. */
export interface PullRequestTargetsRequest {
  readonly workspaceId: string;
  readonly query?: string;
}

interface PullRequestTargetsParams {
  readonly workspaceId: string;
  readonly query: string;
}

const pullRequestTargets = createTargetPageCache<PullRequestTargetsParams, PullRequestTarget, PullRequestBranchTarget, PullRequestError>({
  fetchPage: (params, cursor) =>
    getTransport().listPullRequestTargets({ workspaceId: params.workspaceId, query: params.query || undefined, cursor }),
  toItem: toPullRequestTarget,
  keyOf: (params) => JSON.stringify([params.workspaceId, params.query]),
  listOf: (params) => params.workspaceId,
  workspaceOf: (params) => params.workspaceId,
  keepsUnsubscribed: (params) => params.query === "",
  isStaleCursor: (error) => error.code === "stale_cursor",
});

/**
 * Pages `github.pullRequestTargets.list` (GitHub search) for one request. Pass null to subscribe to nothing. A
 * typed query should come through `useDebouncedQuery`; this hook fetches whatever it is given.
 */
export function usePullRequestTargets(
  request: PullRequestTargetsRequest | null,
): TargetPageList<PullRequestBranchTarget, PullRequestError> {
  const query = request?.query?.trim() ?? "";
  const workspaceId = request?.workspaceId;
  const params = useMemo<PullRequestTargetsParams | null>(
    () => (workspaceId === undefined ? null : { workspaceId, query }),
    [workspaceId, query],
  );
  return useTargetPageList(pullRequestTargets, params);
}

/** Refetches a workspace's unfiltered pull request list now if it is shown, else the next time it is. */
export function revalidatePullRequestTargets(workspaceId: string): void {
  pullRequestTargets.revalidate({ workspaceId, query: "" });
}
