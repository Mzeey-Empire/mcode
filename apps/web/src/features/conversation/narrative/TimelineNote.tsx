import { CircleAlert, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

/** Whether a timeline note reports routine progress or a failure the user should notice. */
export type TimelineNoteTone = "neutral" | "error";

/** A centered divider line carrying one short timeline note. */
export function TimelineNote({ text, tone = "neutral" }: { text: string; tone?: TimelineNoteTone }) {
  const error = tone === "error";
  const line = cn("h-px flex-1", error ? "bg-destructive/40" : "bg-border");
  const Icon = error ? CircleAlert : RotateCcw;
  return (
    // Stored history must not announce on every mount, so an error is a note with a spoken prefix, not an alert.
    <div className="flex items-center gap-3 py-2" role="note">
      <div className={line} aria-hidden="true" />
      <div className={cn("flex items-center gap-1.5 text-xs", error ? "text-destructive" : "text-muted")}>
        <Icon size={12} aria-hidden="true" />
        <span>{error ? <span className="sr-only">Error: </span> : null}{text}</span>
      </div>
      <div className={line} aria-hidden="true" />
    </div>
  );
}
