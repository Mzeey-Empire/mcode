import { useMemo } from "react";
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
}

/**
 * Returns the Tailwind `before:` dot color classes for a given narrative item.
 * Hook items use a smaller dot; blocked hooks use a destructive color.
 */
function dotClassForItem(item: NarrativeItem): string {
  // One muted color for completed items. Active items get primary + pulse.
  // Errors get diff-remove. Hooks get smaller dots.
  switch (item.type) {
    case "thought":
      return item.isActive ? "before:bg-primary before:animate-pulse" : "before:bg-muted-foreground/30";

    case "hook":
      return item.hook.didBlock
        ? "before:w-[3px] before:h-[3px] before:top-[9px] before:bg-[var(--diff-remove)]"
        : "before:w-[3px] before:h-[3px] before:top-[9px] before:bg-muted-foreground/25";

    case "subagent":
      if (item.toolCall.isError) return "before:bg-[var(--diff-remove)]";
      return item.toolCall.isComplete ? "before:bg-muted-foreground/30" : "before:bg-primary before:animate-pulse";

    case "active-tool":
      return "before:bg-primary before:animate-pulse";

    default:
      return "before:bg-muted-foreground/30";
  }
}

/**
 * Returns the top-margin class for a given narrative item.
 * The margin separates items visually on the timeline.
 */
function marginClassForItem(item: NarrativeItem, index: number): string {
  switch (item.type) {
    case "thought":
      return index === 0 ? "mt-0" : "mt-1.5";
    case "tool-group":
      return "mt-0";
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
}: NarrativeFlowProps) {
  const items = useMemo(
    () =>
      buildNarrativeItems({
        toolCalls,
        hooks,
        thoughtSegments,
        streamingText,
        isAgentRunning,
      }),
    [toolCalls, hooks, thoughtSegments, streamingText, isAgentRunning],
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
   */
  const mostActiveSubagentId = useMemo<string | null>(() => {
    const runningSubagents = items.filter(
      (item): item is Extract<NarrativeItem, { type: "subagent" }> =>
        item.type === "subagent" && !item.toolCall.isComplete,
    );
    if (runningSubagents.length === 0) return null;

    let bestId: string | null = null;
    let bestTime = -Infinity;
    for (const sa of runningSubagents) {
      // Find the most recent child startedAt within this subagent.
      // Fall back to 0 when startedAt is absent (optional field on ToolCall).
      const saStartedAt = sa.toolCall.startedAt ?? 0;
      const latestChild = sa.children.reduce<number>(
        (max, tc) => ((tc.startedAt ?? 0) > max ? (tc.startedAt ?? 0) : max),
        saStartedAt,
      );
      if (latestChild > bestTime) {
        bestTime = latestChild;
        bestId = sa.toolCall.id;
      }
    }
    return bestId;
  }, [items]);

  // Split items: timeline (thoughts, tools, etc.) renders inside the
  // padded/lined column. Delta (final streaming response) renders outside
  // as a standalone message-style block so it matches the eventual
  // MessageBubble that replaces it on turnComplete.
  const timelineItems = items.filter((it) => it.type !== "delta");
  const deltaItem = items.find((it) => it.type === "delta") as Extract<NarrativeItem, { type: "delta" }> | undefined;

  return (
    <div>
      {/* Timeline flow - only renders when there are items to show */}
      {timelineItems.length > 0 && (
        <div className="relative flex flex-col pl-[18px]">
          {/* Vertical timeline line - connects the dots between items */}
          <div className="absolute left-[7.5px] top-3 bottom-3 w-px bg-border pointer-events-none" />

          {timelineItems.map((item, i) => {
            const margin = marginClassForItem(item, i);
            const dot = dotClassForItem(item);

            return (
              <div
                key={keyForItem(item, i)}
                className={[
                  "relative",
                  margin,
                  // Shared dot pseudo-element base styles.
                  "before:content-[''] before:absolute before:w-1 before:h-1 before:rounded-full before:z-[1]",
                  "before:left-[-12px] before:top-[11px]",
                  dot,
                ].join(" ")}
              >
                {renderItem(item, mostActiveSubagentId, toolCalls)}
              </div>
            );
          })}
        </div>
      )}

      {/* Indicator bar sits between the timeline and the response. */}
      {isAgentRunning && (
        <NarrativeIndicator
          stepCount={stepCount}
          subagentCount={subagentCount}
          activeToolCalls={activeToolCalls}
          startTime={startTime}
        />
      )}

      {/* Final streaming response - rendered as a standalone message-style
          block so the visual transition to the persisted MessageBubble at
          turnComplete is seamless. */}
      {deltaItem && (
        <div className="mt-3">
          <DeltaBlock text={deltaItem.text} />
        </div>
      )}
    </div>
  );
}
