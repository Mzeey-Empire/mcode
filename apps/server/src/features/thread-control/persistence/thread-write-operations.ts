import { z } from "zod";
import { ContextWindowModeSchema, ThreadModeSchema, ThreadSchema, ThreadStatusSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";

const settings = z.object({
  model: z.string().optional(), provider: z.string().optional(),
  reasoning_level: z.string().optional(), interaction_mode: z.string().optional(),
  orchestration_mode: z.string().optional(), permission_mode: z.string().optional(),
  context_window_mode: ContextWindowModeSchema.nullable().optional(),
  thinking: z.boolean().nullable().optional(), codex_fast_mode: z.boolean().nullable().optional(),
  devin_mode: z.string().nullable().optional(),
  default_open_in_app: z.string().nullable().optional(),
});
const deadlineUpdate = z.object({ id: z.string(), userCompletedAt: z.string(), scheduledDeletionAt: z.string().nullable(), nextScheduledDeletionAt: z.string().nullable() });
const thread = ThreadSchema();
const idInput = z.tuple([z.string()]);
const pairInput = z.tuple([z.string(), z.string()]);
const booleanOutput = z.boolean();
const nullableThread = thread.nullable();
const booleanById = (name: string) => databaseWriteOperation(name, idInput, booleanOutput);
const booleanByPair = (name: string) => databaseWriteOperation(name, pairInput, booleanOutput);
const threadByPair = (name: string) => databaseWriteOperation(name, pairInput, nullableThread);

/** Allowlisted complete thread lifecycle operations on the shared writer. */
export const threadWriteOperations = {
  create: databaseWriteOperation("thread.create", z.tuple([
    z.string(), z.string(), ThreadModeSchema, z.string(), z.boolean().optional(), z.string().optional(),
    z.object({ parentThreadId: z.string(), forkedFromMessageId: z.string() }).optional(),
    z.enum(["named", "branchless"]).optional(), z.string().nullable().optional(),
  ]), thread),
  updateStatus: databaseWriteOperation("thread.updateStatus", z.tuple([z.string(), ThreadStatusSchema]), z.boolean()),
  complete: databaseWriteOperation("thread.complete", z.tuple([z.string(), z.string(), z.string().nullable()]), thread.nullable()),
  updateCompletedThreadDeadlines: databaseWriteOperation("thread.updateCompletedThreadDeadlines", z.tuple([z.array(deadlineUpdate).readonly()]), z.array(thread)),
  reopen: databaseWriteOperation("thread.reopen", z.tuple([z.string(), z.string().optional()]), thread.nullable()),
  claimRetentionCleanup: threadByPair("thread.claimRetentionCleanup"),
  releaseRetentionCleanup: databaseWriteOperation("thread.releaseRetentionCleanup", z.tuple([z.string()]), z.void()),
  blockRetentionCleanup: threadByPair("thread.blockRetentionCleanup"),
  retryRetentionCleanup: threadByPair("thread.retryRetentionCleanup"),
  updateWorktreePath: booleanByPair("thread.updateWorktreePath"),
  clearWorktreePath: booleanById("thread.clearWorktreePath"),
  updateCheckoutToNamedBranch: threadByPair("thread.updateCheckoutToNamedBranch"),
  updateCheckoutFromHead: databaseWriteOperation("thread.updateCheckoutFromHead", z.tuple([z.string(), z.string(), z.enum(["named", "branchless"]), z.string().nullable()]), z.object({ thread, changed: z.boolean() }).nullable()),
  softDelete: booleanById("thread.softDelete"),
  hardDelete: databaseWriteOperation("thread.hardDelete", z.tuple([z.string(), z.object({ preserveActiveDescendants: z.boolean().optional() }).optional()]), z.boolean()),
  updateProvider: booleanByPair("thread.updateProvider"),
  updateModel: booleanByPair("thread.updateModel"),
  updateSdkSessionId: booleanByPair("thread.updateSdkSessionId"),
  clearSdkSessionId: booleanById("thread.clearSdkSessionId"),
  updatePr: databaseWriteOperation("thread.updatePr", z.tuple([z.string(), z.number(), z.string()]), z.boolean()),
  updateContextUsage: databaseWriteOperation("thread.updateContextUsage", z.tuple([z.string(), z.number(), z.number().optional()]), z.boolean()),
  updateSettings: databaseWriteOperation("thread.updateSettings", z.tuple([z.string(), settings]), z.boolean()),
  updateTitle: booleanByPair("thread.updateTitle"),
  updateCompactSummary: databaseWriteOperation("thread.updateCompactSummary", z.tuple([z.string(), z.string()]), z.void()),
  updateLineage: databaseWriteOperation("thread.updateLineage", z.tuple([z.string(), z.string(), z.string()]), z.boolean()),
  updateDelegationLineage: databaseWriteOperation("thread.updateDelegationLineage", z.tuple([z.string(), z.object({ coordinatorThreadId: z.string(), creatorTurnId: z.string(), creatorToolCallId: z.string(), creationKind: z.literal("thread_delegation"), integrationId: z.string().optional() })]), z.boolean()),
  updateExternalCreator: booleanByPair("thread.updateExternalCreator"),
  nullifyExternalLineage: databaseWriteOperation("thread.nullifyExternalLineage", z.tuple([z.string()]), z.number().int()),
};
