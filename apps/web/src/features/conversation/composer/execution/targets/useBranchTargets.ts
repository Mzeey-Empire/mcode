import { useEffect, useMemo, useState } from "react";
import type { DetachedWorktreeTarget, GitListError, GitRef } from "@mcode/contracts";

import { getTransport } from "@/transport";
import { pickDefaultBranchTarget, toBranchTarget, type BranchRefTarget, type BranchTarget } from "./branch-target";
import { createTargetPageCache, useTargetPageList, type TargetPageList } from "./target-page-cache";

/** Which branch list to page. */
export interface BranchTargetsRequest {
  readonly workspaceId: string;
  /** A persisted thread only. A draft new thread has no record, and the server rejects unknown ids. */
  readonly threadId?: string;
  readonly purpose: "new-thread" | "existing-worktree";
  readonly query?: string;
}

interface BranchTargetsParams {
  readonly workspaceId: string;
  readonly threadId: string | undefined;
  readonly purpose: BranchTargetsRequest["purpose"];
  readonly query: string;
}

const QUERY_DEBOUNCE_MS = 150;

const branchTargets = createTargetPageCache<BranchTargetsParams, GitRef | DetachedWorktreeTarget, BranchTarget, GitListError>({
  fetchPage: (params, cursor) =>
    getTransport().listRefs({
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      purpose: params.purpose,
      query: params.query || undefined,
      cursor,
    }),
  toItem: toBranchTarget,
  keyOf: (params) => JSON.stringify([params.workspaceId, params.threadId ?? "", params.purpose, params.query]),
  listOf: (params) => JSON.stringify([params.workspaceId, params.threadId ?? "", params.purpose]),
  workspaceOf: (params) => params.workspaceId,
  keepsUnsubscribed: (params) => params.query === "",
});

/**
 * Debounces a search field so each keystroke does not cost a request. Clearing the query applies at once, so the
 * unfiltered list never waits. Hosts debounce once and pass the result to every target hook, so lists that open
 * on a typed query, like the pull request group, fetch that query and never the unfiltered list on the way.
 */
export function useDebouncedQuery(query: string): string {
  const [debounced, setDebounced] = useState(query);
  if (query === "" && debounced !== "") setDebounced("");
  useEffect(() => {
    if (query === "") return;
    const timer = setTimeout(() => setDebounced(query), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  return query === "" ? "" : debounced.trim();
}

/**
 * Pages `git.refs.list` for one request. Pass null to subscribe to nothing, such as for a closed menu. A typed
 * query should come through {@link useDebouncedQuery}; this hook fetches whatever it is given.
 */
export function useBranchTargets(request: BranchTargetsRequest | null): TargetPageList<BranchTarget, GitListError> {
  const query = request?.query?.trim() ?? "";
  const workspaceId = request?.workspaceId;
  const threadId = request?.threadId;
  const purpose = request?.purpose;
  const params = useMemo<BranchTargetsParams | null>(
    () => (workspaceId === undefined || purpose === undefined ? null : { workspaceId, threadId, purpose, query }),
    [workspaceId, threadId, purpose, query],
  );
  return useTargetPageList(branchTargets, params);
}

/**
 * The default branch for a context, read from the page one the open picker shares: the checked-out branch,
 * else the repository default. `undefined` while page one loads; `null` when it failed or names neither.
 */
export function useDefaultBranchTarget(
  request: Pick<BranchTargetsRequest, "workspaceId" | "threadId"> | null,
): BranchRefTarget | null | undefined {
  const list = useBranchTargets(request && { workspaceId: request.workspaceId, threadId: request.threadId, purpose: "new-thread" });
  if (request === null) return undefined;
  // Rows kept through a failed revalidation still name the default; only an empty list is unknown.
  if (list.items.length > 0) return pickDefaultBranchTarget(list.items);
  return list.status.kind === "loading" ? undefined : null;
}

/** Refetches page one of a branch list, keeping its rows on screen; branches made out of band push no event. */
export function revalidateBranchTargets(request: Omit<BranchTargetsRequest, "query">): void {
  branchTargets.revalidate({ workspaceId: request.workspaceId, threadId: request.threadId, purpose: request.purpose, query: "" });
}

/** Called on `branch.changed`: refetches every subscribed branch list of the workspace and drops the rest. */
export function invalidateBranchTargets(workspaceId: string): void {
  branchTargets.invalidateWorkspace(workspaceId);
}
