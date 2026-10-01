import { z } from "zod";
import { databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";

const identity = z.string().min(1);
const result = z.object({ outcome: z.enum(["committed", "duplicate", "overflow"]),
  durableThrough: z.number().int().nonnegative(), committedItems: z.number().int().nonnegative(),
  committedBytes: z.number().int().nonnegative() });
const chunk = z.object({ executionId: identity, threadId: identity, turnId: identity,
  sequence: z.number().int().positive(), text: z.string().min(1) });

/** Allowlisted provisional-text mutations run on the same writer as canonical execution saves. */
export const parentAssistantTextWriteOperations = {
  appendChunk: databaseWriteOperation("parentText.appendChunk", z.array(chunk).min(1), result),
  appendRecoveredChunk: databaseWriteOperation("parentText.appendRecoveredChunk", chunk.omit({ sequence: true }).extend({
    firstSequence: z.number().int().positive(), lastSequence: z.number().int().positive(),
    byteLength: z.number().int().positive() }), result),
  reset: databaseWriteOperation("parentText.reset", identity, z.boolean()),
  resetForRetry: databaseWriteOperation("parentText.resetForRetry", identity, z.boolean()),
  retire: databaseWriteOperation("parentText.retire", identity, z.boolean()),
  retireTerminalCheckpoints: databaseWriteOperation("parentText.retireTerminalCheckpoints", z.void(), z.number().int().nonnegative()),
};
