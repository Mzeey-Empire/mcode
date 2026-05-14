import type { ToolCall, HookExecution } from "@/transport/types";
import type { ThoughtSegment, NarrativeItem } from "./types";

const AGENT_TOOL_NAME = "Agent";

/** Determines whether any call in a group was cancelled. */
function hasCancelledCall(calls: readonly ToolCall[]): boolean {
  return calls.some((tc) => typeof tc.output === "string" && tc.output.toLowerCase().includes("cancelled"));
}

/** A unified timeline event used to interleave tool calls and hooks chronologically. */
type TimelineEvent =
  | { kind: "tool"; call: ToolCall; startedAt: number }
  | { kind: "hook"; hook: HookExecution; index: number; startedAt: number };

/**
 * Transforms raw live state into an ordered NarrativeItem[] for the timeline.
 *
 * Interleaves thoughts, tool groups, hooks, and sub-agents chronologically based
 * on their startedAt timestamps. Hooks appear inline with tool calls in the
 * order they fired, not grouped at the end.
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

  if (thoughtSegments.length === 0 && toolCalls.length === 0 && hooks.length === 0) {
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

  // eslint-disable-next-line no-console
  const agents = topLevel.filter((tc) => tc.toolName === "Agent");
  if (agents.length > 0) {
    console.debug("[narrative:build] agent mapping", agents.map((a) => ({
      id: a.id,
      desc: String((a.toolInput as Record<string, unknown>).description ?? "").slice(0, 40),
      children: (childrenMap.get(a.id) ?? []).length,
      complete: a.isComplete,
    })));
  }

  // Build a chronologically sorted timeline of top-level tool calls AND hooks.
  // Hooks that are children of a subagent (matched by toolName to a child call)
  // are NOT placed at the top level - they belong inside the SubagentRow.
  const childToolNames = new Set<string>();
  for (const kids of childrenMap.values()) {
    for (const k of kids) childToolNames.add(k.toolName);
  }

  const timeline: TimelineEvent[] = [];
  for (const tc of topLevel) {
    timeline.push({ kind: "tool", call: tc, startedAt: tc.startedAt ?? 0 });
  }
  hooks.forEach((hook, index) => {
    timeline.push({ kind: "hook", hook, index, startedAt: hook.startedAt });
  });
  timeline.sort((a, b) => a.startedAt - b.startedAt);

  // Determine the active (in-progress non-Agent) top-level call.
  const activeTc =
    [...topLevel].reverse().find((tc) => !tc.isComplete && tc.toolName !== AGENT_TOOL_NAME) ?? null;

  const items: NarrativeItem[] = [];

  // Walk thought segments, emitting thoughts and the timeline events between them.
  let timelineIdx = 0;
  const flushTimelineUntil = (boundary: number) => {
    let i = timelineIdx;
    const pendingCompletedTools: ToolCall[] = [];
    const flushPendingGroup = () => {
      if (pendingCompletedTools.length === 0) return;
      items.push({
        type: "tool-group",
        group: { calls: pendingCompletedTools.slice() },
        hasError: pendingCompletedTools.some((c) => c.isError),
        hasCancelled: hasCancelledCall(pendingCompletedTools),
      });
      pendingCompletedTools.length = 0;
    };

    while (i < timeline.length && timeline[i].startedAt < boundary) {
      const evt = timeline[i];

      if (evt.kind === "hook") {
        flushPendingGroup();
        items.push({ type: "hook", hook: evt.hook });
        i++;
        continue;
      }

      const tc = evt.call;
      if (tc === activeTc) {
        // Skip the active tool here - emitted at the end.
        i++;
        continue;
      }

      if (tc.toolName === AGENT_TOOL_NAME) {
        flushPendingGroup();
        items.push({
          type: "subagent",
          toolCall: tc,
          children: childrenMap.get(tc.id) ?? [],
          hooks: hooks.filter((h) => h.toolName === AGENT_TOOL_NAME),
        });
        i++;
        continue;
      }

      if (tc.isComplete) {
        pendingCompletedTools.push(tc);
        i++;
        continue;
      }

      // Incomplete non-Agent calls that aren't the activeTc - rare, skip.
      i++;
    }
    flushPendingGroup();
    timelineIdx = i;
  };

  for (let segIdx = 0; segIdx < thoughtSegments.length; segIdx++) {
    const segment = thoughtSegments[segIdx];
    items.push({ type: "thought", segment, isActive: segment.endedAt == null });
    const nextStart = thoughtSegments[segIdx + 1]?.startedAt ?? Infinity;
    flushTimelineUntil(nextStart);
  }

  // Flush any remaining timeline events (no thought segments, or events after the last thought).
  flushTimelineUntil(Infinity);

  // Emit the active (in-progress) tool call last.
  if (activeTc != null) {
    items.push({ type: "active-tool", toolCall: activeTc });
  }

  // eslint-disable-next-line no-console
  console.debug("[narrative:build] output", items.map((i) => ({ type: i.type })));
  return items;
}
