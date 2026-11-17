import type { LucideIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * What a status mark shows. `attention` is a thread waiting on the user;
 * `running` is a neutral spinner; `info` is a notice with no outcome; the rest are settled outcomes.
 */
export type StatusMarkState = "running" | "attention" | "success" | "error" | "info";

const DOT_CLASS: Record<Exclude<StatusMarkState, "running">, string> = {
  attention: "border-[1.5px] border-primary",
  success: "bg-success",
  error: "bg-error",
  info: "bg-info",
};

/** The text colour role of each state, shared by an icon mark and any label set beside it. */
export const STATUS_MARK_TEXT_CLASS: Record<StatusMarkState, string> = {
  running: "text-muted",
  attention: "text-primary",
  success: "text-success",
  error: "text-error",
  info: "text-info",
};

/** Props for {@link StatusMark}. */
export interface StatusMarkProps {
  state: StatusMarkState;
  /** Accessible name, for example "Running" or "Failed". The mark itself has no visible text. */
  label: string;
  /** Draws this 14px glyph in the state's colour instead of the dot. A running mark keeps its spinner. */
  icon?: LucideIcon;
  className?: string;
}

/**
 * The Paper status mark: an 8px dot or ring, or a neutral spinner, in a 16px slot.
 * `data-status-mark` exposes the state so a row can style itself, for example
 * the sidebar fading a running thread.
 */
export function StatusMark({ state, label, icon: Icon, className }: StatusMarkProps) {
  return (
    <span
      role="img"
      aria-label={label}
      data-status-mark={state}
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      {markGlyph(state, Icon)}
    </span>
  );
}

function markGlyph(state: StatusMarkState, Icon: LucideIcon | undefined) {
  if (state === "running") return <Spinner size={12} className="text-ink" />;
  if (Icon) return <Icon size={14} aria-hidden className={STATUS_MARK_TEXT_CLASS[state]} />;
  return <span aria-hidden className={cn("size-2 rounded-full", DOT_CLASS[state])} />;
}
