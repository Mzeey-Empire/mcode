import { z } from "zod";

/**
 * Persisted narration segment: a contiguous group of assistant text deltas
 * emitted **before** a tool call within a turn — the agent's narration of
 * what it is about to do. Distinct from the final-response text (deltas
 * emitted after all tool calls have resolved) and from SDK reasoning blocks
 * (emitted only when extended thinking is enabled).
 */
export const NarrationSegmentRecordSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  text: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  sort_order: z.number(),
  /**
   * Non-zero when this segment is the assistant's final user-facing response.
   * The client suppresses rendering these as narration rows to avoid
   * duplicating text already visible in the assistant message body.
   */
  is_final_response: z.number().optional(),
});

/** Persisted narration segment linked to an assistant message. */
export type NarrationSegmentRecord = z.infer<typeof NarrationSegmentRecordSchema>;

/**
 * Minimal shape accepted by `isLikelyFinalResponseTail`. The classifier
 * doesn't care whether the caller is holding camelCase create-input rows
 * (server, pre-persist) or snake_case persisted records (client, post-load) —
 * both sides adapt to this view before calling.
 */
export interface NarrationSegmentTailInput {
  /** Raw segment text as streamed. Compared after trimming. */
  text: string;
  /** Server-allocated chronological position within the turn. */
  sortOrder: number;
}

/**
 * Decide whether `segment` looks like the assistant's final-response text
 * masquerading as a narration segment. Used as a safety net on both sides
 * of the persistence boundary:
 *
 * - Server (pre-persist): tag matching segments with `is_final_response = 1`
 *   so the client doesn't render them as narration rows.
 * - Client (post-load): drop matching segments at render time as a backstop
 *   for rows persisted before the server-side tagging existed.
 *
 * Two cases qualify:
 * 1. The trimmed segment text equals the trimmed assistant message body —
 *    catches tool-free turns where the entire "narration" buffer is the
 *    final response.
 * 2. The trimmed segment is the chronologically last segment (highest
 *    `sortOrder`) **and** the trimmed message body ends with it — catches
 *    the common case where the model narrates, calls tools, then narrates
 *    the final answer as the trailing segment.
 */
export function isLikelyFinalResponseTail(
  segment: NarrationSegmentTailInput,
  allSegments: readonly NarrationSegmentTailInput[],
  messageBody: string,
): boolean {
  const bodyTrimmed = messageBody.trim();
  if (bodyTrimmed.length === 0) return false;

  const segTrimmed = segment.text.trim();
  if (segTrimmed.length === 0) return false;

  if (segTrimmed === bodyTrimmed) return true;

  let maxSortOrder = -Infinity;
  for (const s of allSegments) {
    if (s.sortOrder > maxSortOrder) maxSortOrder = s.sortOrder;
  }

  return segment.sortOrder === maxSortOrder && bodyTrimmed.endsWith(segTrimmed);
}
