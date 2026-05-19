import { useMemo, useState, useEffect } from "react";
import type { ToolCall, HookExecution } from "@/transport/types";
import type { ThoughtSegment, NarrativeItem } from "./types";
import { buildNarrativeItems } from "./build-narrative";
import { ThoughtBlock } from "./ThoughtBlock";
import { ToolSummaryLine } from "./ToolSummaryLine";
import { HookRow } from "./HookRow";
import { SubagentRow } from "./SubagentRow";
import { ActiveToolRow } from "./ActiveToolRow";
import { DeltaBlock } from "./DeltaBlock";
import { NarrativeIndicator } from "./NarrativeIndicator";
import { TurnFooter } from "./TurnFooter";

/** Props for the NarrativeFlow container component. */
export interface NarrativeFlowProps {
  /** All tool calls for the current agent turn. */
  toolCalls: readonly ToolCall[];
  /** All hook executions for the current agent turn. */
  hooks: readonly HookExecution[];
  /** Ordered thought segments accumulated during the agent turn. */
  thoughtSegments: readonly ThoughtSegment[];
  /** Partial streaming text not yet committed to a thought segment. */
  streamingText: string;
  /** Whether the agent is currently running. */
  isAgentRunning: boolean;
  /** Epoch ms when the agent turn started, used to derive elapsed time. */
  startTime?: number;
  /**
   * When the turn ended, the rendered assistant bubble text — duplicate thought
   * segments matching this body are suppressed until volatile state resets.
   */
  committedAssistantBody?: string;
}

/**
 * Returns the top-margin class for a given narrative item.
 *
 * Text rows get a comfortable gap so the response breathes apart from the
 * preceding action row. Tools, hooks, and sub-agents stack tightly into a
 * single "actions molecule" — they read as one group of agent activity
 * rather than independent timeline rows.
 */
function marginClassForItem(item: NarrativeItem, index: number): string {
  if (index === 0) return "mt-0";
  switch (item.type) {
    case "thought":
      return "mt-3";
    case "tool-group":
    case "hook":
      return "mt-0";
    case "subagent":
      return "mt-1";
    case "active-tool":
      return "mt-1";
    case "delta":
      return "mt-2";
    default:
      return "mt-0";
  }
}

/**
 * Returns a stable key string for a given narrative item and index.
 * Uses type-specific identifiers where available to avoid unnecessary re-mounts.
 */
function keyForItem(item: NarrativeItem, index: number): string {
  switch (item.type) {
    case "thought":
      return `thought-${item.segment.startedAt}`;
    case "tool-group":
      return `tool-group-${item.group.calls[0]?.id ?? index}`;
    case "hook":
      return `hook-${item.hook.hookName}-${item.hook.startedAt}`;
    case "subagent":
      return `subagent-${item.toolCall.id}`;
    case "active-tool":
      return `active-tool-${item.toolCall.id}`;
    case "delta":
      return "delta";
    default:
      return `item-${index}`;
  }
}

/**
 * Renders the correct child component for a given narrative item type.
 * `mostActiveSubagentId` is the tool call ID of the running subagent with the
 * most recent child activity - only that one receives the primary tint.
 */
function renderItem(item: NarrativeItem, _mostActiveSubagentId: string | null, allToolCalls: readonly ToolCall[]): React.ReactNode {
  switch (item.type) {
    case "thought":
      return <ThoughtBlock segment={item.segment} isActive={item.isActive} />;
    case "tool-group":
      return (
        <ToolSummaryLine
          group={item.group}
          hasError={item.hasError}
          hasCancelled={item.hasCancelled}
        />
      );
    case "hook":
      return <HookRow hook={item.hook} />;
    case "subagent":
      return (
        <SubagentRow
          toolCall={item.toolCall}
          children={item.children}
          hooks={item.hooks}
          allToolCalls={allToolCalls}
        />
      );
    case "active-tool":
      return <ActiveToolRow toolCall={item.toolCall} />;
    case "delta":
      return <DeltaBlock text={item.text} />;
    default:
      return null;
  }
}

/**
 * Main timeline container for the narrative flow.
 *
 * Renders a vertical line, dot markers for each item, and delegates
 * to the appropriate child component per narrative item type. When the
 * agent is running, a NarrativeIndicator bar is appended at the bottom.
 */
export function NarrativeFlow({
  toolCalls,
  hooks,
  thoughtSegments,
  streamingText,
  isAgentRunning,
  startTime,
  committedAssistantBody,
}: NarrativeFlowProps) {
  const { items, counts } = useMemo(
    () =>
      buildNarrativeItems({
        toolCalls,
        hooks,
        thoughtSegments,
        streamingText,
        isAgentRunning,
        committedAssistantBody,
      }),
    [
      toolCalls,
      hooks,
      thoughtSegments,
      streamingText,
      isAgentRunning,
      committedAssistantBody,
    ],
  );

  // stepCount: top-level tool calls (no parentToolCallId) + thought segments.
  const stepCount = useMemo(() => {
    const topLevelCount = toolCalls.filter((tc) => tc.parentToolCallId == null).length;
    return topLevelCount + thoughtSegments.length;
  }, [toolCalls, thoughtSegments]);

  // subagentCount: incomplete Agent tool calls.
  const subagentCount = useMemo(
    () =>
      toolCalls.filter(
        (tc) => tc.toolName === "Agent" && !tc.isComplete && tc.parentToolCallId == null,
      ).length,
    [toolCalls],
  );

  // Active tool calls passed to the indicator for phase label derivation.
  const activeToolCalls = useMemo(
    () => toolCalls.filter((tc) => !tc.isComplete && tc.parentToolCallId == null),
    [toolCalls],
  );

  /**
   * ID of the running subagent with the most recent child tool call `startedAt`.
   * Only this subagent receives the primary-tinted background.
   * Subagents with no defined timestamps are skipped so we never pick a false winner via `0` fallbacks.
   */
  const mostActiveSubagentId = useMemo<string | null>(() => {
    const runningSubagents = items.filter(
      (item): item is Extract<NarrativeItem, { type: "subagent" }> =>
        item.type === "subagent" && !item.toolCall.isComplete,
    );
    if (runningSubagents.length === 0) return null;

    const latestKnownActivity = (
      sa: Extract<NarrativeItem, { type: "subagent" }>,
    ): number | null => {
      const stamps: number[] = [];
      if (sa.toolCall.startedAt != null) stamps.push(sa.toolCall.startedAt);
      for (const tc of sa.children) {
        if (tc.startedAt != null) stamps.push(tc.startedAt);
      }
      return stamps.length === 0 ? null : Math.max(...stamps);
    };

    let bestId: string | null = null;
    let bestTime = -Infinity;
    for (const sa of runningSubagents) {
      const latest = latestKnownActivity(sa);
      if (latest == null) continue;
      if (latest > bestTime) {
        bestTime = latest;
        bestId = sa.toolCall.id;
      }
    }
    return bestId;
  }, [items]);

  /**
   * Wall-clock moment when this turn finished, snapshotted once via an
   * effect so the `TurnFooter` shows a stable duration. Reset to `null`
   * if the agent starts again (e.g. follow-up turn) so the next end
   * timestamp is captured fresh.
   */
  const [completedAt, setCompletedAt] = useState<number | null>(null);

  useEffect(() => {
    if (isAgentRunning) {
      setCompletedAt(null);
    } else if (completedAt == null) {
      setCompletedAt(Date.now());
    }
  }, [isAgentRunning, completedAt]);

  /**
   * Total elapsed time for this turn — `Date.now()` at end minus `startTime`.
   * Returns `null` while running, before the snapshot is taken, or when
   * `startTime` is unknown.
   */
  const completedDurationMs = useMemo<number | null>(() => {
    if (isAgentRunning || startTime == null || completedAt == null) return null;
    return Math.max(0, completedAt - startTime);
  }, [isAgentRunning, startTime, completedAt]);

  // Split items: timeline rows (tools, sub-agents, hooks, in-line text) all
  // render in chronological order. The delta (final streaming response) lives
  // outside the timeline so it can transition seamlessly into the persisted
  // MessageBubble on turnComplete.
  const timelineItems = items.filter((it) => it.type !== "delta");
  const deltaItem = items.find((it) => it.type === "delta") as Extract<NarrativeItem, { type: "delta" }> | undefined;

  return (
    <div className="relative">
      {/* Timeline — no vertical rail, no row dots. Each row component carries
          its own visual marker (chevron, icon, badge), and consecutive action
          rows (tools, hooks, sub-agents) stack tightly as one "actions
          molecule" while text rows breathe with a larger top margin. */}
      {timelineItems.length > 0 && (
        <div className="flex flex-col">
          {timelineItems.map((item, i) => (
            <div
              key={keyForItem(item, i)}
              className={[
                marginClassForItem(item, i),
                "narrative-row-enter",
              ].join(" ")}
            >
              {renderItem(item, mostActiveSubagentId, toolCalls)}
            </div>
          ))}
        </div>
      )}

      {/* While running: live indicator bar. */}
      {isAgentRunning && (
        <NarrativeIndicator
          stepCount={stepCount}
          subagentCount={subagentCount}
          activeToolCalls={activeToolCalls}
          startTime={startTime}
        />
      )}

      {/* Final streaming response — rendered immediately under the timeline
          rows so it reads as the agent's reply, not as a row in the timeline.
          The delta-row-enter animation matches the prose weight of the
          persisted MessageBubble that will replace it on turnComplete. */}
      {deltaItem && (
        <div className="mt-3 delta-row-enter">
          <DeltaBlock text={deltaItem.text} />
        </div>
      )}

      {/* Turn footer renders LAST — after the response body — so the step
          summary closes the turn instead of separating its actions from its
          answer. Hidden while the agent is still running or while a delta is
          still streaming (the latter means the turn has not yet transitioned
          to a completed state). */}
      {!isAgentRunning && timelineItems.length > 0 && !deltaItem && (
        <TurnFooter counts={counts} durationMs={completedDurationMs} />
      )}
    </div>
  );
}
