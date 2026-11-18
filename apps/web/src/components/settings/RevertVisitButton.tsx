import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { revertVisit, useVisitChanges, type RevertFailure, type VisitChange } from "./settings-visit";

function sentence(reason: string): string {
  return reason.replace(/\.$/, "");
}

function tooltipText(changes: readonly VisitChange[], failures: readonly RevertFailure[]): string {
  const failed = failures.map((failure) => `Could not put back ${failure.label}: ${sentence(failure.reason)}.`);
  return [...failed, `Puts back ${changes.map((change) => change.label).join(", ")}`].join(" ");
}

function countText(count: number): string {
  return count === 1 ? "1 change" : `${count} changes`;
}

/**
 * Header action that puts back what the user changed during this visit to a Settings page. The slot keeps its
 * height when the button is absent, so the page never moves when it appears.
 */
export function RevertVisitButton({ onReverted }: { readonly onReverted: () => void }) {
  const { changes, reverting, writing, failures } = useVisitChanges();
  const [status, setStatus] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const busy = reverting || writing;

  async function revert() {
    if (busy) return;
    const count = changes.length;
    const result = await revertVisit();
    if (result.failures.length === 0) {
      setStatus(`Reverted ${countText(count)}.`);
      onReverted();
      return;
    }
    setStatus(`Could not put back ${result.failures.map((failure) => failure.label).join(", ")}.`);
    buttonRef.current?.focus();
  }

  return (
    <div className="window-no-drag ml-auto flex h-control-compact shrink-0 items-center pr-4">
      {changes.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                ref={buttonRef}
                variant="outline"
                aria-disabled={busy || undefined}
                onClick={() => void revert()}
              />
            }
          >
            Revert {countText(changes.length)}
          </TooltipTrigger>
          <TooltipContent side="bottom">{tooltipText(changes, failures)}</TooltipContent>
        </Tooltip>
      ) : null}
      <span role="status" className="sr-only">{status}</span>
    </div>
  );
}
