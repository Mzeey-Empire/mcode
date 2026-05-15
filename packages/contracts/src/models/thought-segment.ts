import { z } from "zod";

/** Persisted thought segment (a contiguous stretch of assistant text deltas
 * captured between tool calls) linked to an assistant message. */
export const ThoughtSegmentRecordSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  text: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  sort_order: z.number(),
});

/** Persisted thought segment linked to an assistant message. */
export type ThoughtSegmentRecord = z.infer<typeof ThoughtSegmentRecordSchema>;
