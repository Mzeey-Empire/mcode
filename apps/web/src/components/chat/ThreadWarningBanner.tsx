import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, X } from "lucide-react";
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
    <div className="mx-auto w-full max-w-3xl px-4">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <div className="flex items-center gap-2">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex flex-1 items-center gap-2 text-left text-sm font-medium text-amber-600 dark:text-amber-400"
              >
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="flex-1">
                  Post-checkout hook encountered an error
                </span>
                {open ? (
                  <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 opacity-60" />
                )}
              </button>
            </CollapsibleTrigger>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded p-0.5 text-amber-600/60 transition-colors hover:text-amber-600 dark:text-amber-400/60 dark:hover:text-amber-400"
              aria-label="Dismiss warning"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <CollapsibleContent>
            <div className="mt-3 space-y-2">
              {warnings.map((w, i) => (
                <pre
                  key={i}
                  className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 font-mono text-xs text-amber-700 dark:text-amber-300"
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
