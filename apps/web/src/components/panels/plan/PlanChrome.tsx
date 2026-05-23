import type { PlanRecord } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";

interface PlanChromeProps {
  plan: PlanRecord;
  allVersions: readonly PlanRecord[];
  threadId: string;
  onRevise: () => void;
  onImplement: () => void;
  /** Number of pending inline comments. When > 0, Revise becomes "Send feedback". */
  commentCount: number;
}

/**
 * Sticky chrome bar: version selector, Revise, and Implement actions.
 * Mirrors the Mcode mono-uppercase chrome convention.
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

  const handleVersionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = parseInt(e.target.value, 10);
    setActiveVersion(threadId, v);
  };

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-6 py-2.5">
      <select
        value={plan.version}
        onChange={handleVersionChange}
        className="cursor-pointer border-none bg-transparent font-mono text-[10px] uppercase tracking-[0.1em] text-primary outline-none"
      >
        {allVersions.map((v) => (
          <option key={v.version} value={v.version}>
            v{v.version}{v.changeSummary ? ` - ${v.changeSummary}` : ""}
          </option>
        ))}
      </select>

      <span className="flex-1" />

      <button
        type="button"
        onClick={onRevise}
        className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/55 transition-colors hover:text-foreground bg-transparent border-none cursor-pointer"
      >
        {commentCount > 0 ? `Send feedback (${commentCount})` : "Revise"}
      </button>

      <button
        type="button"
        onClick={onImplement}
        className="font-mono text-[10px] uppercase tracking-[0.1em] text-primary/70 transition-colors hover:text-primary bg-transparent border-none cursor-pointer"
      >
        Implement
      </button>
    </div>
  );
}
