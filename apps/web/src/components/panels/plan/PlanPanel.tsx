import type { PlanVersion } from "@mcode/contracts";
import { selectViewedPlanVersion, usePlanStore } from "@/stores/planStore";
import { PlanEditor } from "./PlanEditor";
import { PlanPanelHeader } from "./PlanPanelHeader";

/** Stable empty array to avoid new-reference-per-render in Zustand selectors. */
const EMPTY_PLANS: readonly PlanVersion[] = [];

/** Props for {@link PlanPanel}. */
interface PlanPanelProps {
  readonly threadId: string;
}

/**
 * Plan tab content: the version picker in the panel header and a read-only
 * view of the viewed version. Renders nothing until the thread has a plan.
 */
export function PlanPanel({ threadId }: PlanPanelProps) {
  const versions = usePlanStore((s) => s.plansByThread[threadId] ?? EMPTY_PLANS);
  const activeVersion = usePlanStore((s) => s.activeVersionByThread[threadId] ?? null);
  const viewed = selectViewedPlanVersion(versions, activeVersion);

  if (!viewed) return null;

  return (
    <div className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">
      <PlanPanelHeader threadId={threadId} versions={versions} viewed={viewed} />
      <PlanEditor contentMd={viewed.contentMd} />
    </div>
  );
}
