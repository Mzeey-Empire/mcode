import { cn } from "@/lib/utils";
import type { ThreadRowLook } from "./thread-row-presentation";
import { StatusMark } from "@/components/ui/status-mark";

/**
 * The fixed 16px leading slot of a thread row. It stays in layout when empty
 * so titles line up whether or not a row carries a status.
 */
export function ThreadStatusLane({ look, className }: { look: ThreadRowLook; className?: string }) {
  return (
    <span data-testid="thread-status-lane" className={cn("flex h-5 w-4 shrink-0 items-center justify-center", className)}>
      {look ? <StatusMark state={look.state} label={look.label} icon={look.icon} /> : null}
    </span>
  );
}
