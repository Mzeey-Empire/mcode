import { z } from "zod";

/** Persisted hook execution (PreToolUse / PostToolUse / Stop etc.) linked to
 * an assistant message. */
export const HookExecutionRecordSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  hook_name: z.string(),
  tool_name: z.string().nullable(),
  phase: z.string(),
  payload: z.string(),
  duration_ms: z.number().nullable(),
  did_block: z.boolean(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  sort_order: z.number(),
});

/** Persisted hook execution linked to an assistant message. */
export type HookExecutionRecord = z.infer<typeof HookExecutionRecordSchema>;
