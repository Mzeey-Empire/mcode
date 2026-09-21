import type { ReviewComparison } from "@mcode/contracts";
import { FileList } from "./FileList";

/** Props for LastTurnView. */
interface LastTurnViewProps {
  threadId: string;
  comparison?: ReviewComparison | null;
  cacheVersion?: string | number;
  refreshing?: boolean;
  onRefresh?: () => void;
}

/**
 * The "Last turn" view: a single diff for the most recent turn that changed
 * files. This is the default glance when a thread is active. It renders exactly
 * one turn's diff — never the whole timeline — so the panel stays fast on long
 * threads. See CONTEXT.md → "Review tab".
 */
export function LastTurnView({ threadId, comparison, cacheVersion, refreshing, onRefresh }: LastTurnViewProps) {
  const comparisonId = comparison?.turnDiff?.id;
  if (!comparisonId || !comparison) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-14">
        <span aria-hidden="true" className="font-mono text-2xl leading-none text-muted-foreground/15">
          ⊘
        </span>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/40">
          No changes yet
        </p>
      </div>
    );
  }

  return (
    <div data-testid="review-last-turn" className="flex h-full min-h-0 flex-col">
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
      />
    </div>
  );
}
