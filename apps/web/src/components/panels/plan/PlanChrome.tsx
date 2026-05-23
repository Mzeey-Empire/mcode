import type { PlanRecord } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface PlanChromeProps {
  plan: PlanRecord;
  allVersions: readonly PlanRecord[];
  threadId: string;
  onRevise: () => void;
  onImplement: () => void;
  commentCount: number;
}

/**
 * Sticky chrome bar pinned above the scrollable plan body.
 * Version navigation uses prev/next arrows instead of a dropdown.
 * Revise and Implement are always visible.
 */
export function PlanChrome({
  plan,
  allVersions,
  threadId,
  onRevise,
  onImplement,
  commentCount,
}: PlanChromeProps) {
  const setActiveVersion = usePlanStore((s) => s.setActiveVersion);
  const maxVersion = allVersions.length > 0 ? allVersions[allVersions.length - 1].version : 1;
  const canPrev = plan.version > 1;
  const canNext = plan.version < maxVersion;

  return (
    <div className="flex items-center gap-1.5 border-b border-border bg-background px-4 py-2 flex-shrink-0">
      {/* Version nav: arrows + badge */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          disabled={!canPrev}
          onClick={() => setActiveVersion(threadId, plan.version - 1)}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:text-foreground disabled:opacity-20 disabled:cursor-default"
          aria-label="Previous version"
        >
          <ChevronLeft className="h-3 w-3" />
        </button>

        <span className="font-mono text-[10px] tabular-nums uppercase tracking-[0.1em] text-primary px-1">
          v{plan.version}
        </span>

        <button
          type="button"
          disabled={!canNext}
          onClick={() => setActiveVersion(threadId, plan.version + 1)}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:text-foreground disabled:opacity-20 disabled:cursor-default"
          aria-label="Next version"
        >
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>

      {/* Change summary for v2+ */}
      {plan.changeSummary && (
        <span className="truncate text-[11px] text-muted-foreground/50 max-w-[140px]">
          {plan.changeSummary}
        </span>
      )}

      <span className="flex-1" />

      {/* Actions */}
      <button
        type="button"
        onClick={onRevise}
        className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/55 transition-colors hover:text-foreground bg-transparent border-none cursor-pointer px-1.5"
      >
        {commentCount > 0 ? `Feedback (${commentCount})` : "Revise"}
      </button>

      <button
        type="button"
        onClick={onImplement}
        className="font-mono text-[10px] uppercase tracking-[0.1em] text-primary/70 transition-colors hover:text-primary bg-transparent border-none cursor-pointer px-1.5"
      >
        Implement
      </button>
    </div>
  );
}
