import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { ToolCallRecordSchema } from "./tool-call-record.js";
import { ThoughtSegmentRecordSchema } from "./thought-segment.js";
import { HookExecutionRecordSchema } from "./hook-execution.js";

/**
 * One entry in a Turn's chronological narrative, as returned by the
 * `turn.load` RPC. The server orders entries so the client renders in source
 * order without merging separate per-message streams client-side. This is the
 * single-source hydration that fixes the page-load ordering bug where Tool
 * calls rendered before the assistant message body.
 *
 * `sortOrder` is the within-message ordinal lifted from the underlying record
 * (`sort_order`); the assistant message body carries the `sortOrder` of its
 * final-response segment so the body interleaves correctly with tool calls.
 */
export const NarrativeEntrySchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("assistantMessage"),
      messageId: z.string(),
      sequence: z.number(),
      body: z.string(),
      sortOrder: z.number(),
    }),
    z.object({
      kind: z.literal("toolCall"),
      sequence: z.number(),
      sortOrder: z.number(),
      record: ToolCallRecordSchema(),
    }),
    z.object({
      kind: z.literal("narrationSegment"),
      sequence: z.number(),
      sortOrder: z.number(),
      record: ThoughtSegmentRecordSchema(),
    }),
    z.object({
      kind: z.literal("hook"),
      sequence: z.number(),
      sortOrder: z.number(),
      record: HookExecutionRecordSchema(),
    }),
  ]),
);

/** One chronologically-ordered narrative entry returned by `turn.load`. */
export type NarrativeEntry = z.infer<ReturnType<typeof NarrativeEntrySchema>>;

/** Stable discriminator order for one persisted narrative detail cursor. */
export const NarrativeDetailKindSchema = z.enum([
  "assistantMessage",
  "toolCall",
  "narrationSegment",
  "hook",
]);

/** Exclusive continuation position within a selected turn range. */
export const NarrativeDetailCursorSchema = lazySchema(() =>
  z.object({
    sequence: z.number().int(),
    sortOrder: z.number().int(),
    kind: NarrativeDetailKindSchema,
    id: z.string().trim().min(1).max(256),
  }).strict(),
);

/** Bounded detail window nested inside a message range. */
export const NarrativeDetailRangeSchema = lazySchema(() =>
  z.object({
    limit: z.number().int().min(1).max(200).optional(),
    after: NarrativeDetailCursorSchema().optional(),
  }).strict(),
);

export type NarrativeDetailKind = z.infer<typeof NarrativeDetailKindSchema>;
export type NarrativeDetailCursor = z.infer<ReturnType<typeof NarrativeDetailCursorSchema>>;
export type NarrativeDetailRange = z.infer<ReturnType<typeof NarrativeDetailRangeSchema>>;

/**
 * Optional load window for `turn.load`. Omit for the thread's recent narrative;
 * pass a sequence cursor for pagination. Mirrors `message.list` paging.
 */
export const TurnRangeSchema = lazySchema(() =>
  z.object({
    limit: z.number().int().min(1).max(200).optional(),
    before: z.number().int().optional(),
    detail: NarrativeDetailRangeSchema().optional(),
  }).strict(),
);

/** Optional load window for the `turn.load` RPC. */
export type TurnRange = z.infer<ReturnType<typeof TurnRangeSchema>>;
