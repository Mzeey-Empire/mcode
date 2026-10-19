import { FileText } from "lucide-react";
import { useCallback } from "react";
import type { PlanVersion } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { OVERVIEW_ROW_CLASS } from "@/features/thread-overview/overview-row";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { threadOverviewKey, useOverviewStore } from "@/stores/overviewStore";
import { usePlanStore } from "@/stores/planStore";
import { selectTaskProgress, type TaskProgress, useTaskStore } from "@/stores/taskStore";
import { type Thread } from "@/transport";

// The plan whose Implement turn owns the task list stays on the row after a
// newer draft supersedes it, so its progress is not lost.
function selectRowPlan(versions: readonly PlanVersion[] | undefined, sourceMessageId: string | null): PlanVersion | undefined {
  const implemented = sourceMessageId === null ? undefined : versions?.find((plan) => plan.acceptedMessageId === sourceMessageId);
  return implemented ?? versions?.at(-1);
}

function rowLabel(plan: PlanVersion, progress: TaskProgress | null): string {
  const label = `Open plan ${plan.title}, version ${plan.version}`;
  return progress ? `${label}, ${progress.settled} of ${progress.total} tasks done` : label;
}

function PlanEntry({ thread }: { thread: Thread }) {
  const bubble = useTaskStore((s) => s.taskBubbleByThread[thread.id]);
  const latest = usePlanStore((s) => selectRowPlan(s.plansByThread[thread.id], bubble?.sourceMessageId ?? null));
  const openPlan = useCallback(() => {
    // Opening the right panel docks nothing in its place, so a floating card would cover the plan.
    useOverviewStore.getState().dismissOverlay(threadOverviewKey(thread.id));
    showRightPanelAdaptive(thread.workspace_id, thread.id);
    useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "tasks");
  }, [thread.id, thread.workspace_id]);
  if (!latest) return null;
  const implementing = latest.acceptedMessageId !== null && bubble?.sourceMessageId === latest.acceptedMessageId;
  const progress = implementing ? selectTaskProgress(bubble, undefined) : null;
  const trailing = progress ? `${progress.settled}/${progress.total}` : `v${latest.version}`;
  return (
    <Button
      variant="ghost"
      size="compact"
      type="button"
      data-testid="thread-overview-plan"
      onClick={openPlan}
      aria-label={rowLabel(latest, progress)}
      className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-between gap-2")}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <FileText
          size={16}
          className="text-muted transition-colors duration-150 group-hover:text-ink/80"
        />
      </span>
      <span className="text-fade min-w-0 grow text-sm text-ink">{latest.title}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted">{trailing}</span>
    </Button>
  );
}

/** Plan row in the thread overview. Clicking it opens the Plan tab in the right panel. */
export function PlanEntryBlock({ subject }: { subject: OverviewSubject }) {
  return subject.kind === "thread" ? <PlanEntry thread={subject.thread} /> : null;
}
