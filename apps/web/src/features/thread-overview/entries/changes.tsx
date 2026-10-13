import { Button } from "@/components/ui/button";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { createOverviewEntryState } from "@/features/thread-overview/overview-entry-state";
import { executeCommand } from "@/lib/command-registry";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { useThreadStore } from "@/stores/threadStore";
import { getTransport, type McodeTransport, type Thread } from "@/transport";
import type { ReviewComparisonResult, TurnSnapshot } from "@mcode/contracts";
import { Diff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoadStatus, OVERVIEW_ROW_CLASS, ThreadOverviewWhen } from "@/features/thread-overview/overview-row";

type SnapshotDiffStat = { filePath: string; additions: number; deletions: number };

type ReviewDiffStat = { additions: number; deletions: number };

type ThreadOverviewChangeSummaryTransport = Pick<
  McodeTransport,
  | "listSnapshots"
  | "getSnapshotDiffStats"
  | "getReviewComparison"
  | "getReviewState"
>;

type LoadedChangeSummary = {
  threadId: string;
  snapshotKey: string;
  revision: number;
  summary: ThreadOverviewChangeSummary;
};

/** Aggregate change totals shown in the Overview popover. */
export interface ThreadOverviewChangeSummary {
  /** Unique changed file count across the snapshots. */
  files: number;
  /** Total added lines across snapshot diff stats. */
  additions: number;
  /** Total removed lines across snapshot diff stats. */
  deletions: number;
}

const EMPTY_CHANGE_SUMMARY: ThreadOverviewChangeSummary = {
  files: 0,
  additions: 0,
  deletions: 0,
};

/** Resolves the displayed change summary after cache identity validation. */
function getLoadedThreadOverviewChangeSummary({
  loaded,
  threadId,
  snapshotKey,
  revision,
  fallback,
}: {
  loaded: LoadedChangeSummary | null;
  threadId: string;
  snapshotKey: string;
  revision: number;
  fallback: ThreadOverviewChangeSummary;
}): ThreadOverviewChangeSummary {
  if (loaded?.threadId !== threadId) return fallback;
  if (loaded.snapshotKey !== snapshotKey || loaded.revision !== revision) return fallback;
  return loaded.summary;
}

function changedFilesLabel(count: number): string {
  if (count === 0) return "No files";
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function snapshotKey(snapshots: readonly Pick<TurnSnapshot, "id">[] | undefined): string {
  return snapshots?.map((snapshot) => snapshot.id).join("|") ?? "";
}

function latestSnapshotWithChanges(
  snapshots: readonly Pick<TurnSnapshot, "id" | "files_changed">[],
): Pick<TurnSnapshot, "id" | "files_changed"> | null {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (snapshot.files_changed.length > 0) return snapshot;
  }
  return null;
}

function summarizeGitChangeStats(
  files: readonly string[],
  stat: ReviewDiffStat,
): ThreadOverviewChangeSummary {
  return {
    files: new Set(files).size,
    additions: stat.additions,
    deletions: stat.deletions,
  };
}

/**
 * A git comparison's summary. Nothing to compare reads as no changes; an
 * oversized comparison reports its file count without line totals; a failed
 * one throws so the row shows an error rather than an empty summary.
 */
function summarizeGitComparison(result: ReviewComparisonResult): ThreadOverviewChangeSummary {
  switch (result.status) {
    case "ready":
      return summarizeGitChangeStats(result.comparison.files.map((file) => file.path), result.comparison);
    case "too-many-files":
      return { files: result.fileCount, additions: 0, deletions: 0 };
    case "unavailable":
      return EMPTY_CHANGE_SUMMARY;
    case "failed":
      throw new Error(result.failure.summary);
  }
}

/**
 * Sums turn snapshot diff stats for the compact thread-level change summary.
 */
export function summarizeThreadChangeStats(
  snapshots: readonly Pick<TurnSnapshot, "files_changed">[],
  perSnapshotStats: readonly (readonly SnapshotDiffStat[])[],
): ThreadOverviewChangeSummary {
  const files = new Set<string>();
  for (const snapshot of snapshots) {
    for (const file of snapshot.files_changed) files.add(file);
  }

  let additions = 0;
  let deletions = 0;
  for (const stats of perSnapshotStats) {
    for (const stat of stats) {
      files.add(stat.filePath);
      additions += stat.additions;
      deletions += stat.deletions;
    }
  }

  return { files: files.size, additions, deletions };
}

/**
 * Returns true when the compact summary should render a visible +/- total.
 */
export function hasVisibleThreadOverviewChangeSummary(
  summary: ThreadOverviewChangeSummary,
): boolean {
  return summary.additions > 0 || summary.deletions > 0;
}

/**
 * Resolves the Overview Changes row summary from the same priority as the
 * Review default: latest turn, then uncommitted worktree, then branch comparison.
 */
export async function resolveThreadOverviewChangeSummary({
  thread,
  snapshots,
  transport,
}: {
  thread: Pick<Thread, "id" | "workspace_id">;
  snapshots?: readonly TurnSnapshot[];
  transport: ThreadOverviewChangeSummaryTransport;
}): Promise<{ snapshots: TurnSnapshot[]; summary: ThreadOverviewChangeSummary }> {
  const resolvedSnapshots = snapshots
    ? [...snapshots]
    : await transport.listSnapshots(thread.id).catch(() => []);
  const latest = latestSnapshotWithChanges(resolvedSnapshots);

  if (latest) {
    const result = await transport.getSnapshotDiffStats(latest.id);
    if (!Array.isArray(result) && result.status === "failed") throw new Error(result.failure.summary);
    // An expired or pruned snapshot still counts its recorded files, without line totals.
    const stats = Array.isArray(result) ? result : [];
    return {
      snapshots: resolvedSnapshots,
      summary: summarizeThreadChangeStats([latest], [stats]),
    };
  }

  const working = await transport.getReviewComparison({
    workspaceId: thread.workspace_id, view: "uncommitted", threadId: thread.id,
  });
  const workingSummary = summarizeGitComparison(working);
  if (workingSummary.files > 0) return { snapshots: resolvedSnapshots, summary: workingSummary };
  const state = await transport.getReviewState(thread.workspace_id, thread.id);
  if (!state.isGitRepo || !("compare" in state.branchDefault)) {
    return { snapshots: resolvedSnapshots, summary: EMPTY_CHANGE_SUMMARY };
  }
  const comparison = await transport.getReviewComparison({
    workspaceId: thread.workspace_id,
    view: "branch",
    base: state.branchDefault.base,
    compare: state.branchDefault.compare,
    threadId: thread.id,
  });
  return {
    snapshots: resolvedSnapshots,
    summary: summarizeGitComparison(comparison),
  };
}

function hasCurrentThreadOverviewChangeSummary(
  loaded: LoadedChangeSummary | null,
  threadId: string,
  snapshotKey: string,
  revision: number,
): boolean {
  return loaded?.threadId === threadId
    && loaded.snapshotKey === snapshotKey
    && loaded.revision === revision;
}

const SETTLED_RESOLVE_DEBOUNCE_MS = 300;

function selectDisplayedChangeSummary({
  isRunning,
  live,
  loaded,
  hasCurrentLoaded,
  fallback,
}: {
  isRunning: boolean;
  live: ThreadOverviewChangeSummary;
  loaded: ThreadOverviewChangeSummary;
  hasCurrentLoaded: boolean;
  fallback: ThreadOverviewChangeSummary;
}): ThreadOverviewChangeSummary {
  if (isRunning) return live;
  if (hasCurrentLoaded) return loaded;
  if (hasVisibleThreadOverviewChangeSummary(live)) return live;
  return fallback;
}

function useChangesState(thread: Thread) {
  const { open } = useOverviewContext();
  const isRunning = useThreadStore((s) => s.runningThreadIds.has(thread.id));
  const liveChangeSummary = useThreadRecord(thread.id, (record) => ({
    files: record.fileEffectSummary.fileCount,
    additions: record.fileEffectSummary.additions,
    deletions: record.fileEffectSummary.deletions,
  }));
  const [loadedChangeSummary, setLoadedChangeSummary] = useState<LoadedChangeSummary | null>(null);
  const [changeSummaryStatus, setChangeSummaryStatus] = useState<LoadStatus>("idle");
  const stayedOpenRef = useRef(false);
  const cachedSnapshots = useDiffStore((s) => s.snapshotsByThread[thread.id]);
  const setSnapshots = useDiffStore((s) => s.setSnapshots);
  const diffRevision = useDiffStore((s) => s.diffRevisionByScope[thread.id] ?? 0);
  const cachedSnapshotKey = useMemo(() => snapshotKey(cachedSnapshots), [cachedSnapshots]);
  const fallbackChangeSummary = useMemo(
    () => {
      const latest = latestSnapshotWithChanges(cachedSnapshots ?? []);
      return latest ? summarizeThreadChangeStats([latest], []) : EMPTY_CHANGE_SUMMARY;
    },
    [cachedSnapshots],
  );
  const hasCurrentChangeSummary = hasCurrentThreadOverviewChangeSummary(
    loadedChangeSummary,
    thread.id,
    cachedSnapshotKey,
    diffRevision,
  );
  const changeSummary = selectDisplayedChangeSummary({
    isRunning,
    live: liveChangeSummary,
    loaded: getLoadedThreadOverviewChangeSummary({
      loaded: loadedChangeSummary,
      threadId: thread.id,
      snapshotKey: cachedSnapshotKey,
      revision: diffRevision,
      fallback: fallbackChangeSummary,
    }),
    hasCurrentLoaded: hasCurrentChangeSummary,
    fallback: fallbackChangeSummary,
  });
  const showChangeSummary = hasVisibleThreadOverviewChangeSummary(changeSummary);
  // Renames, binary edits and empty files change files without changing line totals.
  const hasChanges = showChangeSummary || changeSummary.files > 0;
  const isSettledResolvePending = !isRunning && !hasCurrentChangeSummary;
  const isChangeSummaryLoading = open && isSettledResolvePending && !showChangeSummary
    && changeSummaryStatus !== "error";
  // The fallback summary has no line totals, so a failed load must say so rather than show nothing.
  const isChangeSummaryFailed = isSettledResolvePending && changeSummaryStatus === "error";
  useEffect(() => {
    if (!open) {
      stayedOpenRef.current = false;
      return;
    }
    const stayedOpen = stayedOpenRef.current;
    stayedOpenRef.current = true;
    // A running turn bumps the diff revision on every file write; its live file effects cover the row.
    if (isRunning) return;
    // Opening the card refreshes; later runs at the same revision come from this effect's own cache write.
    if (stayedOpen && hasCurrentChangeSummary) return;

    let cancelled = false;
    const loadChangeSummary = async () => {
      try {
        const result = await resolveThreadOverviewChangeSummary({
          thread: { id: thread.id, workspace_id: thread.workspace_id },
          snapshots: cachedSnapshots,
          transport: getTransport(),
        });
        if (cancelled) return;
        if (!cachedSnapshots) setSnapshots(thread.id, result.snapshots);

        setLoadedChangeSummary({
          threadId: thread.id,
          snapshotKey: snapshotKey(result.snapshots),
          revision: diffRevision,
          summary: result.summary,
        });
        setChangeSummaryStatus("ready");
      } catch {
        if (!cancelled) setChangeSummaryStatus("error");
      }
    };

    const timer = setTimeout(() => void loadChangeSummary(), stayedOpen ? SETTLED_RESOLVE_DEBOUNCE_MS : 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    cachedSnapshotKey, cachedSnapshots, diffRevision, hasCurrentChangeSummary, isRunning, open, setSnapshots,
    thread.id, thread.workspace_id,
  ]);
  return { changeSummary, hasChanges, isChangeSummaryFailed, isChangeSummaryLoading, showChangeSummary };
}

/** Preserves the loaded summary and its status while the overview is closed. */
export const { Provider: ChangesEntryState, useEntryState: useChangesEntryState } = createOverviewEntryState(useChangesState);

function ChangesEntry() {
  const { changeSummary, hasChanges, isChangeSummaryFailed, isChangeSummaryLoading, showChangeSummary } =
    useChangesEntryState();
  const openChanges = useCallback(() => {
    executeCommand("changes.toggle");
  }, []);
  return (<ThreadOverviewWhen when={isChangeSummaryLoading || isChangeSummaryFailed || hasChanges}>
    <Button
      variant="ghost"
      size="compact"
      onClick={openChanges}
      data-testid="workspace-menu-changes"
      aria-label={`Changes, ${changedFilesLabel(changeSummary.files)}`}
      className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-between gap-2")}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <Diff
          size={16}
          strokeWidth={1.5}
          className="text-muted transition-colors duration-150 group-hover:text-ink/80"
        />
      </span>
      <span className="text-fade min-w-0 grow text-sm text-ink">Changes</span>
      <ThreadOverviewWhen when={isChangeSummaryLoading}>
        <span
          data-testid="thread-overview-change-loading"
          aria-label="Loading changes"
          className="animate-thread-overview-loading h-3 w-14 shrink-0 overflow-hidden rounded-sm bg-hover/45"
        />
      </ThreadOverviewWhen>
      <ThreadOverviewWhen when={isChangeSummaryFailed}>
        <span data-testid="thread-overview-change-failed" className="shrink-0 text-xs text-muted">
          Unavailable
        </span>
      </ThreadOverviewWhen>
      <ThreadOverviewWhen when={!isChangeSummaryLoading && !isChangeSummaryFailed && showChangeSummary}>
        <span
          data-testid="thread-overview-change-summary"
          aria-label={`${changeSummary.additions} additions, ${changeSummary.deletions} deletions`}
          className="shrink-0 text-xs tabular-nums text-muted"
        >
          {`+${changeSummary.additions} −${changeSummary.deletions}`}
        </span>
      </ThreadOverviewWhen>
    </Button>
  </ThreadOverviewWhen>);
}

/** Changes block in the thread overview, preserving its existing row position. */
export function ChangesEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <ChangesEntry /> : null;
}
