import type { ToolCall, HookExecution } from "@/transport/types";
import type { ThoughtSegment, NarrativeItem, ToolGroup } from "./types";

/** Name of the Agent sub-agent tool used to identify sub-agent tool calls. */
const AGENT_TOOL_NAME = "Agent";

/**
 * Groups consecutive completed non-Agent tool calls into a ToolGroup.
 * Returns the group and the index of the last call included.
 */
function groupConsecutiveCompletedCalls(calls: ToolCall[], startIndex: number): { group: ToolGroup; endIndex: number } {
  const grouped: ToolCall[] = [];
  let i = startIndex;

  while (i < calls.length) {
    const tc = calls[i];
    if (tc.toolName === AGENT_TOOL_NAME || !tc.isComplete) break;
    grouped.push(tc);
    i++;
  }

  return { group: { calls: grouped }, endIndex: i - 1 };
}

/**
 * Determines whether any call in a group was cancelled.
 * A call is considered cancelled if its output contains "cancelled" (case-insensitive).
 */
function hasCancelledCall(calls: readonly ToolCall[]): boolean {
  return calls.some((tc) => typeof tc.output === "string" && tc.output.toLowerCase().includes("cancelled"));
}

/**
 * Transforms raw live state into an ordered NarrativeItem[] for the timeline.
 *
 * The function interleaves thoughts, tool groups, hooks, sub-agents, and the
 * active tool/delta into a chronologically ordered list suitable for rendering.
 * It is pure - no side effects, no store access - and is safe to call inside
 * a useMemo.
 */
export function buildNarrativeItems(params: {
  toolCalls: readonly ToolCall[];
  hooks: readonly HookExecution[];
  thoughtSegments: readonly ThoughtSegment[];
  streamingText: string;
  isAgentRunning: boolean;
}): NarrativeItem[] {
  const { toolCalls, hooks, thoughtSegments, streamingText, isAgentRunning } = params;

  // eslint-disable-next-line no-console
  console.debug("[narrative:build]", {
    segments: thoughtSegments.length,
    tools: toolCalls.length,
    hooks: hooks.length,
    streamLen: streamingText.length,
    running: isAgentRunning,
  });

  // Edge case: nothing at all.
  if (thoughtSegments.length === 0 && toolCalls.length === 0) {
    // Synthetic active thought when the agent just started streaming but no
    // segment has been recorded yet.
    if (isAgentRunning && streamingText.length > 0) {
      const syntheticSegment: ThoughtSegment = { text: streamingText, startedAt: Date.now() };
      return [{ type: "thought", segment: syntheticSegment, isActive: true }];
    }
    return [];
  }

  // Separate top-level from child tool calls.
  const topLevel: ToolCall[] = [];
  const childrenMap = new Map<string, ToolCall[]>();

  for (const tc of toolCalls) {
    if (tc.parentToolCallId == null) {
      topLevel.push(tc);
    } else {
      const siblings = childrenMap.get(tc.parentToolCallId) ?? [];
      siblings.push(tc);
      childrenMap.set(tc.parentToolCallId, siblings);
    }
  }

  // Sort top-level calls chronologically. Calls without startedAt go last.
  const sortedTopLevel = [...topLevel].sort((a, b) => {
    if (a.startedAt == null && b.startedAt == null) return 0;
    if (a.startedAt == null) return 1;
    if (b.startedAt == null) return -1;
    return a.startedAt - b.startedAt;
  });

  // Track which hooks have been placed so we can append unmatched ones at the end.
  const placedHookIndices = new Set<number>();

  /**
   * Finds hooks that relate to a set of tool calls by matching toolName, then
   * marks them as placed and returns them.
   */
  function hooksForCalls(calls: readonly ToolCall[]): HookExecution[] {
    const toolNames = new Set(calls.map((tc) => tc.toolName));
    const matched: HookExecution[] = [];
    hooks.forEach((hook, idx) => {
      if (!placedHookIndices.has(idx) && hook.toolName != null && toolNames.has(hook.toolName)) {
        placedHookIndices.add(idx);
        matched.push(hook);
      }
    });
    return matched;
  }

  const items: NarrativeItem[] = [];

  // Determine the active (incomplete, non-Agent) top-level call for later.
  // findLast is not available in the current TS target, so reverse and find.
  const activeTc =
    [...sortedTopLevel].reverse().find((tc: ToolCall) => !tc.isComplete && tc.toolName !== AGENT_TOOL_NAME) ?? null;

  // Identify calls that should be emitted during thought interleaving:
  // completed non-Agent calls and Agent calls (but not the activeTc).
  const toolsToPlace = new Set(sortedTopLevel.filter((tc) => tc !== activeTc));

  // Walk thought segments in order, emitting thoughts then interleaved tools.
  for (let segIdx = 0; segIdx < thoughtSegments.length; segIdx++) {
    const segment = thoughtSegments[segIdx];
    const isActive = segment.endedAt == null;

    items.push({ type: "thought", segment, isActive });

    // Find tools that started on or after this segment and before the next segment.
    const nextSegmentStart = thoughtSegments[segIdx + 1]?.startedAt ?? Infinity;
    const gapCalls = sortedTopLevel.filter(
      (tc) =>
        toolsToPlace.has(tc) &&
        (tc.startedAt == null || (tc.startedAt >= segment.startedAt && tc.startedAt < nextSegmentStart)),
    );

    // Remove these calls from the pending set.
    for (const tc of gapCalls) {
      toolsToPlace.delete(tc);
    }

    // Emit tool groups and sub-agents for the gap calls.
    emitCallsAsItems(gapCalls, childrenMap, hooks, hooksForCalls, items);
  }

  // Emit any remaining top-level calls that weren't placed after a thought
  // (e.g. tool calls with no preceding thought segments, or undefined startedAt).
  const remainingCalls = sortedTopLevel.filter((tc) => toolsToPlace.has(tc));
  emitCallsAsItems(remainingCalls, childrenMap, hooks, hooksForCalls, items);

  // Emit the active (in-progress) tool call.
  if (activeTc != null) {
    items.push({ type: "active-tool", toolCall: activeTc });

    // Place hooks related to the active tool call.
    const activeHooks = hooksForCalls([activeTc]);
    for (const hook of activeHooks) {
      items.push({ type: "hook", hook });
    }
  }

  // Append any unmatched hooks that have a toolName (skip session-level hooks
  // such as SessionStart:startup which have no associated tool call).
  hooks.forEach((hook, idx) => {
    if (!placedHookIndices.has(idx) && hook.toolName != null) {
      items.push({ type: "hook", hook });
    }
  });

  // The active thought segment already renders the streaming response with a
  // typing cursor, so a separate delta item would duplicate the text. Omit it.

  // eslint-disable-next-line no-console
  console.debug("[narrative:build] output", items.map((i) => ({ type: i.type, ...(i.type === "thought" ? { active: i.isActive, textLen: i.segment.text.length } : {}), ...(i.type === "tool-group" ? { count: i.group.calls.length } : {}), ...(i.type === "subagent" ? { name: i.toolCall.toolName, children: i.children.length, complete: i.toolCall.isComplete } : {}), ...(i.type === "active-tool" ? { name: i.toolCall.toolName, parent: i.toolCall.parentToolCallId } : {}) })));
  return items;
}

/**
 * Emits NarrativeItems for a list of top-level calls in order, grouping
 * consecutive completed non-Agent calls and treating Agent calls as sub-agents.
 */
function emitCallsAsItems(
  calls: ToolCall[],
  childrenMap: Map<string, ToolCall[]>,
  allHooks: readonly HookExecution[],
  hooksForCalls: (calls: readonly ToolCall[]) => HookExecution[],
  items: NarrativeItem[],
): void {
  let i = 0;
  while (i < calls.length) {
    const tc = calls[i];

    if (tc.toolName === AGENT_TOOL_NAME) {
      // Sub-agent: one item with its children and related hooks.
      const agentHooks = allHooks.filter((h) => h.toolName === AGENT_TOOL_NAME);
      items.push({
        type: "subagent",
        toolCall: tc,
        children: childrenMap.get(tc.id) ?? [],
        hooks: agentHooks,
      });
      i++;
      continue;
    }

    if (tc.isComplete) {
      // Group consecutive completed non-Agent calls.
      const { group, endIndex } = groupConsecutiveCompletedCalls(calls, i);
      if (group.calls.length > 0) {
        items.push({
          type: "tool-group",
          group,
          hasError: group.calls.some((c) => c.isError),
          hasCancelled: hasCancelledCall(group.calls),
        });

        // Place hooks related to the grouped calls.
        const groupHooks = hooksForCalls(group.calls);
        for (const hook of groupHooks) {
          items.push({ type: "hook", hook });
        }

        i = endIndex + 1;
        continue;
      }
    }

    // Incomplete non-Agent calls are handled as activeTc outside this function;
    // skip here to avoid double-emission.
    i++;
  }
}
