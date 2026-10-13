import type { PlanVersion } from "@mcode/contracts";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SplitButton } from "@/components/ui/split-button";
import { formatKeybinding, getKeybindingForCommand } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import { implementPlan, isPlanVersionImplementable, usePlanImplementStore } from "./plan-implement";

/** Props for {@link PlanImplementSplit}. */
interface PlanImplementSplitProps {
  readonly threadId: string;
  /** The version the panel is showing; the split implements exactly this one. */
  readonly viewed: PlanVersion;
  /** True while a turn runs, when the server would refuse the request. */
  readonly executing: boolean;
}

/**
 * The Plan panel's Implement control: "Implement v{N}" for the version on
 * screen, with the ways to implement it in the chevron menu. Hidden for
 * accepted and superseded versions, which are history.
 */
export function PlanImplementSplit({ threadId, viewed, executing }: PlanImplementSplitProps) {
  const busy = usePlanImplementStore((s) => s.busy[threadId] === true);
  if (!isPlanVersionImplementable(viewed)) return null;

  const label = `Implement v${viewed.version}`;
  const binding = getKeybindingForCommand("plan.implement");
  const implement = () => void implementPlan(threadId);

  return (
    <SplitButton
      variant="default"
      className="ml-auto"
      disabled={executing}
      loading={busy}
      onClick={implement}
      menuLabel="More ways to implement"
      actionProps={{ "data-testid": "plan-implement" }}
      menuTriggerProps={{ "data-testid": "plan-implement-menu" }}
      menu={
        <DropdownMenuItem
          label={label}
          shortcut={binding ? formatKeybinding(binding.key, isMac) : undefined}
          onClick={implement}
        />
      }
    >
      {label}
    </SplitButton>
  );
}
