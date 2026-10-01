import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { CleanupJobStore, CLEANUP_BATCH_LIMIT } from "./cleanup-job-store.js";
import { cleanupJobWriteOperations } from "./cleanup-job-write-operations.js";
export type { CleanupJob, CleanupJobDueCounts, RequeuedRetentionBatch } from "./cleanup-job-store.js";
export { MAX_CLEANUP_ATTEMPTS, CLEANUP_BATCH_LIMIT } from "./cleanup-job-store.js";

/** Read-only queries and committed mutations for CleanupJobRepo. */
@injectable()
export class CleanupJobRepo {
  private readonly reader: CleanupJobStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new CleanupJobStore(db);
  }

  /** Claim cleanup and cancel an ineligible job as one writer operation. */
  claimRetentionJob(...input: Parameters<CleanupJobStore["claimRetentionJob"]>): Promise<ReturnType<CleanupJobStore["claimRetentionJob"]>> {
    return this.writer.execute(cleanupJobWriteOperations.claimRetentionJob, input);
  }

  /** Commit removal of threads and their cleanup jobs together. */
  completeThreads(...input: Parameters<CleanupJobStore["completeThreads"]>): Promise<void> {
    return this.writer.execute(cleanupJobWriteOperations.completeThreads, input);
  }

  /** Commit failed cleanup accounting and retention state before publication. */
  recordFailureWithRetention(...input: Parameters<CleanupJobStore["recordFailureWithRetention"]>): Promise<ReturnType<CleanupJobStore["recordFailureWithRetention"]>> {
    return this.writer.execute(cleanupJobWriteOperations.recordFailureWithRetention, input);
  }

  insert(job: Parameters<CleanupJobStore["insert"]>[0]): Promise<ReturnType<CleanupJobStore["insert"]>> {
    return this.writer.execute(cleanupJobWriteOperations.insert, [job]);
  }

  findDue(nowMs: Parameters<CleanupJobStore["findDue"]>[0], limit: Parameters<CleanupJobStore["findDue"]>[1] = CLEANUP_BATCH_LIMIT, workspacePath?: Parameters<CleanupJobStore["findDue"]>[2], excludedJobIds?: Parameters<CleanupJobStore["findDue"]>[3]): ReturnType<CleanupJobStore["findDue"]> {
    return this.reader.findDue(nowMs, limit, workspacePath, excludedJobIds);
  }

  getDueCounts(nowMs: Parameters<CleanupJobStore["getDueCounts"]>[0], workspacePath?: Parameters<CleanupJobStore["getDueCounts"]>[1], excludedJobIds?: Parameters<CleanupJobStore["getDueCounts"]>[2]): ReturnType<CleanupJobStore["getDueCounts"]> {
    return this.reader.getDueCounts(nowMs, workspacePath, excludedJobIds);
  }

  enqueueExpiredCompleted(nowIso: Parameters<CleanupJobStore["enqueueExpiredCompleted"]>[0], limit: Parameters<CleanupJobStore["enqueueExpiredCompleted"]>[1] = CLEANUP_BATCH_LIMIT, workspacePath?: Parameters<CleanupJobStore["enqueueExpiredCompleted"]>[2]): Promise<ReturnType<CleanupJobStore["enqueueExpiredCompleted"]>> {
    return this.writer.execute(cleanupJobWriteOperations.enqueueExpiredCompleted, [nowIso, limit, workspacePath]);
  }

  recordFailure(id: Parameters<CleanupJobStore["recordFailure"]>[0], error: Parameters<CleanupJobStore["recordFailure"]>[1]): Promise<ReturnType<CleanupJobStore["recordFailure"]>> {
    return this.writer.execute(cleanupJobWriteOperations.recordFailure, [id, error]);
  }

  delete(id: Parameters<CleanupJobStore["delete"]>[0]): Promise<ReturnType<CleanupJobStore["delete"]>> {
    return this.writer.execute(cleanupJobWriteOperations.delete, [id]);
  }

  resetAttempts(): Promise<ReturnType<CleanupJobStore["resetAttempts"]>> {
    return this.writer.execute(cleanupJobWriteOperations.resetAttempts, []);
  }

  requeueExhaustedJobs(workspacePath?: Parameters<CleanupJobStore["requeueExhaustedJobs"]>[0]): Promise<ReturnType<CleanupJobStore["requeueExhaustedJobs"]>> {
    return this.writer.execute(cleanupJobWriteOperations.requeueExhaustedJobs, [workspacePath]);
  }

  findById(id: Parameters<CleanupJobStore["findById"]>[0]): ReturnType<CleanupJobStore["findById"]> {
    return this.reader.findById(id);
  }

  count(): ReturnType<CleanupJobStore["count"]> {
    return this.reader.count();
  }

  countBlockedRetentionCandidates(): ReturnType<CleanupJobStore["countBlockedRetentionCandidates"]> {
    return this.reader.countBlockedRetentionCandidates();
  }

  requeueBlockedRetentionBatch(limit: Parameters<CleanupJobStore["requeueBlockedRetentionBatch"]>[0] = CLEANUP_BATCH_LIMIT): Promise<ReturnType<CleanupJobStore["requeueBlockedRetentionBatch"]>> {
    return this.writer.execute(cleanupJobWriteOperations.requeueBlockedRetentionBatch, [limit]);
  }

  requeueBlockedRetention(threadId: Parameters<CleanupJobStore["requeueBlockedRetention"]>[0]): Promise<ReturnType<CleanupJobStore["requeueBlockedRetention"]>> {
    return this.writer.execute(cleanupJobWriteOperations.requeueBlockedRetention, [threadId]);
  }

  insertBatch(jobs: Parameters<CleanupJobStore["insertBatch"]>[0]): Promise<ReturnType<CleanupJobStore["insertBatch"]>> {
    return this.writer.execute(cleanupJobWriteOperations.insertBatch, [jobs]);
  }

  countByWorkspacePath(workspacePath: Parameters<CleanupJobStore["countByWorkspacePath"]>[0]): ReturnType<CleanupJobStore["countByWorkspacePath"]> {
    return this.reader.countByWorkspacePath(workspacePath);
  }

  findByThreadId(threadId: Parameters<CleanupJobStore["findByThreadId"]>[0]): ReturnType<CleanupJobStore["findByThreadId"]> {
    return this.reader.findByThreadId(threadId);
  }

  deleteByThreadId(threadId: Parameters<CleanupJobStore["deleteByThreadId"]>[0]): Promise<ReturnType<CleanupJobStore["deleteByThreadId"]>> {
    return this.writer.execute(cleanupJobWriteOperations.deleteByThreadId, [threadId]);
  }

  countRetriableByWorkspacePath(workspacePath: Parameters<CleanupJobStore["countRetriableByWorkspacePath"]>[0]): ReturnType<CleanupJobStore["countRetriableByWorkspacePath"]> {
    return this.reader.countRetriableByWorkspacePath(workspacePath);
  }

  getLastErrorByWorkspacePath(workspacePath: Parameters<CleanupJobStore["getLastErrorByWorkspacePath"]>[0]): ReturnType<CleanupJobStore["getLastErrorByWorkspacePath"]> {
    return this.reader.getLastErrorByWorkspacePath(workspacePath);
  }
}
