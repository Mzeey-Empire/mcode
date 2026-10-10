import { Button } from "@/components/ui/button";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { usePlanStore } from "@/stores/planStore";
import { type Thread } from "@/transport";
import type { PlanVersion } from "@mcode/contracts";
import { ListChecks } from "lucide-react";
import { useCallback, useMemo } from "react";
import { OVERVIEW_ROW_CLASS, ThreadOverviewWhen } from "@/features/thread-overview/overview-row";

/** Stable empty plans reference so closed Overview selectors never allocate. */
const EMPTY_PLANS: readonly PlanVersion[] = [];

function PlansEntry({ thread }: { thread: Thread }) {

  const plans = usePlanStore((s) => s.plansByThread[thread.id] ?? EMPTY_PLANS);
  const latestPlan = useMemo(() => {
    if (plans.length === 0) return null;
    return [...plans].reverse().find((plan) => plan.status !== "superseded") ?? null;
  }, [plans]);
  const openLatestPlan = useCallback(() => {
    if (!latestPlan) return;
    usePlanStore.getState().setActiveVersion(thread.id, latestPlan.version);
    showRightPanelAdaptive(thread.workspace_id, thread.id);
    useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "tasks");
  }, [latestPlan, thread.id, thread.workspace_id]);
  return (<ThreadOverviewWhen when={latestPlan !== null}>
    <Button
      variant="ghost"
      size="compact"
      type="button"
      data-testid="thread-overview-plan"
      onClick={openLatestPlan}
      aria-label={`Plan, ${latestPlan?.title}`}
      className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-between")}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ListChecks
          size={14}
          className="shrink-0 text-muted transition-colors duration-150 group-hover:text-ink/80"
        />
        <span className="text-fade text-xs font-medium">Plans</span>
      </span>
      <span className="min-w-0 max-w-[11rem] text-fade text-xs text-muted">
        {latestPlan?.title}
      </span>
    </Button>
  </ThreadOverviewWhen>);
}

/** Plans block in the thread overview, preserving its existing row position. */
export function PlansEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <PlansEntry thread={subject.thread} /> : null;
}
