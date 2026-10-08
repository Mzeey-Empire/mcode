import { Button } from "@/components/ui/button";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useOverviewContext } from "@/features/thread-overview/overview-state";
import { executeCommand } from "@/lib/command-registry";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport, type McodeTransport, type Thread } from "@/transport";
import type { TurnSnapshot } from "@mcode/contracts";
import { Diff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LoadStatus, OVERVIEW_ROW_CLASS, ThreadOverviewWhen } from "@/features/thread-overview/overview-row";

type SnapshotDiffStat = { filePath: string; additions: number; deletions: number };

type ReviewDiffStat = { additions: number; deletions: number };

type ThreadOverviewChangeSummaryTransport = Pick<
  McodeTransport,
  | "listSnapshots"
  | "getSnapshotDiffStats"
  | "getWorkingTreeFiles"
  | "getBranchComparison"
  | "getBranchFiles"
  | "getReviewDiffStats"
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

const EMPTY_REVIEW_DIFF_STAT: ReviewDiffStat = {
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
 * Review default: latest turn, then unstaged worktree, then branch comparison.
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
    const stats = await transport.getSnapshotDiffStats(latest.id).catch(() => []);
    return {
      snapshots: resolvedSnapshots,
      summary: summarizeThreadChangeStats([latest], [stats]),
    };
  }

  const unstagedFiles = await transport
    .getWorkingTreeFiles(thread.workspace_id, false, thread.id)
    .catch(() => []);
  if (unstagedFiles.length > 0) {
    const stat = await transport
      .getReviewDiffStats({
        workspaceId: thread.workspace_id,
        view: "unstaged",
        threadId: thread.id,
      })
      .catch(() => EMPTY_REVIEW_DIFF_STAT);
    return {
      snapshots: resolvedSnapshots,
      summary: summarizeGitChangeStats(unstagedFiles, stat),
    };
  }

  const comparison = await transport
    .getBranchComparison(thread.workspace_id, thread.id)
    .catch(() => null);
  if (
    !comparison ||
    comparison.isUnborn ||
    comparison.isComparisonAvailable === false ||
    !comparison.base ||
    !comparison.target
  ) {
    return { snapshots: resolvedSnapshots, summary: EMPTY_CHANGE_SUMMARY };
  }

  const [files, stat] = await Promise.all([
    transport
      .getBranchFiles(thread.workspace_id, comparison.base, comparison.target, thread.id)
      .catch(() => []),
    transport
      .getReviewDiffStats({
        workspaceId: thread.workspace_id,
        view: "branch",
        base: comparison.base,
        target: comparison.target,
        threadId: thread.id,
      })
      .catch(() => EMPTY_REVIEW_DIFF_STAT),
  ]);

  return {
    snapshots: resolvedSnapshots,
    summary: summarizeGitChangeStats(files, stat),
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

function ChangesEntry({ thread }: { thread: Thread }) {
  const { open } = useOverviewContext();
  const [loadedChangeSummary, setLoadedChangeSummary] = useState<LoadedChangeSummary | null>(null);
  const [changeSummaryStatus, setChangeSummaryStatus] = useState<LoadStatus>("idle");
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
  const changeSummary = getLoadedThreadOverviewChangeSummary({
    loaded: loadedChangeSummary,
    threadId: thread.id,
    snapshotKey: cachedSnapshotKey,
    revision: diffRevision,
    fallback: fallbackChangeSummary,
  });
  const showChangeSummary = hasVisibleThreadOverviewChangeSummary(changeSummary);
  const hasCurrentChangeSummary = hasCurrentThreadOverviewChangeSummary(
    loadedChangeSummary,
    thread.id,
    cachedSnapshotKey,
    diffRevision,
  );
  const isChangeSummaryLoading = open && !hasCurrentChangeSummary && changeSummaryStatus !== "error";
  useEffect(() => {
    if (!open) return;

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

    void loadChangeSummary();

    return () => {
      cancelled = true;
    };
  }, [cachedSnapshotKey, cachedSnapshots, diffRevision, open, setSnapshots, thread.id, thread.workspace_id]);
  const openChanges = useCallback(() => {
    executeCommand("changes.toggle");
  }, []);
  return (<Button
    variant="ghost"
    size="sm"
    onClick={openChanges}
    data-testid="workspace-menu-changes"
    aria-label={`Changes, ${changedFilesLabel(changeSummary.files)}`}
    className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-between")}
  >
    <span className="flex min-w-0 items-center gap-2">
      <Diff
        size={14}
        className="shrink-0 text-muted transition-colors duration-150 group-hover:text-ink/80"
      />
      <span className="text-fade text-xs font-medium">Changes</span>
    </span>
    <ThreadOverviewWhen when={isChangeSummaryLoading}>
      <span
        data-testid="thread-overview-change-loading"
        aria-label="Loading changes"
        className="animate-thread-overview-loading h-3 w-14 shrink-0 overflow-hidden rounded-sm bg-hover/45"
      />
    </ThreadOverviewWhen>
    <ThreadOverviewWhen when={!isChangeSummaryLoading && showChangeSummary}>
      <span
        data-testid="thread-overview-change-summary"
        aria-label={`${changeSummary.additions} additions, ${changeSummary.deletions} deletions`}
        className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums"
      >
        <span className="text-[var(--diff-add-strong)]">
          +{changeSummary.additions}
        </span>
        <span className="text-[var(--diff-remove-strong)]">
          -{changeSummary.deletions}
        </span>
      </span>
    </ThreadOverviewWhen>
  </Button>);
}

/** Changes block in the thread overview, preserving its existing row position. */
export function ChangesEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <ChangesEntry thread={subject.thread} /> : null;
}
