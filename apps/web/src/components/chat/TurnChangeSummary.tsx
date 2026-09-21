import { useState, useCallback, useEffect, useId, useMemo } from "react";
import { ChevronRight, FileText, ExternalLink, Folder } from "lucide-react";
import type { DiffStats } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDiffStore } from "@/stores/diffStore";
import { readThreadRecord } from "@/stores/thread-selectors";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { getTransport } from "@/transport";
import { diffCardSurfaceClass } from "@/components/diff/diff-surface";
import { DiffStat } from "@/components/diff/DiffStat";
import { CHANGE_TYPE_GLYPHS, CHANGE_TYPE_LABELS, changeTypeTone } from "@/components/diff/change-type";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";

/** Props for TurnChangeSummary. */
interface TurnChangeSummaryProps {
  messageId: string;
  filesChanged: string[];
  isLatestTurn: boolean;
  /** Ref-stable map of messageId -> manual expanded override, survives virtualizer remounts. */
  manualExpandRef?: React.RefObject<Map<string, boolean>>;
}

/** Cap displayed files to avoid DOM bloat on massive turns. */
const MAX_DISPLAYED_FILES = 5;

/** Git reports diff stats with `/` separators; snapshot file lists may carry `\`. */
const normalizeSlashes = (p: string) => p.replace(/\\/g, "/");

/** One directory in the changed-file tree; single-child chains are compressed into the label. */
interface FileTreeDir {
  /** Compressed path label, e.g. "server/src" for a folder chain with no branching. */
  label: string;
  dirs: FileTreeDir[];
  /** Full file paths sitting directly in this directory. */
  files: string[];
}

/**
 * Build a directory tree from changed paths. Folders that contain only a
 * single subfolder and no files fold into it ("a/b/c" renders as one header),
 * which keeps deep paths readable without flattening the hierarchy.
 */
function buildFileTree(paths: readonly string[]): { rootFiles: string[]; dirs: FileTreeDir[] } {
  interface MutableDir {
    label: string;
    dirs: Map<string, MutableDir>;
    files: string[];
  }
  const root: MutableDir = { label: "", dirs: new Map(), files: [] };
  for (const path of paths) {
    let node = root;
    for (const seg of path.split(/[\\/]/).slice(0, -1)) {
      let next = node.dirs.get(seg);
      if (!next) {
        next = { label: seg, dirs: new Map(), files: [] };
        node.dirs.set(seg, next);
      }
      node = next;
    }
    node.files.push(path);
  }
  const finish = (node: MutableDir): FileTreeDir => {
    let label = node.label;
    let cur = node;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const [seg, child] = [...cur.dirs.entries()][0]!;
      label = `${label}/${seg}`;
      cur = child;
    }
    const dirs = [...cur.dirs.values()].map(finish).sort((a, b) => a.label.localeCompare(b.label));
    return { label, dirs, files: cur.files };
  };
  const dirs = [...root.dirs.values()].map(finish).sort((a, b) => a.label.localeCompare(b.label));
  return { rootFiles: root.files, dirs };
}

/**
 * Inline banner showing files changed in an agent turn.
 * Collapsed: single-line bar with file count and expand chevron.
 * Expanded: file list with type icon, change status, and per-file diff stats.
 */
export function TurnChangeSummary({ messageId, filesChanged, isLatestTurn, manualExpandRef }: TurnChangeSummaryProps) {
  // Restore manual override from ref if the virtualizer remounted this component
  const manualOverride = manualExpandRef?.current?.get(messageId);
  const contentId = useId();
  const [expanded, setExpanded] = useState(manualOverride ?? isLatestTurn);
  const [diffStats, setDiffStats] = useState<Map<string, DiffStats> | null>(null);
  const fileCount = filesChanged.length;
  const hiddenCount = Math.max(0, fileCount - MAX_DISPLAYED_FILES);

  // Group rows under a nested folder tree so paths read as structure, not
  // noise: root files first, then directory sections sorted A-Z.
  const { rootFiles, dirs } = useMemo(
    () => buildFileTree(filesChanged.slice(0, MAX_DISPLAYED_FILES)),
    [filesChanged],
  );

  // Aggregate stats land after the async fetch; the header shows them only
  // when every displayed file resolved so partial totals never mislead.
  const totals = useMemo(() => {
    if (!diffStats) return null;
    let additions = 0;
    let deletions = 0;
    for (const path of filesChanged) {
      const stat = diffStats.get(normalizeSlashes(path));
      if (!stat) return null;
      additions += stat.additions;
      deletions += stat.deletions;
    }
    return { additions, deletions };
  }, [diffStats, filesChanged]);

  // Sync expanded state when isLatestTurn changes (auto-collapse older turns).
  // Prefer any stored manual override; only fall back to isLatestTurn when the
  // user hasn't explicitly toggled this banner.
  useEffect(() => {
    const override = manualExpandRef?.current?.get(messageId);
    setExpanded(override ?? isLatestTurn);
  }, [isLatestTurn, messageId, manualExpandRef]);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      manualExpandRef?.current?.set(messageId, next);
      return next;
    });
  }, [messageId, manualExpandRef]);

  // Fetch per-file diff stats when the banner is expanded
  useEffect(() => {
    if (!expanded || diffStats !== null) return;

    void (async () => {
      try {
        const threadId = useWorkspaceStore.getState().activeThreadId;
        if (!threadId) return;

        const serverMsgId = readThreadRecord(threadId).serverMessageIds[messageId] ?? messageId;

        // Resolve snapshot: load from server if not cached in diffStore
        let snapshots = useDiffStore.getState().snapshotsByThread[threadId];
        if (!snapshots) {
          snapshots = await getTransport().listSnapshots(threadId);
          useDiffStore.getState().setSnapshots(threadId, snapshots);
        }
        const snapshot = snapshots.find((s) => s.message_id === serverMsgId);
        if (!snapshot) return;

        const stats = await getTransport().getSnapshotDiffStats(snapshot.id);
        setDiffStats(new Map(stats.map((s) => [normalizeSlashes(s.filePath), s])));
      } catch {
        // Best-effort: stats are decorative, don't block the file list
      }
    })();
  }, [expanded, diffStats, messageId]);

  /** Open the diff panel focused on the Changes tab showing this turn's changes. */
  const openReviewPanel = useCallback(async () => {
    const { activeThreadId: threadId, activeWorkspaceId: workspaceId } =
      useWorkspaceStore.getState();
    if (!threadId || !workspaceId) return null;

    const store = useDiffStore.getState();
    showRightPanelAdaptive(workspaceId, threadId);
    store.setRightPanelTab(workspaceId, threadId, "changes");
    // Pin cumulative as the per-thread override so the live default cannot revert
    // this deliberate pick (ADR-0011).
    store.setReviewViewForThread(threadId, "cumulative");

    // Ensure snapshots are loaded so the panel can display this turn
    if (!store.snapshotsByThread[threadId]) {
      try {
        const snapshots = await getTransport().listSnapshots(threadId);
        useDiffStore.getState().setSnapshots(threadId, snapshots);
      } catch (err) {
        console.warn("[TurnChangeSummary] Failed to load snapshots:", err);
      }
    }
    return threadId;
  }, []);

  const handleViewAllDiffs = useCallback(() => {
    void openReviewPanel();
  }, [openReviewPanel]);

  /** Open the Changes tab and scroll the comparison to this file. */
  const handleJumpToFile = useCallback((filePath: string) => {
    void openReviewPanel().then((threadId) => {
      if (threadId) useDiffStore.getState().requestReviewFileJump(threadId, filePath);
    });
  }, [openReviewPanel]);

  return (
    <div className="my-1">
      <div className={diffCardSurfaceClass()}>
        {/* Header row: toggle and "View All Diffs" are siblings to avoid nested buttons */}
        <div className="flex w-full items-center justify-between px-2.5 py-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={handleToggle}
            aria-expanded={expanded}
            aria-controls={expanded ? contentId : undefined}
            className="flex min-w-0 items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground/80"
          >
            <ChevronRight
              aria-hidden="true"
              size={12}
              className={`shrink-0 text-muted-foreground/55 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
            <FileText size={13} className="shrink-0 text-muted-foreground/60" />
            <span className="font-medium text-foreground/80">
              {fileCount} file{fileCount !== 1 ? "s" : ""} changed
            </span>
          </button>
          <span className="flex shrink-0 items-center gap-3">
            <SummaryTotals totals={totals} />
            <Button
              variant="outline"
              size="xs"
              onClick={handleViewAllDiffs}
              className="gap-1 border-border/60 text-muted-foreground/80 shadow-none hover:text-foreground"
            >
              View all diffs
              <ExternalLink size={10} />
            </Button>
          </span>
        </div>

        {/* File list: only rendered when expanded */}
        {expanded && (
          <div id={contentId} className="border-t border-border/40 px-1 pb-1 pt-0.5">
            <ChangedFileList
              rootFiles={rootFiles}
              dirs={dirs}
              hiddenCount={hiddenCount}
              diffStats={diffStats}
              onJump={handleJumpToFile}
              onViewAll={handleViewAllDiffs}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** Aggregate "+A | −D" shown in the header once every file's stats resolve. */
function SummaryTotals({ totals }: { readonly totals: { additions: number; deletions: number } | null }) {
  if (!totals) return null;
  return (
    <span className="font-mono text-[11px] tabular-nums">
      {totals.additions > 0 && (
        <span className="text-[var(--diff-add-strong)]">+{totals.additions}</span>
      )}
      {totals.additions > 0 && totals.deletions > 0 && (
        <span className="px-1 text-muted-foreground/40">|</span>
      )}
      {totals.deletions > 0 && (
        <span className="text-[var(--diff-remove-strong)]">−{totals.deletions}</span>
      )}
    </span>
  );
}

/** Props for the expanded, folder-grouped changed-file list. */
interface ChangedFileListProps {
  readonly rootFiles: string[];
  readonly dirs: readonly FileTreeDir[];
  readonly hiddenCount: number;
  readonly diffStats: Map<string, DiffStats> | null;
  readonly onJump: (filePath: string) => void;
  readonly onViewAll: () => void;
}

/** Root files first, then a collapsible directory tree. */
function ChangedFileList({ rootFiles, dirs, hiddenCount, diffStats, onJump, onViewAll }: ChangedFileListProps) {
  return (
    <>
      {rootFiles.length > 0 && (
        <div className="divide-y divide-border/30">
          {rootFiles.map((filePath) => (
            <ChangedFileRow
              key={filePath}
              filePath={filePath}
              stat={diffStats?.get(normalizeSlashes(filePath))}
              onJump={onJump}
            />
          ))}
        </div>
      )}
      {dirs.map((dir) => (
        <DirNode key={dir.label} dir={dir} diffStats={diffStats} onJump={onJump} />
      ))}
      {hiddenCount > 0 && (
        <Button
          variant="ghost"
          size="xs"
          onClick={onViewAll}
          className="mt-0.5 w-full justify-center text-muted-foreground/60 hover:text-foreground/80"
        >
          +{hiddenCount} more file{hiddenCount !== 1 ? "s" : ""}
        </Button>
      )}
    </>
  );
}

/** One collapsible folder in the changed-file tree. */
function DirNode({ dir, diffStats, onJump }: { dir: FileTreeDir; diffStats: Map<string, DiffStats> | null; onJump: (filePath: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground/80"
      >
        <ChevronRight
          aria-hidden
          size={10}
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Folder size={11} aria-hidden className="shrink-0" />
        {dir.label}
      </button>
      {open && (
        <div className="ml-[15px] border-l border-border/50 pl-1.5">
          {dir.dirs.map((child) => (
            <DirNode key={child.label} dir={child} diffStats={diffStats} onJump={onJump} />
          ))}
          {dir.files.length > 0 && (
            <div className="divide-y divide-border/30">
              {dir.files.map((filePath) => (
                <ChangedFileRow
                  key={filePath}
                  filePath={filePath}
                  stat={diffStats?.get(normalizeSlashes(filePath))}
                  onJump={onJump}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Props for one row in the changed-file list. */
interface ChangedFileRowProps {
  filePath: string;
  stat: DiffStats | undefined;
  onJump: (filePath: string) => void;
}

/** One changed file: type icon, name, change glyph, and line stats. */
function ChangedFileRow({ filePath, stat, onJump }: ChangedFileRowProps) {
  const name = basename(filePath);
  const changeType = stat?.changeType ?? "modified";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => onJump(filePath)}
            aria-label={`${CHANGE_TYPE_LABELS[changeType]} ${filePath}`}
            className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-xs transition-colors hover:bg-muted/40"
          >
            <span className="flex min-w-0 items-center gap-2 overflow-hidden">
              <FileTypeIcon filePath={filePath} size={14} className="shrink-0" />
              <span className="font-medium text-foreground/80 truncate">{name}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {stat && (
                <DiffStat additions={stat.additions} deletions={stat.deletions} zeroDash />
              )}
              <span
                data-change-type={changeType}
                aria-hidden
                className={cn("w-3 text-center font-mono text-[10px] font-medium", changeTypeTone(changeType))}
              >
                {CHANGE_TYPE_GLYPHS[changeType]}
              </span>
            </span>
          </button>
        }
      />
      <TooltipContent>{`${CHANGE_TYPE_LABELS[changeType]} · ${filePath}`}</TooltipContent>
    </Tooltip>
  );
}
