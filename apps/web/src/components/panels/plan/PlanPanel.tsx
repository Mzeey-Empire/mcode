import { useMemo } from "react";
import { usePlanStore } from "@/stores/planStore";
import { PlanChrome } from "./PlanChrome";
import { PlanDocument } from "./PlanDocument";
import { PlanSkeleton } from "./PlanSkeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { PlanRecord } from "@mcode/contracts";

/** Stable empty array to avoid new-reference-per-render in Zustand selectors. */
const EMPTY_PLANS: readonly PlanRecord[] = [];

interface PlanPanelProps {
  threadId: string;
}

/**
 * Plan section of the Tasks tab. Renders the plan document above the task
 * list. Returns null when no plan exists so the task list fills the tab.
 */
export function PlanPanel({ threadId }: PlanPanelProps) {
  const plans = usePlanStore((s) => s.plansByThread[threadId] ?? EMPTY_PLANS);
  const activeVersion = usePlanStore((s) => s.activeVersionByThread[threadId] ?? null);
  const isGenerating = usePlanStore((s) => s.generatingThreads.has(threadId));

  const activePlan = useMemo(() => {
    if (plans.length === 0) return null;
    if (activeVersion !== null) {
      return plans.find((p) => p.version === activeVersion) ?? plans[plans.length - 1];
    }
    return [...plans].reverse().find((p) => p.status !== "superseded") ?? plans[plans.length - 1];
  }, [plans, activeVersion]);

  if (isGenerating) {
    return <PlanSkeleton title={activePlan?.title} />;
  }

  // No plan for this thread - render nothing so tasks fill the tab
  if (!activePlan) return null;

  return (
    <ScrollArea className="flex-1 min-h-0">
      <PlanChrome plan={activePlan} allVersions={plans} threadId={threadId} />
      <h1 className="px-6 pt-4 text-[17px] font-bold leading-[1.35]">
        {activePlan.title}
      </h1>
      <div className="mx-6 mt-4 h-px bg-border" />
      <PlanDocument plan={activePlan} />
    </ScrollArea>
  );
}
