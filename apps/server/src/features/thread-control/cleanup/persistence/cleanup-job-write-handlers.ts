import type { Database } from "bun:sqlite";
import { databaseWriteHandler } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { CleanupJobStore } from "./cleanup-job-store.js";
import { cleanupJobWriteOperations } from "./cleanup-job-write-operations.js";

/** Register synchronous complete operations on the application writer connection. */
export function buildCleanupJobStoreWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new CleanupJobStore(db);
  return new Map<string, (input: unknown) => unknown>([
    [cleanupJobWriteOperations.claimRetentionJob.name, databaseWriteHandler(cleanupJobWriteOperations.claimRetentionJob, (input) => store.claimRetentionJob(...input))],
    [cleanupJobWriteOperations.completeThreads.name, databaseWriteHandler(cleanupJobWriteOperations.completeThreads, (input) => store.completeThreads(...input))],
    [cleanupJobWriteOperations.recordFailureWithRetention.name, databaseWriteHandler(cleanupJobWriteOperations.recordFailureWithRetention, (input) => store.recordFailureWithRetention(...input))],
    [cleanupJobWriteOperations.insert.name, databaseWriteHandler(cleanupJobWriteOperations.insert, (input) => store.insert(...input))],
    [cleanupJobWriteOperations.enqueueExpiredCompleted.name, databaseWriteHandler(cleanupJobWriteOperations.enqueueExpiredCompleted, (input) => store.enqueueExpiredCompleted(...input))],
    [cleanupJobWriteOperations.recordFailure.name, databaseWriteHandler(cleanupJobWriteOperations.recordFailure, (input) => store.recordFailure(...input))],
    [cleanupJobWriteOperations.delete.name, databaseWriteHandler(cleanupJobWriteOperations.delete, (input) => store.delete(...input))],
    [cleanupJobWriteOperations.resetAttempts.name, databaseWriteHandler(cleanupJobWriteOperations.resetAttempts, (input) => store.resetAttempts(...input))],
    [cleanupJobWriteOperations.requeueExhaustedJobs.name, databaseWriteHandler(cleanupJobWriteOperations.requeueExhaustedJobs, (input) => store.requeueExhaustedJobs(...input))],
    [cleanupJobWriteOperations.requeueBlockedRetentionBatch.name, databaseWriteHandler(cleanupJobWriteOperations.requeueBlockedRetentionBatch, (input) => store.requeueBlockedRetentionBatch(...input))],
    [cleanupJobWriteOperations.requeueBlockedRetention.name, databaseWriteHandler(cleanupJobWriteOperations.requeueBlockedRetention, (input) => store.requeueBlockedRetention(...input))],
    [cleanupJobWriteOperations.insertBatch.name, databaseWriteHandler(cleanupJobWriteOperations.insertBatch, (input) => store.insertBatch(...input))],
    [cleanupJobWriteOperations.deleteByThreadId.name, databaseWriteHandler(cleanupJobWriteOperations.deleteByThreadId, (input) => store.deleteByThreadId(...input))],
  ]);
}
