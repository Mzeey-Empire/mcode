import { useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { WarningIcon } from "@/components/ui/icon-map";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/** Non-fatal warning messages from worktree creation. */
interface ThreadWarningBannerProps {
  /** Non-fatal warning messages from worktree creation. */
  warnings: string[];
  /** Called when the user dismisses the banner via the X button. */
  onDismiss: () => void;
}

/** Dismissible warning banner for post-checkout issues on a successfully created thread. */
export function ThreadWarningBanner({
  warnings,
  onDismiss,
}: ThreadWarningBannerProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="animate-fade-up-in mx-auto w-full max-w-3xl">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 transition-colors duration-150 hover:bg-warning/10">
          <div className="flex items-center gap-2">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex flex-1 items-center gap-2 text-left text-sm font-medium text-warning"
              >
                <WarningIcon className="h-4 w-4 shrink-0" />
                <span className="flex-1">
                  Post-checkout hook encountered an error
                </span>
                <ChevronRight
                  className="h-4 w-4 shrink-0 opacity-60 transition-transform duration-200"
                  style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
                />
              </button>
            </CollapsibleTrigger>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded p-1 text-warning/60 transition-all duration-150 hover:bg-warning/10 hover:text-warning dark:text-warning/60 dark:hover:bg-warning/10 dark:hover:text-warning"
              aria-label="Dismiss warning"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
            <div className="mt-3 space-y-2">
              {warnings.map((w, i) => (
                <pre
                  key={i}
                  className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-warning/20 bg-warning/5 px-3 py-2 font-mono text-xs text-warning"
                >
                  {w}
                </pre>
              ))}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  );
}
