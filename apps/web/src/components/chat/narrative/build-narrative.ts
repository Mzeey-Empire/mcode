import type { ToolCall, HookExecution } from "@/transport/types";
import type { ThoughtSegment, NarrativeItem, NarrativeBuildResult } from "./types";

const AGENT_TOOL_NAME = "Agent";

/** Returns true if any call in a group has output containing "cancelled". */
function hasCancelledCall(calls: readonly ToolCall[]): boolean {
  return calls.some((tc) => typeof tc.output === "string" && tc.output.toLowerCase().includes("cancelled"));
}

/** A unified timeline event - everything that happens during a turn, sorted by startedAt. */
type TimelineEvent =
  | { kind: "thought"; segment: ThoughtSegment; startedAt: number }
  | { kind: "tool"; call: ToolCall; startedAt: number }
  | { kind: "hook"; hook: HookExecution; startedAt: number };

/**
 * Transforms raw live state into an ordered NarrativeItem[] for the timeline.
 *
 * All events (thoughts, tool calls, hooks) are placed in a single chronological
 * timeline sorted by startedAt. Consecutive completed non-Agent tool calls are
 * grouped into tool-group items.
 *
 * A thought is rendered as "active" only when it is the latest segment AND
 * there are no running tool calls - if subagents are running, the parent
 * is waiting, not actively streaming.
 */
export function buildNarrativeItems(params: {
  toolCalls: readonly ToolCall[];
  hooks: readonly HookExecution[];
  thoughtSegments: readonly ThoughtSegment[];
  streamingText: string;
  isAgentRunning: boolean;
}): NarrativeBuildResult {
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
      // The agent is streaming its final (and only) response — no tools were
      // called, so this text IS the assistant reply, not a reasoning step.
      // Render as delta (full-weight prose) instead of a thought (italic/dimmed).
      return {
        items: [{ type: "delta", text: streamingText }],
        counts: { steps: 0, thoughts: 0, subagents: 0 },
      };
    }
    return { items: [], counts: { steps: 0, thoughts: 0, subagents: 0 } };
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

  // Determine the active tool (in-progress non-Agent top-level call).
  const activeTc = [...topLevel].reverse().find(
    (tc) => !tc.isComplete && tc.toolName !== AGENT_TOOL_NAME,
  ) ?? null;

  // Check whether any tool call is running. If yes, no thought should appear "active"
  // because the parent agent is waiting on the tool, not actively streaming.
  const anyToolRunning = topLevel.some((tc) => !tc.isComplete);
  // eslint-disable-next-line no-console
  console.debug("[narrative:build] running state", { anyToolRunning, activeTcId: activeTc?.id });

  // Build a unified timeline of everything sorted by startedAt.
  const timeline: TimelineEvent[] = [];
  for (const seg of thoughtSegments) {
    timeline.push({ kind: "thought", segment: seg, startedAt: seg.startedAt });
  }
  for (const tc of topLevel) {
    if (tc === activeTc) continue; // Active tool emitted at the end
    timeline.push({ kind: "tool", call: tc, startedAt: tc.startedAt ?? Date.now() });
  }
  for (const hook of hooks) {
    timeline.push({ kind: "hook", hook, startedAt: hook.startedAt });
  }
  timeline.sort((a, b) => a.startedAt - b.startedAt);

  // eslint-disable-next-line no-console
  console.debug("[narrative:build] timeline order",
    timeline.map((e) => ({ kind: e.kind, t: e.startedAt, label:
      e.kind === "thought" ? `thought(${e.segment.text.slice(0, 20)})` :
      e.kind === "tool" ? `${e.call.toolName}` :
      `${e.hook.hookName}` })));

  const items: NarrativeItem[] = [];
  const pendingGroup: ToolCall[] = [];

  const flushGroup = () => {
    if (pendingGroup.length === 0) return;
    items.push({
      type: "tool-group",
      group: { calls: pendingGroup.slice() },
      hasError: pendingGroup.some((c) => c.isError),
      hasCancelled: hasCancelledCall(pendingGroup),
    });
    pendingGroup.length = 0;
  };

  // Find the index of the last thought segment for active-state detection.
  const lastSegmentStartedAt = thoughtSegments.length > 0
    ? thoughtSegments[thoughtSegments.length - 1].startedAt
    : -1;

  for (const evt of timeline) {
    if (evt.kind === "thought") {
      flushGroup();
      const isLatest = evt.segment.startedAt === lastSegmentStartedAt;
      const isStreaming = evt.segment.endedAt == null;

      // The latest segment that's streaming AFTER all tool calls completed
      // is the final response - render it as a delta (message-style) instead
      // of a thought. This makes the turn-complete swap visually seamless.
      const isFinalResponse = isLatest && isStreaming && !anyToolRunning;
      if (isFinalResponse) {
        items.push({ type: "delta", text: evt.segment.text });
        continue;
      }

      // Regular thinking segment - render as a quiet thought block.
      // isActive (highlighted background) only when streaming AND nothing
      // else is running. Since isFinalResponse covers that case, this is
      // effectively always false here - but kept for explicitness.
      const isActive = isLatest && isStreaming && !anyToolRunning;
      items.push({ type: "thought", segment: evt.segment, isActive });
      continue;
    }

    if (evt.kind === "hook") {
      flushGroup();
      items.push({ type: "hook", hook: evt.hook });
      continue;
    }

    // Tool call
    const tc = evt.call;
    if (tc.toolName === AGENT_TOOL_NAME) {
      flushGroup();
      items.push({
        type: "subagent",
        toolCall: tc,
        children: childrenMap.get(tc.id) ?? [],
        hooks: hooks.filter((h) => h.toolName === AGENT_TOOL_NAME),
      });
      continue;
    }

    if (tc.isComplete) {
      pendingGroup.push(tc);
      continue;
    }

    // Incomplete non-Agent call that isn't the activeTc - rare, skip.
  }
  flushGroup();

  if (activeTc != null) {
    items.push({ type: "active-tool", toolCall: activeTc });
  }

  // eslint-disable-next-line no-console
  console.debug("[narrative:build] output", items.map((i) => ({
    type: i.type,
    ...(i.type === "thought" ? { active: i.isActive } : {}),
    ...(i.type === "subagent" ? { name: i.toolCall.toolName, children: i.children.length } : {}),
  })));
  const subagents = topLevel.filter((tc) => tc.toolName === AGENT_TOOL_NAME).length;
  const steps = topLevel.length;
  const thoughts = items.filter((it) => it.type === "thought").length;
  return { items, counts: { steps, thoughts, subagents } };
}
