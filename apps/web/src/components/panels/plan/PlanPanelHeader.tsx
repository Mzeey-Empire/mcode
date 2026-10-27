import type { PlanVersion } from "@mcode/contracts/models/plan";
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";
import { PlanImplementSplit } from "./PlanImplementSplit";
import { PlanVersionPicker } from "./PlanVersionPicker";

/** Props for {@link PlanPanelHeader}. */
interface PlanPanelHeaderProps {
  readonly threadId: string;
  readonly versions: readonly PlanVersion[];
  readonly viewed: PlanVersion;
  readonly executing: boolean;
}

/**
 * The Plan panel's header content. The shell already supplies expand and the
 * panel toggle, so the plan contributes its version picker and Implement split.
 */
export function PlanPanelHeader({ threadId, versions, viewed, executing }: PlanPanelHeaderProps) {
  return (
    <PanelHeaderSlot slot="leading">
      <PlanVersionPicker threadId={threadId} versions={versions} viewed={viewed} />
      <PlanImplementSplit threadId={threadId} viewed={viewed} executing={executing} />
    </PanelHeaderSlot>
  );
}
