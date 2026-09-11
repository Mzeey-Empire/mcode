import { useState, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/time";
import type { ToolCall } from "@/transport/types";
import { narrativeActivityLabel } from "./activity-label";
import { StackedLayersIcon, stackedLayersIconClassName } from "@/components/ui/StackedLayersIcon";

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

/** Props for {@link NarrativeIndicator}: step counts, active tools, and turn start time. */
interface NarrativeIndicatorProps {
  /** Total number of steps executed so far in this agent turn. */
  stepCount: number;
  /** Number of subagent calls dispatched at the top level. Only rendered when > 0. */
  subagentCount: number;
  /** Currently active (possibly incomplete) tool calls. */
  activeToolCalls: readonly ToolCall[];
  /** Complete heading supplied by the current open narration segment. */
  summaryHeading?: string;
  /** Epoch ms when the agent turn started, used to compute elapsed time. */
  startTime?: number;
  /** Whether the agent is still running; flipping to false plays the exit transition. */
  isAgentRunning: boolean;
}

/**
 * Bottom bar of the narrative flow. Combines step count, optional subagent
 * count, phase label, and elapsed time into a single compact status line.
 *
 * Example outputs:
 *   6 steps · Thinking... (0:22)
 *   4 steps · 2 subagents · Thinking deeper... (0:15)
 *   5 steps · Running a command... (0:38)
 *
 * When the turn ends the bar collapses and fades out over
 * {@link EXIT_DURATION_MS} instead of vanishing in a single frame, then
 * renders nothing. Mounting with the agent already stopped (e.g. revisiting
 * a thread whose turn finished) skips straight to rendering nothing.
 */
export function NarrativeIndicator({
  stepCount,
  subagentCount,
  activeToolCalls,
  summaryHeading,
  startTime,
  isAgentRunning,
}: NarrativeIndicatorProps) {
  const { elapsed, phase } = useNarrativeIndicatorLifecycle(startTime, isAgentRunning);

  const phaseLabel = useMemo(() => narrativeActivityLabel(activeToolCalls, summaryHeading), [activeToolCalls, summaryHeading]);

  if (phase === "done") return null;

  const subagentLabel =
    subagentCount === 1 ? "1 subagent" : `${subagentCount} subagents`;
  const statusLabel = [
    ...(stepCount > 0 ? [`${stepCount} ${stepCount === 1 ? "step" : "steps"}`] : []),
    ...(subagentCount > 0 ? [subagentLabel] : []),
    phase === "exiting" ? "Done" : phaseLabel,
  ].join(" · ");

  return (
    <div
      className={cn(
        "mt-2 flex items-center gap-2 px-4 py-2",
        phase === "exiting" && "narrative-indicator-exit",
      )}
      data-state={phase}
    >
      <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <StackedLayersIcon
          animated={phase === "running"}
          className={stackedLayersIconClassName(phase === "running")}
        />
        <span className="relative min-w-0 truncate">
          {statusLabel}
          {phase === "running" && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 text-foreground startup-activity-shimmer startup-activity-shimmer-text"
              data-startup-activity-shimmer-text={statusLabel}
            />
          )}
        </span>
      </span>
      {startTime !== undefined && (
        <span className="shrink-0 text-xs text-muted-foreground/50">
          ({formatDuration(elapsed)})
        </span>
      )}
    </div>
  );
}
