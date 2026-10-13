import { useMemo } from "react";
import type { DetachedWorktreeTarget, GitListError, GitRef, GitRefSide, GitSearchCommitsResult } from "@mcode/contracts";

import { getTransport } from "@/transport";
import type { PickerStatus } from "@/components/ui/picker";
import {
  createTargetPageCache,
  useTargetPageList,
  type TargetPageList,
  type TargetPageStatus,
} from "@/features/conversation/composer/execution/targets/target-page-cache";

/** Rows per page of a picker list, the most the listing contracts allow. */
export const OPERAND_PAGE_SIZE = 100;

interface ReviewRefsParams {
  readonly workspaceId: string;
  readonly threadId: string | undefined;
  readonly side: GitRefSide;
  readonly query: string;
  readonly limit: number;
}

const reviewRefs = createTargetPageCache<ReviewRefsParams, GitRef | DetachedWorktreeTarget, GitRef | DetachedWorktreeTarget, GitListError>({
  fetchPage: (params, cursor) =>
    getTransport().listRefs({
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      purpose: "review",
      side: params.side,
      query: params.query || undefined,
      cursor,
      limit: params.limit,
    }),
  toItem: (target) => target,
  keyOf: (params) => JSON.stringify([params.workspaceId, params.threadId ?? "", params.side, params.query, params.limit]),
  listOf: (params) => JSON.stringify([params.workspaceId, params.threadId ?? "", params.side, params.limit]),
  workspaceOf: (params) => params.workspaceId,
  keepsUnsubscribed: (params) => params.query === "" && params.limit === OPERAND_PAGE_SIZE,
});

/** Which Review ref list to page. `limit: 1` reads only a count, such as the other tab's matches. */
export interface ReviewRefsRequest {
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly side: GitRefSide;
  readonly query: string;
  readonly limit?: number;
}

/** Pages Review's qualified-ref listing for one side. Pass null to subscribe to nothing, such as for a closed menu. */
export function useReviewRefs(request: ReviewRefsRequest | null): TargetPageList<GitRef, GitListError> {
  const { workspaceId, threadId, side } = request ?? {};
  const query = request?.query.trim() ?? "";
  const limit = request?.limit ?? OPERAND_PAGE_SIZE;
  const params = useMemo<ReviewRefsParams | null>(
    () => (workspaceId === undefined || side === undefined ? null : { workspaceId, threadId, side, query, limit }),
    [workspaceId, threadId, side, query, limit],
  );
  const list = useTargetPageList(reviewRefs, params);
  const items = useMemo(() => list.items.filter((target): target is GitRef => target.kind === "ref"), [list.items]);
  return useMemo(() => ({ ...list, items }), [list, items]);
}

/** One commit row of the Commit view's picker. */
export type SearchedCommit = Extract<GitSearchCommitsResult, { ok: true }>["commits"][number];

interface CommitSearchParams {
  readonly workspaceId: string;
  readonly threadId: string | undefined;
  readonly query: string;
}

const commitSearch = createTargetPageCache<CommitSearchParams, SearchedCommit, SearchedCommit, GitListError>({
  fetchPage: async (params, cursor) => {
    const offset = cursor === undefined ? 0 : Number(cursor);
    const result = await getTransport().searchCommits({
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      query: params.query || undefined,
      offset,
      limit: OPERAND_PAGE_SIZE,
    });
    if (!result.ok) return result;
    const next = offset + result.commits.length;
    return {
      ok: true,
      items: result.commits,
      total: result.matchCount,
      nextCursor: next < result.matchCount ? String(next) : null,
    };
  },
  toItem: (commit) => commit,
  keyOf: (params) => JSON.stringify([params.workspaceId, params.threadId ?? "", params.query]),
  listOf: (params) => JSON.stringify([params.workspaceId, params.threadId ?? ""]),
  workspaceOf: (params) => params.workspaceId,
  keepsUnsubscribed: (params) => params.query === "",
});

/** Which commit search to page. An empty query lists the whole range, so its total is the range's commit count. */
export interface CommitSearchRequest {
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly query: string;
}

/** Pages `git.searchCommits` over the Commit view's range. Pass null to subscribe to nothing. */
export function useCommitSearch(request: CommitSearchRequest | null): TargetPageList<SearchedCommit, GitListError> {
  const { workspaceId, threadId } = request ?? {};
  const query = request?.query.trim() ?? "";
  const params = useMemo<CommitSearchParams | null>(
    () => (workspaceId === undefined ? null : { workspaceId, threadId, query }),
    [workspaceId, threadId, query],
  );
  return useTargetPageList(commitSearch, params);
}

/** Refetches the subscribed operand lists of a workspace and drops the rest, after its git state changed. */
export function invalidateReviewOperandLists(workspaceId: string): void {
  reviewRefs.invalidateWorkspace(workspaceId);
  commitSearch.invalidateWorkspace(workspaceId);
}

/** Maps a paged list's status onto the picker's, so a listing failure shows an error row and not an empty list. */
export function pickerStatus<E extends { readonly message: string }>(status: TargetPageStatus<E>): PickerStatus {
  if (status.kind === "failed") return { failed: "Couldn't load the list", detail: status.error.message };
  return status.kind;
}
