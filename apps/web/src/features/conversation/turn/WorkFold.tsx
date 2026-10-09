import { ChevronRight } from "lucide-react";
import type { TurnOutcome } from "@mcode/contracts";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

const ENDED_LABELS: Record<Exclude<TurnOutcome, "completed">, string> = {
  cancelled: "Stopped after",
  interrupted: "Interrupted after",
  errored: "Failed after",
};

/** Names how a settled turn ended and how long it ran, for example "Worked for 1m 42s". */
export function workFoldLabel(outcome: TurnOutcome | null | undefined, durationMs: number | null): string {
  if (durationMs == null || durationMs < 0) return "Worked";
  // A sub-second turn still reads as work done, so it rounds up to one second.
  const duration = formatDuration(Math.max(1, Math.round(durationMs / 1000)));
  return outcome == null || outcome === "completed"
    ? `Worked for ${duration}`
    : `${ENDED_LABELS[outcome]} ${duration}`;
}

/** Props for {@link WorkFold}. */
export interface WorkFoldProps {
  /** Text from {@link workFoldLabel}. */
  label: string;
  /** Whether the turn's narrative rows are showing below the fold. */
  expanded: boolean;
  /** Opens or closes the turn's narrative rows. */
  onToggle: () => void;
}

/** Collapsed summary of a settled turn's work. Its narrative rows are separate virtual rows. */
export function WorkFold({ label, expanded, onToggle }: WorkFoldProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex h-8 w-full items-center gap-1.5 border-b border-border text-left text-body-small text-muted outline-none transition-colors hover:text-ink focus-visible:text-ink"
      data-testid="work-fold"
    >
      <span className="shrink-0">{label}</span>
      <ChevronRight
        size={14}
        strokeWidth={1.5}
        aria-hidden="true"
        className={cn("shrink-0 motion-safe:transition-transform motion-safe:duration-150", expanded && "rotate-90")}
      />
    </button>
  );
}

/** The approval-review sentence shown as the first row inside an open work fold. */
export function WorkFoldNote({ text }: { text: string }) {
  return <p className="text-body-small text-muted" data-testid="approval-review">{text}</p>;
}
