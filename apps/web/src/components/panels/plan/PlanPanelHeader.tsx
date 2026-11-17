import { FileText } from "lucide-react";
import type { PlanVersion } from "@mcode/contracts/models/plan";
import { PanelHeaderSlot, PanelTitle } from "@/components/panels/shell/PanelHeader";
import { PlanImplementSplit } from "./PlanImplementSplit";
import { PlanVersionPicker } from "./PlanVersionPicker";

/** Row 1 for the Plan tab: the title pill naming the tool, shown with or without a plan. */
export function PlanTitle() {
  return (
    <PanelHeaderSlot slot="leading">
      <PanelTitle icon={<FileText size={14} aria-hidden />}>Plan</PanelTitle>
    </PanelHeaderSlot>
  );
}

/** Props for {@link PlanControlsRow}. */
interface PlanControlsRowProps {
  readonly threadId: string;
  readonly versions: readonly PlanVersion[];
  readonly viewed: PlanVersion;
  readonly executing: boolean;
}

/**
 * Row 2 for the Plan tab: the version picker as the operand on the left and
 * the Implement split on the right. Rendered only once the thread has a plan,
 * so an empty Plan tab shows no row 2.
 */
export function PlanControlsRow({ threadId, versions, viewed, executing }: PlanControlsRowProps) {
  return (
    <PanelHeaderSlot slot="row2">
      {/* The container lets Implement shorten its label to fit a narrow panel. */}
      <div className="@container flex h-10 min-w-0 flex-1 items-center gap-2">
        <PlanVersionPicker threadId={threadId} versions={versions} viewed={viewed} />
        <div className="ml-auto flex shrink-0 items-center">
          <PlanImplementSplit threadId={threadId} viewed={viewed} executing={executing} />
        </div>
      </div>
    </PanelHeaderSlot>
  );
}
