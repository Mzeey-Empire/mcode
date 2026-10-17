import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent } from "@/components/ui/popover";

/** The Paper confirm buttons are 14px padded, between the shared compact and default sizes. */
const CONFIRM_BUTTON = "px-3.5 text-body-small";

interface TerminalCloseConfirmProps {
  readonly name: string;
  readonly anchor: HTMLElement | null;
  readonly command?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * Popover under a terminal's tab asking whether to stop its running process.
 * Escape or an outside click cancels.
 */
export function TerminalCloseConfirm({ name, anchor, command, onConfirm, onCancel }: TerminalCloseConfirmProps) {
  const titleId = useId();
  const descriptionId = useId();
  if (!anchor) return null;
  return (
    <Popover open onOpenChange={(open) => !open && onCancel()}>
      <PopoverContent
        anchor={anchor}
        side="bottom"
        align="start"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="flex w-70 flex-col gap-3 p-3.5"
      >
        <div className="flex flex-col gap-1">
          <p id={titleId} className="text-sm font-semibold text-ink">Stop {name}?</p>
          <p id={descriptionId} className="text-body-small text-muted">
            {command === undefined
              ? "It is still running. Closing stops it and everything it started."
              : `${command} is still running. Closing the tab stops it.`}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="subtle" shape="round" className={CONFIRM_BUTTON} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="ink" shape="round" autoFocus className={`${CONFIRM_BUTTON} font-semibold`} onClick={onConfirm}>
            Stop and close
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
