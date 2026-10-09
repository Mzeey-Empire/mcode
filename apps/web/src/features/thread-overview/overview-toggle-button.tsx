import { IconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Settings2 } from "lucide-react";
import type { Ref } from "react";
import type { ThreadOverviewCiDot } from "./overview-state";

/** Props for {@link OverviewToggleButton}. */
interface OverviewToggleButtonProps {
  ciDot: ThreadOverviewCiDot;
  /** Whether the card shows, docked or as an overlay. */
  on: boolean;
  onToggle: () => void;
  ref?: Ref<HTMLButtonElement>;
}

/** Returns the accessible label for the Overview button's current CI state. */
function getOverviewToggleLabel(ciDot: ThreadOverviewCiDot): string {
  if (ciDot === "red") return "Thread overview, CI checks failing";
  if (ciDot === "green") return "Thread overview, CI checks passing";
  return "Thread overview";
}

function getCiDotClass(ciDot: ThreadOverviewCiDot): string | false {
  if (ciDot === "red") return "bg-[var(--diff-remove-strong)]";
  if (ciDot === "green") return "bg-[var(--diff-add-strong)]";
  return false;
}

/** The header button that shows and hides the Overview card, with the thread's CI state as a dot. */
export function OverviewToggleButton({ ciDot, on, onToggle, ref }: OverviewToggleButtonProps) {
  return (
    <IconButton
      ref={ref}
      shape="round"
      pressed={on}
      aria-label={getOverviewToggleLabel(ciDot)}
      data-testid="header-overview-toggle"
      className="relative"
      onClick={onToggle}
    >
      <Settings2 size={16} aria-hidden />
      {ciDot === null ? null : (
        <span
          data-testid={`thread-overview-ci-${ciDot}`}
          aria-hidden
          className={cn("absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background", getCiDotClass(ciDot))}
        />
      )}
    </IconButton>
  );
}
