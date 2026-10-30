import type { PlanVersion } from "@mcode/contracts/models/plan";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SplitButton } from "@/components/ui/split-button";
import { getKeybindingForCommand, keybindingKeycaps } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import { usePlanCommentChip } from "@/features/conversation/composer/usePlanCommentChip";
import { implementPlan, isPlanVersionImplementable, usePlanImplementStore } from "./plan-implement";
import { useSourceCheckout } from "./use-source-checkout";

/** Shown under the new-worktree item when the source has changes the worktree will not carry. */
export const UNCOMMITTED_STAY_NOTE = "Starts from the last commit. Uncommitted changes stay here.";

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
  // Send takes the amber while plan comments ride, so Implement steps back.
  const commentsRide = usePlanCommentChip(threadId).length > 0;
  if (!isPlanVersionImplementable(viewed)) return null;

  const label = `Implement v${viewed.version}`;
  const binding = getKeybindingForCommand("plan.implement");
  const implement = () => void implementPlan(threadId);

  return (
    <SplitButton
      variant={commentsRide ? "secondary" : "default"}
      className="ml-auto"
      disabled={executing}
      loading={busy}
      onClick={implement}
      menuLabel="More ways to implement"
      // The label fades rather than running under the header's expand button.
      actionProps={{ "data-testid": "plan-implement", "aria-label": label, className: "shrink @max-[224px]:px-2" }}
      menuTriggerProps={{ "data-testid": "plan-implement-menu" }}
      menu={
        <>
          <DropdownMenuItem
            label={label}
            shortcut={binding ? keybindingKeycaps(binding.key, isMac) : undefined}
            onClick={implement}
          />
          <DropdownMenuItem label={`${label} in a new thread`} onClick={() => void implementPlan(threadId, "new-thread")} />
          <NewWorktreeItem threadId={threadId} label={`${label} in a new worktree`} />
        </>
      }
    >
      {/* The picker beside it already names the version, so a narrow header drops it here first. */}
      <span className="text-fade min-w-0">
        Implement<span className="@max-[224px]:hidden"> v{viewed.version}</span>
      </span>
    </SplitButton>
  );
}

/**
 * Mounts with the open menu, so the checkout is read when the menu opens. Absent outside a git
 * repository, where there is no commit to start the worktree at.
 */
function NewWorktreeItem({ threadId, label }: { readonly threadId: string; readonly label: string }) {
  const { isGitRepo, isDirty } = useSourceCheckout(threadId);
  if (!isGitRepo) return null;
  return (
    <DropdownMenuItem
      label={label}
      description={isDirty ? UNCOMMITTED_STAY_NOTE : undefined}
      onClick={() => void implementPlan(threadId, "new-worktree")}
    />
  );
}
