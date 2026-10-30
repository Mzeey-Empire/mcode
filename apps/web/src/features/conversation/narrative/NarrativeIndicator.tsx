import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/time";
import { Spinner } from "@/components/ui/spinner";
import { StackedLayersIcon, stackedLayersIconClassName } from "@/components/ui/StackedLayersIcon";
import type { RunStatus } from "./run-status";

function elapsedSeconds(startTime: number | undefined): number {
  return startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
}

function useElapsedSeconds(startTime: number | undefined): number {
  const [, setElapsedTick] = useState(0);

  useEffect(() => {
    if (!startTime) return;
    const interval = setInterval(() => {
      setElapsedTick((tick) => tick + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  return elapsedSeconds(startTime);
}

/** Props for {@link NarrativeIndicator}: step count, run status, and turn start time. */
interface NarrativeIndicatorProps {
  /** Total number of steps executed so far in this agent turn. */
  stepCount: number;
  /** Label and icon chosen by `deriveRunStatus`. */
  status: RunStatus;
  /** Epoch ms when the agent turn started, used to compute elapsed time. */
  startTime?: number;
}

function RunStatusIcon({ icon }: { icon: RunStatus["icon"] }) {
  if (icon === "dot") {
    return <span className="size-1.5 shrink-0 rounded-full bg-primary" data-run-status-icon="dot" />;
  }
  if (icon === "spinner") {
    // D5 keeps spinners on the 12/16 scale, so the 12px spinner sits centred in the 14px icon slot.
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted" data-run-status-icon="spinner">
        <Spinner size={12} />
      </span>
    );
  }
  return (
    <StackedLayersIcon
      animated
      className={stackedLayersIconClassName(true)}
      data-run-status-icon="layers"
    />
  );
}

/**
 * Bottom bar of the narrative flow: step count, run status label, and elapsed time.
 *
 * Example outputs:
 *   6 steps · Thinking 22s
 *   5 steps · Running bun run lint 38s
 *   Stopping 1m 4s
 *
 * The transcript drops the turn's item in the same render that settles it.
 * Unfinished delegated tasks can keep a separate wait without steps or a clock.
 */
export function NarrativeIndicator({
  stepCount,
  status,
  startTime,
}: NarrativeIndicatorProps) {
  const elapsed = useElapsedSeconds(startTime);
  // The turn is held on the user, so its step count and clock are not what they need to see.
  const waiting = status.icon === "dot";

  return (
    <div
      className={cn("mt-2 flex h-6 items-center pl-2 text-xs", waiting ? "gap-2" : "gap-1.5")}
      data-state="running"
    >
      <RunStatusIcon icon={status.icon} />
      {!waiting && stepCount > 0 && (
        <span className="shrink-0 text-muted">
          {stepCount} {stepCount === 1 ? "step" : "steps"} ·
        </span>
      )}
      <span className={cn("min-w-0 text-fade", waiting ? "text-muted" : "font-medium text-ink")}>{status.label}</span>
      {!waiting && startTime !== undefined && (
        <span className="shrink-0 font-mono text-muted">{formatDuration(elapsed)}</span>
      )}
    </div>
  );
}
