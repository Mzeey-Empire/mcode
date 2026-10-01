import { z } from "zod";
import { HookExecutionRecordSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { narrativeWriteBatchLimitsSchema, narrativeWriteBatchResultSchema } from "../../conversation/narrative/persistence/narrative-write-batches.js";

/** Validated input for one persisted hook execution. */
export const createHookExecutionInputSchema = z.object({
  id: z.string().optional(), messageId: z.string(), hookName: z.string(), toolName: z.string().nullable(), phase: z.string(),
  payload: z.string(), durationMs: z.number().nonnegative().nullable(), didBlock: z.boolean(),
  startedAt: z.string(), endedAt: z.string().nullable(), sortOrder: z.number().int(),
}).strict();

/** Hook mutations admitted to the shared database owner. */
export const hookExecutionWriteOperations = {
  create: databaseWriteOperation("hookExecution.create", z.tuple([createHookExecutionInputSchema]), HookExecutionRecordSchema()),
  bulkCreate: databaseWriteOperation("hookExecution.bulkCreate", z.tuple([z.array(createHookExecutionInputSchema), z.boolean().optional()]), z.void()),
  createBoundedBatch: databaseWriteOperation("hookExecution.createBoundedBatch", z.tuple([
    z.array(createHookExecutionInputSchema), narrativeWriteBatchLimitsSchema, z.boolean(),
  ]), narrativeWriteBatchResultSchema),
};
