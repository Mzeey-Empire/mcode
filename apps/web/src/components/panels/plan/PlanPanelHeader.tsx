import type { PlanVersion } from "@mcode/contracts";
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";
import { PlanVersionPicker } from "./PlanVersionPicker";

/** Props for {@link PlanPanelHeader}. */
interface PlanPanelHeaderProps {
  readonly threadId: string;
  readonly versions: readonly PlanVersion[];
  readonly viewed: PlanVersion;
}

/**
 * The Plan panel's header content. The shell already supplies expand and the
 * panel toggle, so the plan only contributes its version picker.
 */
export function PlanPanelHeader({ threadId, versions, viewed }: PlanPanelHeaderProps) {
  return (
    <PanelHeaderSlot slot="leading">
      <PlanVersionPicker threadId={threadId} versions={versions} viewed={viewed} />
    </PanelHeaderSlot>
  );
}
