import { z } from "zod";
import { ThreadSchema } from "@mcode/contracts";
import { databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";

const jobInput = z.object({ thread_id: z.string(), workspace_path: z.string(), worktree_path: z.string().nullable(), branch: z.string().nullable(), kind: z.enum(["explicit", "retention"]).optional() });
/** Validated committed cleanup state returned across the writer boundary. */
export const cleanupJobSchema = z.object({
  id: z.string(), thread_id: z.string(), workspace_path: z.string(), worktree_path: z.string().nullable(), branch: z.string().nullable(), kind: z.enum(["explicit", "retention"]),
  attempts: z.number().int(), next_retry_at: z.number(), last_error: z.string().nullable(), created_at: z.number(),
});

/** Allowlisted complete cleanup ledger mutations on the shared writer. */
export const cleanupJobWriteOperations = {
  claimRetentionJob: databaseWriteOperation("cleanupJob.claimRetentionJob", z.tuple([z.string(), z.string(), z.string()]), ThreadSchema().nullable()),
  completeThreads: databaseWriteOperation("cleanupJob.completeThreads", z.tuple([z.string(), z.array(z.string()).readonly()]), z.void()),
  recordFailureWithRetention: databaseWriteOperation("cleanupJob.recordFailureWithRetention", z.tuple([z.string(), z.string(), z.enum(["explicit", "retention"]), z.string()]), z.object({ failed: cleanupJobSchema.nullable(), thread: ThreadSchema().nullable() })),
  insert: databaseWriteOperation("cleanupJob.insert", z.tuple([jobInput]), cleanupJobSchema),
  enqueueExpiredCompleted: databaseWriteOperation("cleanupJob.enqueueExpiredCompleted", z.tuple([z.string(), z.number().optional(), z.string().optional()]), z.number().int()),
  recordFailure: databaseWriteOperation("cleanupJob.recordFailure", z.tuple([z.string(), z.string()]), cleanupJobSchema.nullable()),
  delete: databaseWriteOperation("cleanupJob.delete", z.tuple([z.string()]), z.boolean()),
  resetAttempts: databaseWriteOperation("cleanupJob.resetAttempts", z.tuple([]), z.void()),
  requeueExhaustedJobs: databaseWriteOperation("cleanupJob.requeueExhaustedJobs", z.tuple([z.string().optional()]), z.number().int()),
  requeueBlockedRetentionBatch: databaseWriteOperation("cleanupJob.requeueBlockedRetentionBatch", z.tuple([z.number().optional()]), z.object({ threadIds: z.array(z.string()), hasMore: z.boolean() })),
  requeueBlockedRetention: databaseWriteOperation("cleanupJob.requeueBlockedRetention", z.tuple([z.string()]), z.boolean()),
  insertBatch: databaseWriteOperation("cleanupJob.insertBatch", z.tuple([z.array(jobInput.omit({ kind: true }))]), z.number().int()),
  deleteByThreadId: databaseWriteOperation("cleanupJob.deleteByThreadId", z.tuple([z.string()]), z.boolean()),
};
