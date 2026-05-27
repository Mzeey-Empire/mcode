import type { ToolCall, HookExecution } from "@/transport/types";
import type { NarrationSegment, NarrativeItem, NarrativeBuildResult } from "./types";

const AGENT_TOOL_NAME = "Agent";

/**
 * Live response text that should fill the streaming-response virtual-item
 * slot — i.e. the text the user is actively watching type, which the
 * persisted `MessageBubble` will replace once the turn persists.
 *
 * Mirrors `buildNarrativeItems`'s internal delta-promotion logic so the live
 * timeline (which omits this content from its rows) and the streaming-response
 * slot stay in sync. Returns "" when there is nothing to render — caller
 * suppresses the virtual item in that case.
 *
 *  - When the latest narration segment is open and no tool is running, that
 *    segment IS the live response (tool-free turn, or pre-tool preamble that
 *    will be classified by the next `AssistantMessageBoundary`).
 *  - Otherwise, the suffix of `streamingText` past the closed-segment tape is
 *    the final-response text emitted after the last tool completed.
 */
export function computeLiveStreamingText(params: {
  narrationSegments: readonly NarrationSegment[];
  streamingText: string;
  isAgentRunning: boolean;
  toolCalls: readonly ToolCall[];
}): string {
  const { narrationSegments, streamingText, isAgentRunning, toolCalls } = params;
  if (!isAgentRunning) return "";

  const anyToolRunning = toolCalls.some(
    (tc) => tc.parentToolCallId == null && !tc.isComplete,
  );
  if (anyToolRunning) return "";

  const lastSeg = narrationSegments[narrationSegments.length - 1];
  if (lastSeg && lastSeg.endedAt == null) {
    return lastSeg.text;
  }

  const tape = narrationSegments.map((s) => s.text).join("");
  if (streamingText.startsWith(tape) && streamingText.length > tape.length) {
    return streamingText.slice(tape.length);
  }
  return "";
}

/**
 * Removes narration segments that duplicate the committed assistant message
 * body. Mirrors the client fallbacks in `buildPersistedNarrativeItems` so the
 * live trail does not repeat the bubble after `session.turnComplete` while
 * tool rows are still in volatile state (cleared on `session.turnStarted`).
 *
 * Distinct from the shared `isLikelyFinalResponseTail` predicate in
 * `@mcode/contracts`: the persisted path keys on `sortOrder`, this live path
 * keys on `startedAt` because volatile segments don't carry a sort order.
 */
export function filterNarrationMatchingAssistantBody(
  segments: readonly NarrationSegment[],
  messageBodyTrimmed: string,
): NarrationSegment[] {
  if (messageBodyTrimmed.length === 0 || segments.length === 0) {
    return [...segments];
  }
  let latestStartedAt = -Infinity;
  for (const s of segments) {
    if (s.startedAt > latestStartedAt) latestStartedAt = s.startedAt;
  }
  return segments.filter((s) => {
    const segTrimmed = s.text.trim();
    if (segTrimmed.length > 0 && segTrimmed === messageBodyTrimmed) return false;
    // Suffix on chronologically latest segment only (streaming tail split across bubble).
    if (
      s.startedAt === latestStartedAt &&
      segTrimmed.length > 0 &&
      messageBodyTrimmed.endsWith(segTrimmed)
    ) {
      return false;
    }
    return true;
  });
}

/** Returns true if any call in a group has output containing "cancelled". */
function hasCancelledCall(calls: readonly ToolCall[]): boolean {
  return calls.some((tc) => typeof tc.output === "string" && tc.output.toLowerCase().includes("cancelled"));
}

/** A unified timeline event - everything that happens during a turn, sorted by startedAt. */
type TimelineEvent =
  | { kind: "narration"; segment: NarrationSegment; startedAt: number }
  | { kind: "tool"; call: ToolCall; startedAt: number }
  | { kind: "hook"; hook: HookExecution; startedAt: number };

/**
 * Transforms raw live state into an ordered NarrativeItem[] for the timeline.
 *
 * All events (narration segments, tool calls, hooks) are placed in a single
 * chronological timeline sorted by startedAt. Consecutive completed non-Agent
 * tool calls are grouped into tool-group items.
 *
 * A narration row is rendered as "active" only when it is the latest segment
 * AND there are no running tool calls - if subagents are running, the parent
 * is waiting, not actively streaming.
 *
 * When the provider sends `textDelta.isFinalResponse`, final reply text stays
 * in `streamingText` but not in `narrationSegments`; the surplus over the
 * joined segment texts is appended as a `delta` row. When `isFinalResponse`
 * is omitted (legacy tool-free turns), the last open segment is still elevated
 * to `delta`.
 *
 * When `committedAssistantBody` is set (typically the last assistant bubble
 * after `session.turnComplete`), narration rows that only repeat that body are
 * omitted so they do not stack above the message while volatile tool rows are
 * still shown.
 *
 * @returns Ordered timeline items plus aggregate counts for `TurnFooter` and the indicator.
 */
export function buildNarrativeItems(params: {
  toolCalls: readonly ToolCall[];
  hooks: readonly HookExecution[];
  narrationSegments: readonly NarrationSegment[];
  streamingText: string;
  isAgentRunning: boolean;
  /** Trimmed comparison text: duplicate narration segments are hidden when non-empty. */
  committedAssistantBody?: string;
}): NarrativeBuildResult {
  const { toolCalls, hooks, streamingText, isAgentRunning, committedAssistantBody } = params;
  const assistantTrimmed = (committedAssistantBody ?? "").trim();
  const narrationSegments =
    assistantTrimmed.length > 0
      ? filterNarrationMatchingAssistantBody(params.narrationSegments, assistantTrimmed)
      : params.narrationSegments;

  if (narrationSegments.length === 0 && toolCalls.length === 0 && hooks.length === 0) {
    if (isAgentRunning && streamingText.length > 0) {
      // The agent is streaming its final (and only) response — no tools were
      // called, so this text IS the assistant reply, not a narration row.
      // Render as delta (full-weight prose) instead of a narration row (italic/dimmed).
      return {
        items: [{ type: "delta", text: streamingText }],
        counts: { steps: 0, narrationSegments: 0, subagents: 0 },
      };
    }
    return { items: [], counts: { steps: 0, narrationSegments: 0, subagents: 0 } };
  }

  // Separate top-level from child tool calls. A parent id that is null,
  // undefined, or empty string must be treated identically: empty string
  // never matches an Agent id and would silently drop the child from the
  // tree (childrenMap[""] is built but never read, orphaning the child).
  const topLevel: ToolCall[] = [];
  const childrenMap = new Map<string, ToolCall[]>();
  for (const tc of toolCalls) {
    const parent = tc.parentToolCallId;
    const hasParent = typeof parent === "string" && parent.length > 0;
    if (!hasParent) {
      topLevel.push(tc);
    } else {
      const siblings = childrenMap.get(parent) ?? [];
      siblings.push(tc);
      childrenMap.set(parent, siblings);
    }
  }

  // Determine the active tool (in-progress non-Agent top-level call).
  const activeTc = [...topLevel].reverse().find(
    (tc) => !tc.isComplete && tc.toolName !== AGENT_TOOL_NAME,
  ) ?? null;

  // Check whether any tool call is running. If yes, no narration row should
  // appear "active" because the parent agent is waiting on the tool, not
  // actively streaming.
  const anyToolRunning = topLevel.some((tc) => !tc.isComplete);
  // Build a unified timeline of everything sorted by startedAt.
  const timeline: TimelineEvent[] = [];
  for (const seg of narrationSegments) {
    timeline.push({ kind: "narration", segment: seg, startedAt: seg.startedAt });
  }
  for (const tc of topLevel) {
    if (tc === activeTc) continue; // Active tool emitted at the end
    timeline.push({ kind: "tool", call: tc, startedAt: tc.startedAt ?? Date.now() });
  }
  for (const hook of hooks) {
    timeline.push({ kind: "hook", hook, startedAt: hook.startedAt });
  }
  timeline.sort((a, b) => a.startedAt - b.startedAt);

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

  // Find the index of the last narration segment for active-state detection.
  const lastSegmentStartedAt = narrationSegments.length > 0
    ? narrationSegments[narrationSegments.length - 1].startedAt
    : -1;

  const narrationTape = narrationSegments.map((s) => s.text).join("");
  const streamingSuffix =
    isAgentRunning && !anyToolRunning && streamingText.startsWith(narrationTape)
      ? streamingText.slice(narrationTape.length)
      : "";

  let emittedFinalDeltaFromTape = false;

  for (const evt of timeline) {
    if (evt.kind === "narration") {
      flushGroup();
      const isLatest = evt.segment.startedAt === lastSegmentStartedAt;
      const isStreaming = evt.segment.endedAt == null;

      // Fallback when `isFinalResponse` never arrived: streamed text lives in the
      // latest open segment (`streamingSuffix` is empty).
      const useLegacyTapeFinalDelta =
        streamingSuffix === "" && isLatest && isStreaming && !anyToolRunning;
      if (useLegacyTapeFinalDelta) {
        items.push({ type: "delta", text: evt.segment.text });
        emittedFinalDeltaFromTape = true;
        continue;
      }

      // `isActive` drives `DeltaBlock.isStreaming` inside `NarrationBlock`.
      // While the agent turn is live, every narration segment (including ones
      // that have just closed because a tool_use boundary fired) animates
      // on appearance — preserving the typewriter feel for preamble text
      // that streams in, then snaps up to the timeline when its segment
      // closes. The DeltaBlock remount-threshold heuristic keeps the
      // re-animation to just the trailing edge for segments already past
      // their first paint, so the snap-up reads as "finishing typing" rather
      // than restarting from empty. Once the agent stops running, all
      // narration rows settle to static prose.
      const isActive = isAgentRunning;
      items.push({ type: "narration", segment: evt.segment, isActive });
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

  if (
    !emittedFinalDeltaFromTape &&
    streamingSuffix.length > 0 &&
    isAgentRunning
  ) {
    items.push({ type: "delta", text: streamingSuffix });
  }

  const subagents = topLevel.filter((tc) => tc.toolName === AGENT_TOOL_NAME).length;
  const steps = topLevel.length;
  const narrationSegmentCount = items.filter((it) => it.type === "narration").length;
  return {
    items,
    counts: { steps, narrationSegments: narrationSegmentCount, subagents },
  };
}
