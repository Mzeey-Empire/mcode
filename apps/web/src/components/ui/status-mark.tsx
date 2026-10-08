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

/** Props for {@link StatusMark}. */
export interface StatusMarkProps {
  state: StatusMarkState;
  /** Accessible name, for example "Running" or "Failed". The mark itself has no visible text. */
  label: string;
  className?: string;
}

/**
 * The Paper status mark: an 8px dot or ring, or a neutral spinner, in a 16px slot.
 * `data-status-mark` exposes the state so a row can style itself, for example
 * the sidebar fading a running thread.
 */
export function StatusMark({ state, label, className }: StatusMarkProps) {
  return (
    <span
      role="img"
      aria-label={label}
      data-status-mark={state}
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      {state === "running"
        ? <Spinner size={12} className="text-ink" />
        : <span aria-hidden className={cn("size-2 rounded-full", DOT_CLASS[state])} />}
    </span>
  );
}
