interface StepIndicatorProps {
  /** 0-based index of the current question. */
  current: number;
  /** Total number of questions. */
  total: number;
}

/**
 * Step progress dots with a pulse on the current dot and an
 * aria-live region for screen readers (AC-1.16, AC-1.21).
 * Hidden for single-question batches (AC-1.27).
 */
export function StepIndicator({ current, total }: StepIndicatorProps) {
  if (total <= 1) return null;

  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all duration-200 ${
            i === current
              ? "w-3 h-1.5 bg-primary/60 animate-step-pulse"
              : i < current
                ? "w-1.5 h-1.5 bg-primary/30"
                : "w-1.5 h-1.5 bg-muted-foreground/15"
          }`}
        />
      ))}
      {/* Screen-reader announcement (AC-1.16) */}
      <span className="sr-only" aria-live="polite">
        Question {current + 1} of {total}
      </span>
    </div>
  );
}
