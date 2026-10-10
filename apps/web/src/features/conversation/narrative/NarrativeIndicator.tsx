import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { formatClock } from "@/lib/time";
import { Spinner } from "@/components/ui/spinner";
import { StackedLayersIcon, stackedLayersIconClassName } from "@/components/ui/StackedLayersIcon";
import type { RunStatus } from "./run-status";

/**
 * How long the exit animation plays before the component stops rendering.
 * Matches the `narrative-indicator-out` keyframes duration in index.css.
 */
const EXIT_DURATION_MS = 240;

/** Lifecycle of the indicator: live → animating out → unrendered. */
type IndicatorPhase = "running" | "exiting" | "done";

function elapsedSeconds(startTime: number | undefined): number {
  return startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
}

function advanceRunningEpoch(
  isAgentRunning: boolean,
  previousRunningRef: React.MutableRefObject<boolean>,
  runningEpochRef: React.MutableRefObject<number>,
): number {
  if (isAgentRunning && !previousRunningRef.current) {
    runningEpochRef.current += 1;
  }
  previousRunningRef.current = isAgentRunning;
  return runningEpochRef.current;
}

function deriveIndicatorPhase(
  isAgentRunning: boolean,
  completedExitEpoch: number,
  runningEpoch: number,
): IndicatorPhase {
  if (isAgentRunning) return "running";
  return completedExitEpoch === runningEpoch ? "done" : "exiting";
}

function useNarrativeIndicatorLifecycle(
  startTime: number | undefined,
  isAgentRunning: boolean,
): { elapsed: number; phase: IndicatorPhase } {
  const previousRunningRef = useRef(isAgentRunning);
  const runningEpochRef = useRef(isAgentRunning ? 0 : -1);
  const elapsedRef = useRef(elapsedSeconds(startTime));
  const [, setElapsedTick] = useState(0);
  const [completedExitEpoch, setCompletedExitEpoch] = useState(
    isAgentRunning ? -1 : runningEpochRef.current,
  );
  const runningEpoch = advanceRunningEpoch(
    isAgentRunning,
    previousRunningRef,
    runningEpochRef,
  );
  if (isAgentRunning) elapsedRef.current = elapsedSeconds(startTime);
  const phase = deriveIndicatorPhase(isAgentRunning, completedExitEpoch, runningEpoch);

  useEffect(() => {
    if (phase !== "exiting") return;
    const timer = setTimeout(() => setCompletedExitEpoch(runningEpoch), EXIT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [phase, runningEpoch]);

  useEffect(() => {
    // Freeze the elapsed readout once the turn ends so the exit animation
    // fades out a stable value instead of ticking mid-fade.
    if (!startTime || !isAgentRunning) return;

    const interval = setInterval(() => {
      setElapsedTick((tick) => tick + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime, isAgentRunning]);

  return { elapsed: elapsedRef.current, phase };
}

/** Props for {@link NarrativeIndicator}: step count, run status, and turn start time. */
interface NarrativeIndicatorProps {
  /** Total number of steps executed so far in this agent turn. */
  stepCount: number;
  /** Label and icon chosen by `deriveRunStatus`. */
  status: RunStatus;
  /** Epoch ms when the agent turn started, used to compute elapsed time. */
  startTime?: number;
  /** Whether the agent is still running; flipping to false plays the exit transition. */
  isAgentRunning: boolean;
}

/** Keeps the last running status so the exit fade shows what the turn was doing, not a new word. */
function useFrozenStatus(status: RunStatus, isAgentRunning: boolean): RunStatus {
  const lastRunningRef = useRef(status);
  if (isAgentRunning) lastRunningRef.current = status;
  return lastRunningRef.current;
}

function RunStatusIcon({ icon, running }: { icon: RunStatus["icon"]; running: boolean }) {
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
      animated={running}
      className={stackedLayersIconClassName(running)}
      data-run-status-icon="layers"
    />
  );
}

/**
 * Bottom bar of the narrative flow: step count, run status label, and a clock.
 *
 * Example outputs:
 *   6 steps · Thinking 0:22
 *   5 steps · Running bun run lint 0:38
 *   Stopping 1:04
 *
 * When the turn ends the bar collapses and fades out over
 * {@link EXIT_DURATION_MS} with its last running label instead of vanishing in
 * a single frame, then renders nothing. Mounting with the agent already
 * stopped (e.g. revisiting a thread whose turn finished) skips straight to
 * rendering nothing.
 */
export function NarrativeIndicator({
  stepCount,
  status,
  startTime,
  isAgentRunning,
}: NarrativeIndicatorProps) {
  const { elapsed, phase } = useNarrativeIndicatorLifecycle(startTime, isAgentRunning);
  const shown = useFrozenStatus(status, isAgentRunning);

  if (phase === "done") return null;

  return (
    <div
      className={cn(
        "mt-2 flex h-6 items-center gap-1.5 pl-2 text-xs",
        phase === "exiting" && "narrative-indicator-exit",
      )}
      data-state={phase}
    >
      <RunStatusIcon icon={shown.icon} running={phase === "running"} />
      {stepCount > 0 && (
        <span className="shrink-0 text-muted">
          {stepCount} {stepCount === 1 ? "step" : "steps"} ·
        </span>
      )}
      <span className="min-w-0 font-medium text-ink text-fade">{shown.label}</span>
      {startTime !== undefined && (
        <span className="shrink-0 font-mono text-muted">{formatClock(elapsed)}</span>
      )}
    </div>
  );
}
