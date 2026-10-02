import type { StoredAttachment, ThoughtSegmentRecord, ToolCall } from "@/transport";
import type { AgentEvent } from "@mcode/contracts";
import type { ThoughtSegment } from "@/features/conversation/narrative/types";

function looksLikeContinuation(previousText: string, nextText: string): boolean {
  const lastCharacter = previousText.trimEnd().slice(-1);
  const previousEndsSentence = /[.!?]/.test(lastCharacter);
  const firstCharacter = nextText.replace(/^\s+/, "").slice(0, 1);
  const nextStartsLowercaseOrPunctuation = firstCharacter === ""
    || /[a-z,;:)\]}-]/.test(firstCharacter);
  return !previousEndsSentence || nextStartsLowercaseOrPunctuation;
}

function shouldReopenThought(last: ThoughtSegment | undefined, text: string): boolean {
  if (!last || last.endedAt === undefined) return false;
  return last.text.length < 40 || looksLikeContinuation(last.text, text);
}

function newThoughtSegment(text: string, isExplicitNonFinal: boolean): ThoughtSegment {
  return {
    text,
    startedAt: Date.now(),
    ...(isExplicitNonFinal ? { isExplicitNonFinal: true } : {}),
  };
}

function extendThoughtSegment(
  last: ThoughtSegment,
  text: string,
  isExplicitNonFinal: boolean,
  reopen: boolean,
): ThoughtSegment {
  const next = {
    ...last,
    text: last.text + text,
    ...(isExplicitNonFinal ? { isExplicitNonFinal: true } : {}),
  };
  if (reopen) delete (next as { endedAt?: number }).endedAt;
  return next;
}

/** Appends one streamed thought fragment while preserving turn segment boundaries. */
export function appendThoughtSegment(
  segments: ThoughtSegment[],
  text: string,
  isExplicitNonFinal: boolean,
  textItemId?: string,
): ThoughtSegment[] {
  if (text.length === 0) return segments;
  if (textItemId) {
    const owned = segments.findIndex((segment) => segment.id === textItemId);
    if (owned >= 0) return segments.map((segment, index) => index === owned && segment.endedAt === undefined
      ? { ...segment, text: segment.text + text } : segment);
    const now = Date.now();
    return [...segments.map((segment) => segment.endedAt === undefined ? { ...segment, endedAt: now } : segment),
      { ...newThoughtSegment(text, isExplicitNonFinal), id: textItemId }];
  }
  const last = segments.at(-1);
  const reopen = shouldReopenThought(last, text);
  if (!last || (last.endedAt !== undefined && !reopen)) {
    return [...segments, newThoughtSegment(text, isExplicitNonFinal)];
  }
  return [
    ...segments.slice(0, -1),
    extendThoughtSegment(last, text, isExplicitNonFinal, reopen),
  ];
}

/** Applies an authoritative boundary to the exact open or closed item when identified. */
export function projectAssistantMessageBoundary(
  segments: ThoughtSegment[],
  boundary: boolean | Extract<AgentEvent, { type: "assistantMessageBoundary" }>,
): ThoughtSegment[] | undefined {
  const event = typeof boundary === "boolean" ? { isFinalResponse: boundary } : boundary;
  const index = "textItemId" in event && event.textItemId
    ? segments.findIndex((segment) => segment.id === event.textItemId)
    : segments.length - 1;
  const segment = segments[index];
  if (!segment || (!("textItemId" in event && event.textItemId) && segment.endedAt !== undefined)) return undefined;
  if (event.isFinalResponse) return segments.filter((_, candidateIndex) => candidateIndex !== index);
  return segments.map((candidate, candidateIndex) => candidateIndex === index
    ? { ...candidate, text: "content" in event && event.content !== undefined ? event.content : candidate.text,
      endedAt: candidate.endedAt ?? Date.now() } : candidate);
}

/** Updates tool progress without notifying state subscribers when no call changed. */
export function projectToolProgress(
  toolCalls: ToolCall[],
  toolCallId: string,
  elapsedSeconds: number,
  lastActivityAt: number,
): ToolCall[] | undefined {
  let changed = false;
  const projected = toolCalls.map((toolCall) => {
    if (toolCall.id !== toolCallId || toolCall.isComplete) return toolCall;
    changed = true;
    return { ...toolCall, elapsedSeconds, lastActivityAt };
  });
  return changed ? projected : undefined;
}

function isStoredAttachment(value: unknown): value is StoredAttachment {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.name === "string"
    && typeof record.mimeType === "string"
    && typeof record.sizeBytes === "number";
}

/** Parses persisted assistant attachments from a provider event value. */
export function parseStoredAttachments(value: unknown): StoredAttachment[] {
  return Array.isArray(value) ? value.filter(isStoredAttachment) : [];
}

/** Maps one persisted thought row to the live narrative segment shape. */
export function persistedThoughtToSegment(record: ThoughtSegmentRecord): ThoughtSegment {
  const startedAt = Date.parse(record.started_at);
  const endedAt = record.ended_at ? Date.parse(record.ended_at) : NaN;
  return {
    id: record.id,
    text: record.text,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    endedAt: Number.isFinite(endedAt) ? endedAt : undefined,
  };
}

/** Filters final-response thoughts out of persisted narrative data. */
export function visiblePersistedThoughtSegments(
  thoughts: readonly ThoughtSegmentRecord[],
): ThoughtSegment[] {
  return thoughts
    .filter((thought) => !thought.is_final_response)
    .map(persistedThoughtToSegment);
}
