import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { GitListError, PullRequestError } from "@mcode/contracts";

import { Picker, type PickerRow, type PickerStatus, type PickerTab } from "@/components/ui/picker";
import { normalizeWorktreePath } from "@/lib/worktree";
import type { BranchTarget, BranchTargetValue } from "./targets/branch-target";
import type { TargetPageList, TransportFailure } from "./targets/target-page-cache";
import { revalidateBranchTargets, useBranchTargets, useDebouncedQuery } from "./targets/useBranchTargets";
import { revalidatePullRequestTargets, usePullRequestTargets } from "./targets/usePullRequestTargets";

/** Which targets a host offers. */
export type BranchTargetList = "branches" | "branches-and-pull-requests" | "worktrees";

/** Props for {@link BranchTargetPicker}. */
export interface BranchTargetPickerProps {
  readonly workspaceId: string;
  /** Persisted thread whose checkout decides which branch is current; omit for a draft new thread. */
  readonly threadId?: string;
  /**
   * `branches`: branch rows only. `branches-and-pull-requests`: Branches and Pull requests tabs, with matching
   * pull requests grouped under a branch search (New worktree). `worktrees`: linked checkouts (Existing worktree).
   */
  readonly list: BranchTargetList;
  readonly value: BranchTargetValue | null;
  readonly onSelect: (target: BranchTarget) => void;
  /** Dims a row and says why, such as the head branch in the pull request base picker. */
  readonly disabledReason?: (target: BranchTarget) => string | undefined;
  /** Shown under the Branches list, never on Pull requests and never while the list failed. */
  readonly footer?: ReactNode;
}

type TargetTab = "branches" | "pull-requests";
type TargetError = GitListError | PullRequestError | TransportFailure;

const TABS: readonly PickerTab[] = [
  { id: "branches", label: "Branches" },
  { id: "pull-requests", label: "Pull requests" },
];

interface TargetView {
  readonly items: readonly BranchTarget[];
  readonly total: number | null;
  readonly status: PickerStatus;
  readonly loadMore: () => void;
  readonly retry: () => void;
  /** Pull request rows follow the branches under their own label. */
  readonly grouped: boolean;
}

/**
 * Searchable, paged picker body for branches, pull requests and worktrees. The host owns the surface (popover,
 * dialog or side menu) and maps the picked target onto its own state.
 */
export function BranchTargetPicker(props: BranchTargetPickerProps) {
  const { list, value, onSelect, disabledReason } = props;
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<TargetTab>("branches");
  const offersPullRequests = list === "branches-and-pull-requests";
  const onPullRequestTab = offersPullRequests && activeTab === "pull-requests";
  const view = useTargetView(props, query, onPullRequestTab);
  const renderItem = (target: BranchTarget) => targetRow(target, list, view.grouped, disabledReason?.(target));

  return (
    <Picker<BranchTarget>
      tabs={offersPullRequests ? TABS : undefined}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id === "pull-requests" ? "pull-requests" : "branches")}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder={searchPlaceholder(list, onPullRequestTab)}
      items={view.items}
      total={view.total}
      onLoadMore={view.loadMore}
      status={view.status}
      onRetry={view.retry}
      selectedKey={value ? valueKey(value) : undefined}
      renderItem={renderItem}
      footer={!onPullRequestTab && typeof view.status !== "object" ? props.footer : undefined}
      onSelect={onSelect}
    />
  );
}

/** Subscribes to the lists the picker can show and shapes the one on screen. */
function useTargetView(props: BranchTargetPickerProps, query: string, onPullRequestTab: boolean): TargetView {
  const { workspaceId, list } = props;
  const searched = useDebouncedQuery(query);
  const offersPullRequests = list === "branches-and-pull-requests";
  const purpose = list === "worktrees" ? "existing-worktree" : "new-thread";
  // Worktrees are listed from the main checkout. Listed from a thread's own worktree, the server treats that
  // worktree as the context checkout, and its row comes back without the path a pick needs.
  const threadId = list === "worktrees" ? undefined : props.threadId;

  const branches = useBranchTargets({ workspaceId, threadId, purpose, query: searched });
  const pullRequests = usePullRequestTargets(
    offersPullRequests && (onPullRequestTab || searched !== "") ? { workspaceId, query: searched } : null,
  );
  useEffect(() => {
    revalidateBranchTargets({ workspaceId, threadId, purpose });
    if (offersPullRequests) revalidatePullRequestTargets(workspaceId);
  }, [workspaceId, threadId, purpose, offersPullRequests]);

  return useMemo(
    () =>
      onPullRequestTab
        ? listView(pullRequests, "Couldn't list pull requests")
        : branchesView(branches, offersPullRequests && searched !== "" ? pullRequests : null),
    [onPullRequestTab, branches, pullRequests, offersPullRequests, searched],
  );
}

function searchPlaceholder(list: BranchTargetList, onPullRequestTab: boolean): string {
  if (onPullRequestTab) return "Search pull requests";
  return list === "worktrees" ? "Search worktrees" : "Search branches";
}

function listView(list: TargetPageList<BranchTarget, TargetError>, failedCopy: string): TargetView {
  const { status } = list;
  return {
    items: list.items,
    total: list.total,
    status: status.kind === "failed" ? { failed: failedCopy, detail: failureDetail(status.error) } : status.kind,
    loadMore: list.loadMore,
    retry: list.retry,
    grouped: false,
  };
}

/**
 * Branch rows, then the matching pull requests once every branch has loaded, so rows never jump in above the
 * scroll position. A pull request failure here drops the group; the Pull requests tab shows it.
 */
function branchesView(
  branches: TargetPageList<BranchTarget, GitListError | TransportFailure>,
  pullRequests: TargetPageList<BranchTarget, PullRequestError | TransportFailure> | null,
): TargetView {
  const view = listView(branches, "Couldn't list branches");
  const branchTotal = branches.total;
  const exhausted = branchTotal !== null && branches.items.length >= branchTotal;
  if (pullRequests === null || !exhausted || pullRequests.status.kind === "failed") return view;
  const loading = branches.status.kind === "loading" || pullRequests.status.kind === "loading";
  return {
    items: [...branches.items, ...pullRequests.items],
    total: branchTotal + (pullRequests.total ?? 0),
    status: loading ? "loading" : "ready",
    loadMore: pullRequests.loadMore,
    retry: branches.retry,
    grouped: true,
  };
}

function failureDetail(error: TargetError): string {
  return "detail" in error && error.detail ? error.detail : error.message;
}

function valueKey(value: BranchTargetValue): string {
  if (value.kind === "branch") return `b:${value.name}`;
  if (value.kind === "pull-request") return `pr:${value.number}`;
  return worktreeKey(value.path);
}

function worktreeKey(path: string): string {
  return `w:${normalizeWorktreePath(path)}`;
}

function targetRow(target: BranchTarget, list: BranchTargetList, grouped: boolean, reason: string | undefined): PickerRow {
  const availability = { disabled: reason !== undefined, disabledReason: reason };
  if (target.kind === "pull-request") {
    return {
      key: `pr:${target.number}`,
      name: target.title,
      description: <span className="font-mono">#{target.number} · {target.headRefName}</span>,
      ...(grouped ? { group: "pr", groupLabel: "Pull requests" } : {}),
      ...availability,
    };
  }
  if (target.kind === "detached-worktree") {
    return {
      key: worktreeKey(target.worktree.path),
      name: target.worktree.folder,
      mono: true,
      description: <span className="font-mono">{target.headShortSha}</span>,
      ...availability,
    };
  }
  return { ...branchRow(target, list), ...availability };
}

function branchRow(target: Extract<BranchTarget, { kind: "branch" }>, list: BranchTargetList): PickerRow {
  // Existing worktree names the checkout, so its rows lead with the folder and key by path.
  if (list === "worktrees" && target.worktree) {
    return {
      key: worktreeKey(target.worktree.path),
      name: target.worktree.folder,
      mono: true,
      tag: target.isCurrent ? "current" : undefined,
      description: <span className="font-mono">{target.name}</span>,
    };
  }
  return {
    key: `b:${target.name}`,
    name: target.name,
    mono: true,
    tag: target.isCurrent ? "current" : target.worktree ? "worktree" : undefined,
  };
}
