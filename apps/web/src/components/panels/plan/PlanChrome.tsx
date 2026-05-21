import type { PlanRecord } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";

interface PlanChromeProps {
  plan: PlanRecord;
  allVersions: readonly PlanRecord[];
  threadId: string;
}

/**
 * Sticky chrome bar: version selector, status badge, and implement link.
 * Mirrors the Mcode mono-uppercase chrome convention.
 */
export function PlanChrome({ plan, allVersions, threadId }: PlanChromeProps) {
  const setActiveVersion = usePlanStore((s) => s.setActiveVersion);
  const updatePlanStatus = usePlanStore((s) => s.updatePlanStatus);

  const handleVersionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = parseInt(e.target.value, 10);
    setActiveVersion(threadId, v);
  };

  const handleImplement = () => {
    updatePlanStatus(plan.id, "accepted");
    // TODO: Wire plan.updateStatus RPC and sendMessage in follow-up
  };

  return (
    <div className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-border bg-background px-6 py-3">
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

      <span
        className={`font-mono text-[10px] uppercase tracking-[0.1em] ${
          plan.status === "accepted"
            ? "text-[oklch(0.48_0.14_145)]"
            : "text-muted-foreground"
        }`}
      >
        {plan.status}
      </span>

      <span className="flex-1" />

      {plan.status === "draft" && (
        <button
          onClick={handleImplement}
          className="cursor-pointer border-none bg-transparent font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:text-primary"
        >
          Implement
        </button>
      )}
    </div>
  );
}
