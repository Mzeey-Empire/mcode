import { z } from "zod";
import { ThoughtSegmentRecordSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../../runtime/persistence/sqlite/database-write-operation.js";
import { narrativeWriteBatchLimitsSchema, narrativeWriteBatchResultSchema } from "./narrative-write-batches.js";

/** Validated input for one persisted thought segment. */
export const createThoughtSegmentInputSchema = z.object({
  id: z.string().optional(), messageId: z.string(), text: z.string(), startedAt: z.string(), endedAt: z.string().nullable(),
  sortOrder: z.number().int(), isFinalResponse: z.number().int().optional(),
}).strict();

/** Thought mutations admitted to the shared database owner. */
export const thoughtSegmentWriteOperations = {
  create: databaseWriteOperation("thoughtSegment.create", z.tuple([createThoughtSegmentInputSchema]), ThoughtSegmentRecordSchema()),
  bulkCreate: databaseWriteOperation("thoughtSegment.bulkCreate", z.tuple([z.array(createThoughtSegmentInputSchema), z.boolean().optional()]), z.void()),
  createBoundedBatch: databaseWriteOperation("thoughtSegment.createBoundedBatch", z.tuple([
    z.array(createThoughtSegmentInputSchema), narrativeWriteBatchLimitsSchema, z.boolean(),
  ]), narrativeWriteBatchResultSchema),
};
