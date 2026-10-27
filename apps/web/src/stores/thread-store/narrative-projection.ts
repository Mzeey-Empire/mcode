import type { StoredAttachment, ThoughtSegmentRecord, ToolCall } from "@/transport";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { ThoughtSegment } from "@/features/conversation/narrative/types";
import { isReasoningSegment } from "@/features/conversation/narrative/narrative-thought-classification";

function looksLikeContinuation(previousText: string, nextText: string): boolean {
  const lastCharacter = previousText.trimEnd().slice(-1);
  const previousEndsSentence = /[.!?]/.test(lastCharacter);
  const firstCharacter = nextText.replace(/^\s+/, "").slice(0, 1);
  const nextStartsLowercaseOrPunctuation = firstCharacter === ""
    || /[a-z,;:)\]}-]/.test(firstCharacter);
  return !previousEndsSentence || nextStartsLowercaseOrPunctuation;
}

function shouldReopenThought(last: ThoughtSegment | undefined, text: string): boolean {
  if (!last || last.endedAt === undefined || isReasoningSegment(last)) return false;
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
  if (isReasoningSegment(last)) return [...closeOpenSegments(segments), newThoughtSegment(text, isExplicitNonFinal)];
  const reopen = shouldReopenThought(last, text);
  if (!last || (last.endedAt !== undefined && !reopen)) {
    return [...segments, newThoughtSegment(text, isExplicitNonFinal)];
  }
  return [
    ...segments.slice(0, -1),
    extendThoughtSegment(last, text, isExplicitNonFinal, reopen),
  ];
}

function closeOpenSegments(segments: ThoughtSegment[]): ThoughtSegment[] {
  if (!segments.some((segment) => segment.endedAt === undefined)) return segments;
  const now = Date.now();
  return segments.map((segment) => segment.endedAt === undefined ? { ...segment, endedAt: now } : segment);
}

/** Closes the open reasoning segment, returning the same array when none is open. */
export function closeOpenReasoningSegment(segments: ThoughtSegment[]): ThoughtSegment[] {
  const last = segments.at(-1);
  if (!isReasoningSegment(last) || last?.endedAt !== undefined) return segments;
  return closeOpenSegments(segments);
}

/** One streamed reasoning fragment as carried by a `reasoningDelta` event. */
export interface ReasoningFragment {
  delta: string;
  reasoningItemId?: string;
  done?: boolean;
}

/**
 * Prefixed so a provider reasoning item id can never match a narration `textItemId`,
 * which keeps id-addressed narration lookups and boundaries off reasoning rows.
 */
function reasoningSegmentId(reasoningItemId: string): string {
  return `reasoning:${reasoningItemId}`;
}

function openReasoningIndex(segments: ThoughtSegment[], fragment: ReasoningFragment): number {
  if (fragment.reasoningItemId) {
    const id = reasoningSegmentId(fragment.reasoningItemId);
    return segments.findIndex((segment) => segment.id === id);
  }
  const lastIndex = segments.length - 1;
  const last = segments[lastIndex];
  return isReasoningSegment(last) && last?.endedAt === undefined ? lastIndex : -1;
}

function newReasoningSegment(fragment: ReasoningFragment): ThoughtSegment {
  const now = Date.now();
  return {
    ...(fragment.reasoningItemId ? { id: reasoningSegmentId(fragment.reasoningItemId) } : {}),
    text: fragment.delta,
    startedAt: now,
    kind: "reasoning",
    isExplicitNonFinal: true,
    ...(fragment.done ? { endedAt: now } : {}),
  };
}

/**
 * Appends one reasoning fragment as its own segment kind. Reasoning never extends
 * narration, and a fragment for an already closed reasoning item is ignored.
 */
export function appendReasoningSegment(segments: ThoughtSegment[], fragment: ReasoningFragment): ThoughtSegment[] {
  const index = openReasoningIndex(segments, fragment);
  if (index < 0) {
    const opensBlock = fragment.delta.length > 0 || (fragment.reasoningItemId !== undefined && fragment.done !== true);
    return opensBlock ? [...closeOpenSegments(segments), newReasoningSegment(fragment)] : segments;
  }
  const owned = segments[index];
  if (!owned || owned.endedAt !== undefined) return segments;
  const extended = { ...owned, text: owned.text + fragment.delta, ...(fragment.done ? { endedAt: Date.now() } : {}) };
  return segments.map((segment, candidateIndex) => candidateIndex === index ? extended : segment);
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
  if (isReasoningSegment(segment)) return closeOpenReasoningSegment(segments);
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
    ...(record.kind === "reasoning" ? { kind: "reasoning" as const, isExplicitNonFinal: true } : {}),
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
