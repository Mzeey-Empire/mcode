import type { ToolCall, ThoughtSegmentRecord } from "@/transport/types";
import type { ThoughtSegment } from "./types";

/** True for the model's thinking. Reasoning never fills the answer slot, the answer tape, or the heading. */
export function isReasoningSegment(segment: Pick<ThoughtSegment, "kind"> | undefined): boolean {
  return segment?.kind === "reasoning";
}

/** Narration segments only; their concatenated text is the prefix the streamed answer buffer repeats. */
export function narrationSegments(segments: readonly ThoughtSegment[]): readonly ThoughtSegment[] {
  return segments.some(isReasoningSegment) ? segments.filter((segment) => !isReasoningSegment(segment)) : segments;
}

/** Computes live final-response text for the provisional assistant-message slot. */
export function computeLiveStreamingText(params: {
  thoughtSegments: readonly ThoughtSegment[];
  streamingText: string;
  isAgentRunning: boolean;
  toolCalls: readonly ToolCall[];
}): string {
  const { streamingText, isAgentRunning, toolCalls } = params;
  if (!isAgentRunning) return "";
  const thoughtSegments = narrationSegments(params.thoughtSegments);

  const anyToolRunning = toolCalls.some(
    (toolCall) => toolCall.parentToolCallId == null && !toolCall.isComplete,
  );
  if (anyToolRunning) return "";

  const lastSegment = thoughtSegments[thoughtSegments.length - 1];
  if (lastSegment && lastSegment.endedAt == null) {
    return lastSegment.isExplicitNonFinal ? "" : lastSegment.text;
  }

  const tape = thoughtSegments.filter((segment) => !segment.id?.startsWith("assistant-text:"))
    .map((segment) => segment.text).join("");
  return streamingText.startsWith(tape) && streamingText.length > tape.length
    ? streamingText.slice(tape.length)
    : "";
}

/** Removes live thought segments that repeat the committed assistant message body. */
export function filterThoughtsMatchingAssistantBody(
  segments: readonly ThoughtSegment[],
  messageBodyTrimmed: string,
): ThoughtSegment[] {
  if (messageBodyTrimmed.length === 0 || segments.length === 0) return [...segments];

  const latestStartedAt = Math.max(...segments.map((segment) => segment.startedAt));
  return segments.filter((segment) => {
    if (segment.id?.startsWith("assistant-text:") || isReasoningSegment(segment)) return true;
    const segmentTrimmed = segment.text.trim();
    if (segmentTrimmed.length > 0 && segmentTrimmed === messageBodyTrimmed) return false;
    return segment.startedAt !== latestStartedAt
      || segmentTrimmed.length === 0
      || !messageBodyTrimmed.endsWith(segmentTrimmed);
  });
}

/** Removes persisted thought rows that the server or message body identifies as final response text. */
export function filterPersistedFinalResponseThoughts(
  thoughts: readonly ThoughtSegmentRecord[],
  messageContent: string | undefined,
): readonly ThoughtSegmentRecord[] {
  if (thoughts.length === 0) return thoughts;

  const messageTrimmed = (messageContent ?? "").trim();
  const latestSortOrder = Math.max(...thoughts.map((thought) => thought.sort_order));
  return thoughts.filter((thought) => {
    if (thought.kind === "reasoning") return true;
    if (thought.is_final_response) return false;
    if (thought.id.startsWith("assistant-text:")) return true;
    const thoughtTrimmed = thought.text.trim();
    if (messageTrimmed.length > 0 && thoughtTrimmed === messageTrimmed) return false;
    return thought.sort_order !== latestSortOrder
      || thoughtTrimmed.length === 0
      || !messageTrimmed.endsWith(thoughtTrimmed);
  });
}
