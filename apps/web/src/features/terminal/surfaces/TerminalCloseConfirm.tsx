import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent } from "@/components/ui/popover";

interface TerminalCloseConfirmProps {
  readonly name: string;
  readonly anchor: HTMLElement | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * Popover under a terminal's tab asking whether to stop its running process.
 * Escape or an outside click cancels.
 */
export function TerminalCloseConfirm({ name, anchor, onConfirm, onCancel }: TerminalCloseConfirmProps) {
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
        className="flex w-64 flex-col gap-3 p-3"
      >
        <div className="flex flex-col gap-1">
          <p id={titleId} className="text-sm font-medium text-ink">Stop {name}?</p>
          <p id={descriptionId} className="text-xs text-muted">It is still running. Closing stops it and everything it started.</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="compact" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="compact" autoFocus onClick={onConfirm}>
            Stop and close
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
