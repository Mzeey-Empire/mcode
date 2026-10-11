import { StatusMark } from "@/components/ui/status-mark";
import { cn } from "@/lib/utils";
import type { ThreadRowLook } from "./thread-row-presentation";

/**
 * The fixed 16px leading slot of a thread row. It stays in layout when empty
 * so titles line up whether or not a row carries a mark.
 */
export function ThreadStatusLane({ mark, className }: { mark: ThreadRowLook["mark"]; className?: string }) {
  return (
    <span data-testid="thread-status-lane" className={cn("flex h-5 w-4 shrink-0 items-center justify-center", className)}>
      {mark ? <StatusMark state={mark.state} label={mark.label} /> : null}
    </span>
  );
}
