import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/**
 * What a thought segment holds. `narration` is assistant prose between tool
 * calls; `reasoning` is provider reasoning (thinking) shown as a collapsed
 * Thought row.
 */
export const ThoughtSegmentKindSchema = lazySchema(() => z.enum(["narration", "reasoning"]));

/** What a thought segment holds: narration prose or provider reasoning. */
export type ThoughtSegmentKind = z.infer<ReturnType<typeof ThoughtSegmentKindSchema>>;

/** Persisted thought segment (a contiguous stretch of assistant narration or
 * provider reasoning captured between tool calls) linked to an assistant message. */
export const ThoughtSegmentRecordSchema = lazySchema(() => z.object({
  id: z.string(),
  message_id: z.string(),
  text: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  sort_order: z.number(),
  /**
   * Non-zero when this segment is the assistant's final user-facing response.
   * The client suppresses rendering these as ThoughtBlock rows to avoid
   * duplicating text already visible in the assistant message body.
   */
  is_final_response: z.number().optional(),
  /** Absent on rows written before reasoning had its own kind; read as `narration`. */
  kind: ThoughtSegmentKindSchema().optional(),
}));

/** Persisted thought segment linked to an assistant message. */
export type ThoughtSegmentRecord = z.infer<ReturnType<typeof ThoughtSegmentRecordSchema>>;
