import { z } from "zod";
import { ToolCallRecordSchema, ToolCallStatusSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { narrativeWriteBatchLimitsSchema, narrativeWriteBatchResultSchema } from "../../conversation/narrative/persistence/narrative-write-batches.js";

/** Validated provider-neutral input for one persisted tool call. */
export const createToolCallRecordInputSchema = z.object({
  toolCallId: z.string().optional(), messageId: z.string(), toolName: z.string(), displayName: z.string().optional(),
  providerAgentKey: z.string().optional(), subagentIdentityKey: z.string().optional(), subagentProviderName: z.string().optional(),
  subagentPrompt: z.string().optional(), subagentType: z.string().optional(), subagentAgentId: z.string().optional(),
  subagentDurationMs: z.number().int().nonnegative().optional(), model: z.string().optional(), reasoningEffort: z.string().optional(),
  inputSummary: z.string(), outputSummary: z.string(), outputTruncated: z.boolean().optional(),
  outputTotalBytes: z.number().int().nonnegative().optional(), outputArtifactPath: z.string().optional(), exitCode: z.number().int().optional(),
  status: ToolCallStatusSchema, startedAt: z.string().optional(), completedAt: z.string().optional(),
  sortOrder: z.number().int(), parentToolCallId: z.string().optional(),
}).strict();

/** Tool mutations admitted to the shared database owner. */
export const toolCallRecordWriteOperations = {
  create: databaseWriteOperation("toolCallRecord.create", z.tuple([createToolCallRecordInputSchema]), ToolCallRecordSchema()),
  bulkCreate: databaseWriteOperation("toolCallRecord.bulkCreate", z.tuple([z.array(createToolCallRecordInputSchema), z.boolean().optional()]), z.void()),
  createBoundedBatch: databaseWriteOperation("toolCallRecord.createBoundedBatch", z.tuple([
    z.array(createToolCallRecordInputSchema), narrativeWriteBatchLimitsSchema, z.boolean(),
  ]), narrativeWriteBatchResultSchema),
  updateSubagentIdentity: databaseWriteOperation("toolCallRecord.updateSubagentIdentity", z.tuple([z.string(), z.string(), z.string()]), z.boolean()),
};
