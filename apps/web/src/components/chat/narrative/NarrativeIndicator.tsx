import { useState, useEffect, useMemo } from "react";
import type { ToolCall } from "@/transport/types";
import { TOOL_PHASE_LABELS } from "../tool-renderers/constants";

/** Format elapsed seconds as M:SS (e.g. 0:07, 1:23). */
function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  return m + ":" + String(totalSeconds % 60).padStart(2, "0");
}

/** Derive the current phase label from active tool calls. */
function derivePhaseLabel(toolCalls: readonly ToolCall[]): string {
  if (toolCalls.length === 0) return "Thinking...";

  const incomplete = toolCalls.filter((tc) => !tc.isComplete);
  if (incomplete.length > 0) {
    const latest = incomplete[incomplete.length - 1];
    return TOOL_PHASE_LABELS[latest.toolName] ?? "Working...";
  }

  return "Pulling the next step together...";
}

interface NarrativeIndicatorProps {
  /** Total number of steps executed so far in this agent turn. */
  stepCount: number;
  /** Number of subagent calls dispatched. Only rendered when > 0. */
  subagentCount: number;
  /** Currently active (possibly incomplete) tool calls. */
  activeToolCalls: readonly ToolCall[];
  /** Epoch ms when the agent turn started, used to compute elapsed time. */
  startTime?: number;
}

/**
 * Bottom bar of the narrative flow. Combines step count, optional subagent
 * count, phase label, and elapsed time into a single compact status line.
 *
 * Example outputs:
 *   ● 6 steps · Thinking... (0:22)
 *   ● 4 steps · 2 subagents · Thinking deeper... (0:15)
 *   ● 5 steps · Running a command... (0:38)
 */
export function NarrativeIndicator({
  stepCount,
  subagentCount,
  activeToolCalls,
  startTime,
}: NarrativeIndicatorProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) return;

    setElapsed(Math.floor((Date.now() - startTime) / 1000));

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  const phaseLabel = useMemo(() => derivePhaseLabel(activeToolCalls), [activeToolCalls]);

  const subagentLabel =
    subagentCount === 1 ? "1 subagent" : `${subagentCount} subagents`;

  return (
    <div className="flex items-center gap-2 px-2 py-2 mt-1.5 text-[0.8125rem]">
      <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
      <span className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
        {stepCount} {stepCount === 1 ? "step" : "steps"}
      </span>
      {subagentCount > 0 && (
        <>
          <span className="text-muted-foreground/45 text-[0.6875rem]">·</span>
          <span className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
            {subagentLabel}
          </span>
        </>
      )}
      <span className="text-muted-foreground/45 text-[0.6875rem]">·</span>
      <span className="text-muted-foreground">{phaseLabel}</span>
      {startTime !== undefined && (
        <span className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground/50">
          ({formatElapsed(elapsed)})
        </span>
      )}
    </div>
  );
}
