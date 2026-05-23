import { useMemo } from "react";
import { usePlanStore } from "@/stores/planStore";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { ScrollText } from "lucide-react";

interface PlanCardProps {
  messageId: string;
}

/**
 * Compact card rendered in the chat message stream when a plan was
 * extracted from this message. Clicking opens the Scope panel to
 * the plan document. Shows title, version, and a "View plan" affordance.
 */
export function PlanCard({ messageId }: PlanCardProps) {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const allPlans = usePlanStore((s) =>
    activeThreadId ? s.plansByThread[activeThreadId] : undefined,
  );

  const plan = useMemo(
    () => allPlans?.find((p) => p.messageId === messageId),
    [allPlans, messageId],
  );

  if (!plan || !activeThreadId) return null;

  const handleClick = () => {
    useDiffStore.getState().showRightPanel(activeThreadId);
    useDiffStore.getState().setRightPanelTab(activeThreadId, "tasks");
    usePlanStore.getState().setActiveVersion(activeThreadId, plan.version);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="mt-3 flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/50"
    >
      <ScrollText className="h-4 w-4 flex-shrink-0 text-primary/70" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">
          {plan.title}
        </div>
      </div>
      <span className="flex-shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-primary/65">
        v{plan.version}
      </span>
      <span className="flex-shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/50">
        View plan
      </span>
    </button>
  );
}
