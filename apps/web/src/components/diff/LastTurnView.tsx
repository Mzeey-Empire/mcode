import type { ReviewComparison } from "@mcode/contracts";
import { FileList } from "./FileList";
import { Badge } from "@/components/ui/badge";

/** Props for LastTurnView. */
interface LastTurnViewProps {
  threadId: string;
  comparison: ReviewComparison;
  cacheVersion: string | number;
  refreshing: boolean;
  onRefresh: () => void;
  /** View identity for consuming view-keyed file-jump requests (see FileList). */
  jumpViewKey?: string;
}

/**
 * Renders exactly one turn's diff — never the whole timeline — so the panel
 * stays fast on long threads. Serves the "Last turn" view (the most recent
 * turn that changed files, the default glance for an active thread) and the
 * "Turn" view (one picked turn). See CONTEXT.md → "Review tab".
 */
export function LastTurnView({ threadId, comparison, cacheVersion, refreshing, onRefresh, jumpViewKey }: LastTurnViewProps) {
  // A ready turn comparison always carries its turn-diff id; without one there are no patches to read.
  const comparisonId = comparison.turnDiff?.id;
  if (!comparisonId) return null;

  return (
    <div data-testid="review-last-turn" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/15">
        <span className="font-mono text-caption tabular-nums text-ink/70">
          {comparison.files.length}
        </span>
        <span className="font-mono text-caption uppercase tracking-[0.14em] text-muted">
          {turnLabel(comparison)}
        </span>
        <TurnDiffSource comparison={comparison} />
      </div>
      <FileList
        files={comparison.files}
        source="turn-diff"
        id={comparisonId}
        threadId={threadId}
        cacheVersion={cacheVersion}
        defaultFilesExpanded
        refreshable
        refreshing={refreshing}
        onRefresh={onRefresh}
        jumpViewKey={jumpViewKey}
      />
    </div>
  );
}

function turnLabel(comparison: ReviewComparison): string {
  const files = comparison.files.length === 1 ? "file" : "files";
  const phase = comparison.turnDiff?.phase === "live" ? "Live" : "last turn";
  return `${files} · ${phase}`;
}

function TurnDiffSource({ comparison }: { comparison: ReviewComparison }) {
  if (!comparison.turnDiff) return null;
  return <Badge
    variant="secondary"
    data-testid="review-turn-source"
    data-review-source={comparison.turnDiff.source}
    data-review-fidelity={comparison.turnDiff.fidelity}
  >
    {comparison.turnDiff.source === "git" ? "Git fallback: same-file edits may appear" : comparison.turnDiff.source === "tracked" ? "Tracked file evidence" : "Agent changes"}
  </Badge>;
}
