import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Props for {@link DockStopButton}. */
export interface DockStopButtonProps {
  readonly isStopPending: boolean;
  readonly onStop: () => void;
}

/** Stop control for a dock that replaces the composer, so a running turn can still be interrupted. */
export function DockStopButton({ isStopPending, onStop }: DockStopButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" shape="round" size="icon-compact" onClick={onStop} disabled={isStopPending} aria-label="Stop agent">
            <div className="size-2.5 rounded-[2px] bg-ink" />
          </Button>
        }
      />
      <TooltipContent>Stop agent</TooltipContent>
    </Tooltip>
  );
}
