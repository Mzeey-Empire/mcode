import { useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface CollapsibleErrorProps {
  /** Raw error string from the failed RPC call. */
  error: string;
  onRetry: () => void;
  onDismiss: () => void;
}

/** Thread creation error with a collapsible detail section. */
export function CollapsibleError({ error, onRetry, onDismiss }: CollapsibleErrorProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-stretch gap-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left text-sm font-medium text-destructive"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span className="flex-1">Failed to create thread</span>
              {open ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-destructive/60" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-destructive/60" />
              )}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-destructive/20 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive/80">
              {error}
            </pre>
          </CollapsibleContent>
        </div>
      </Collapsible>

      <div className="flex justify-center gap-2">
        <Button type="button" size="sm" variant="default" onClick={onRetry}>
          Retry
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
