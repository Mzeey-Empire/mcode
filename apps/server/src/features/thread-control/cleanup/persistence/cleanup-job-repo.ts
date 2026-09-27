/**
 * Cleanup job data access layer.
 * Stores worktree cleanup jobs that are processed by CleanupWorker with
 * exponential backoff retries. A job persists until the cleanup succeeds,
 * surviving app restarts.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { cleanupJobs, threads, workspaces } from "../../../../runtime/persistence/sqlite/schema.js";
import { runChanges } from "../../../../runtime/persistence/sqlite/drizzle-changes.js";

/** Max persisted retry attempts before a cleanup job requires user action. */
export const MAX_CLEANUP_ATTEMPTS = 5;

/** Maximum cleanup jobs one worker poll may execute. */
export const CLEANUP_BATCH_LIMIT = 20;

/** Max length for persisted error messages. */
const MAX_ERROR_LENGTH = 500;

/** Queued worktree cleanup job processed by CleanupWorker with exponential backoff. */
export interface CleanupJob {
  id: string;
  thread_id: string;
  workspace_path: string;
  worktree_path: string | null;
  branch: string | null;
  kind: "explicit" | "retention";
  attempts: number;
  next_retry_at: number;
  last_error: string | null;
  created_at: number;
}

/** Counts due cleanup jobs by their processing kind. */
export interface CleanupJobDueCounts {
  explicit: number;
  retention: number;
}

/** Bounded result from requeueing blocked retention candidates. */
export interface RequeuedRetentionBatch {
  threadIds: string[];
  hasMore: boolean;
}

type CleanupJobRow = typeof cleanupJobs.$inferSelect;

function rowToJob(row: CleanupJobRow): CleanupJob {
  return {
    id: row.id,
    thread_id: row.threadId,
    workspace_path: row.workspacePath,
    worktree_path: row.worktreePath,
    branch: row.branch,
    kind: row.kind as CleanupJob["kind"],
    attempts: row.attempts,
    next_retry_at: row.nextRetryAt,
    last_error: row.lastError,
    created_at: row.createdAt,
  };
}

function calculateDueLimits(
  counts: CleanupJobDueCounts,
  boundedLimit: number,
): CleanupJobDueCounts {
  let retention = Math.min(counts.retention, Math.max(1, Math.floor(boundedLimit / 2)));
  let explicit = Math.min(counts.explicit, boundedLimit - retention);
  const spare = boundedLimit - explicit - retention;
  if (spare > 0) {
    const extraRetention = Math.min(spare, counts.retention - retention);
    retention += extraRetention;
    explicit += Math.min(spare - extraRetention, counts.explicit - explicit);
  }
  return { explicit, retention };
}

function interleaveDueJobs(
  retentionJobs: CleanupJob[],
  explicitJobs: CleanupJob[],
  limit: number,
): CleanupJob[] {
  const selected: CleanupJob[] = [];
  for (let index = 0; selected.length < limit && hasJobAt(retentionJobs, explicitJobs, index); index += 1) {
    appendJobAt(selected, retentionJobs, index, limit);
    appendJobAt(selected, explicitJobs, index, limit);
  }
  return selected;
}

function hasJobAt(retentionJobs: CleanupJob[], explicitJobs: CleanupJob[], index: number): boolean {
  return index < retentionJobs.length || index < explicitJobs.length;
}

function appendJobAt(target: CleanupJob[], source: CleanupJob[], index: number, limit: number): void {
  if (target.length < limit && index < source.length) target.push(source[index]);
}

/** Repository for worktree cleanup job persistence. */
@injectable()
export class CleanupJobRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") private readonly db: Database) {
    this.orm = drizzle(db);
  }

  /**
   * Insert a new cleanup job. The job will be picked up by CleanupWorker
   * as soon as next_retry_at <= now and attempts < MAX_CLEANUP_ATTEMPTS.
   * A UNIQUE constraint on thread_id prevents duplicate jobs for the same thread.
   */
  insert(job: {
    thread_id: string;
    workspace_path: string;
    worktree_path: string | null;
    branch: string | null;
    kind?: "explicit" | "retention";
  }): CleanupJob {
    const id = NodeCrypto.randomUUID();
    const now = Date.now();
    const kind = job.kind ?? "explicit";

    const result = runChanges(
      this.orm
        .insert(cleanupJobs)
        .values({
          id,
          threadId: job.thread_id,
          workspacePath: job.workspace_path,
          worktreePath: job.worktree_path,
          branch: job.branch ?? null,
          kind,
          attempts: 0,
          nextRetryAt: 0,
          createdAt: now,
        })
        .onConflictDoNothing(),
    );

    if (result.changes === 0) {
      // A job for this thread already exists (UNIQUE constraint). Return the
      // persisted row so callers always get a valid, DB-backed object.
      return this.findByThreadId(job.thread_id) as CleanupJob;
    }

    return {
      id,
      thread_id: job.thread_id,
      workspace_path: job.workspace_path,
      worktree_path: job.worktree_path,
      branch: job.branch,
      kind,
      attempts: 0,
      next_retry_at: 0,
      last_error: null,
      created_at: now,
    };
  }

  /**
   * Return jobs that are due to run: next_retry_at <= now and attempts < max.
   * Ordered by created_at ascending so oldest jobs are processed first.
   */
  findDue(nowMs: number, limit = CLEANUP_BATCH_LIMIT, workspacePath?: string): CleanupJob[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const counts = this.getDueCounts(nowMs, workspacePath);
    if (counts.explicit === 0 || counts.retention === 0) {
      return this.findDueFromAvailableKind(nowMs, boundedLimit, counts, workspacePath);
    }

    const limits = calculateDueLimits(counts, boundedLimit);
    const explicitJobs = this.findDueByKind(nowMs, "explicit", limits.explicit, workspacePath);
    const retentionJobs = this.findDueByKind(nowMs, "retention", limits.retention, workspacePath);
    return interleaveDueJobs(retentionJobs, explicitJobs, boundedLimit);
  }

  private findDueFromAvailableKind(
    nowMs: number,
    limit: number,
    counts: CleanupJobDueCounts,
    workspacePath?: string,
  ): CleanupJob[] {
    const kind = counts.retention > 0 ? "retention" : "explicit";
    return this.findDueByKind(nowMs, kind, limit, workspacePath);
  }

  private findDueByKind(nowMs: number, kind: CleanupJob["kind"], limit: number, workspacePath?: string): CleanupJob[] {
    const rows = this.orm
      .select()
      .from(cleanupJobs)
      .where(and(
        lte(cleanupJobs.nextRetryAt, nowMs),
        lt(cleanupJobs.attempts, MAX_CLEANUP_ATTEMPTS),
        eq(cleanupJobs.kind, kind),
        workspacePath === undefined ? undefined : eq(cleanupJobs.workspacePath, workspacePath),
      ))
      .orderBy(asc(cleanupJobs.createdAt))
      .limit(limit)
      .all();
    return rows.map(rowToJob);
  }

  /** Return due cleanup job counts grouped by processing kind. */
  getDueCounts(nowMs: number, workspacePath?: string): CleanupJobDueCounts {
    const counts: CleanupJobDueCounts = { explicit: 0, retention: 0 };
    const rows = this.orm
      .select({ kind: cleanupJobs.kind, count: sql<number>`COUNT(*)` })
      .from(cleanupJobs)
      .where(and(
        lte(cleanupJobs.nextRetryAt, nowMs),
        lt(cleanupJobs.attempts, MAX_CLEANUP_ATTEMPTS),
        inArray(cleanupJobs.kind, ["explicit", "retention"]),
        workspacePath === undefined ? undefined : eq(cleanupJobs.workspacePath, workspacePath),
      ))
      .groupBy(cleanupJobs.kind)
      .all();
    for (const row of rows) counts[row.kind as CleanupJob["kind"]] = row.count;
    return counts;
  }

  /** Queue a bounded set of expired completed threads in one database transaction. */
  enqueueExpiredCompleted(nowIso: string, limit = CLEANUP_BATCH_LIMIT, workspacePath?: string): number {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const due = this.orm
      .select({
        id: threads.id,
        workspacePath: workspaces.path,
        worktreePath: threads.worktreePath,
        branch: threads.branch,
      })
      .from(threads)
      .innerJoin(workspaces, eq(workspaces.id, threads.workspaceId))
      .where(and(
        isNull(threads.deletedAt),
        isNull(workspaces.deletedAt),
        isNotNull(threads.userCompletedAt),
        isNotNull(threads.scheduledDeletionAt),
        lte(threads.scheduledDeletionAt, nowIso),
        isNull(threads.cleanupState),
        workspacePath === undefined ? undefined : eq(workspaces.path, workspacePath),
      ))
      .orderBy(asc(threads.scheduledDeletionAt), asc(threads.id))
      .limit(boundedLimit)
      .all();

    return this.db.transaction(() => {
      let queued = 0;
      for (const thread of due) {
        const claimed = runChanges(
          this.orm
            .update(threads)
            .set({ cleanupState: "queued", cleanupReason: null })
            .where(and(
              eq(threads.id, thread.id),
              isNull(threads.deletedAt),
              isNotNull(threads.userCompletedAt),
              isNotNull(threads.scheduledDeletionAt),
              lte(threads.scheduledDeletionAt, nowIso),
              isNull(threads.cleanupState),
            )),
        );
        if (claimed.changes === 0) continue;
        this.insert({
          thread_id: thread.id,
          workspace_path: thread.workspacePath,
          worktree_path: thread.worktreePath,
          branch: thread.branch,
          kind: "retention",
        });
        queued += 1;
      }
      return queued;
    })();
  }

  /**
   * Record a failed attempt. Increments attempts and schedules next retry
   * with exponential backoff (2^(attempts+1) seconds). Error message is
   * truncated to prevent unbounded growth.
   */
  recordFailure(id: string, error: string): CleanupJob | null {
    const truncated = error.slice(0, MAX_ERROR_LENGTH);
    this.orm
      .update(cleanupJobs)
      .set({
        attempts: sql`${cleanupJobs.attempts} + 1`,
        nextRetryAt: sql`${Date.now()} + (CAST(POW(2, ${cleanupJobs.attempts} + 1) AS INTEGER) * 1000)`,
        lastError: truncated,
      })
      .where(eq(cleanupJobs.id, id))
      .run();
    return this.findById(id);
  }

  /** Remove a completed cleanup job. */
  delete(id: string): boolean {
    const result = runChanges(
      this.orm.delete(cleanupJobs).where(eq(cleanupJobs.id, id)),
    );
    return result.changes > 0;
  }

  /**
   * Reset all attempt counters to 0 and clear next_retry_at.
   * Retained for explicit administrative recovery. Startup does not call this.
   */
  resetAttempts(): void {
    this.orm.update(cleanupJobs).set({ attempts: 0, nextRetryAt: 0 }).run();
  }

  /**
   * Requeue jobs that exhausted their retries. findDue filters them out
   * forever, so without this they strand their worktree directories and pin
   * deleting workspaces. Orphaned rows self-clean on the next poll because
   * the worker deletes explicit jobs whose thread is gone.
   */
  requeueExhaustedJobs(workspacePath?: string): number {
    const result = runChanges(
      this.orm
        .update(cleanupJobs)
        .set({ attempts: 0, nextRetryAt: 0 })
        .where(and(
          gte(cleanupJobs.attempts, MAX_CLEANUP_ATTEMPTS),
          workspacePath === undefined ? undefined : eq(cleanupJobs.workspacePath, workspacePath),
        )),
    );
    return result.changes;
  }

  /** Find a single job by its primary key. Returns null if not found. */
  findById(id: string): CleanupJob | null {
    const row = this.orm
      .select()
      .from(cleanupJobs)
      .where(eq(cleanupJobs.id, id))
      .get();
    return row ? rowToJob(row) : null;
  }

  /** Return the total number of pending cleanup jobs. */
  count(): number {
    const row = this.orm
      .select({ n: sql<number>`COUNT(*)` })
      .from(cleanupJobs)
      .get();
    return row?.n ?? 0;
  }

  /** Count completed retention candidates that are waiting for user retry. */
  countBlockedRetentionCandidates(): number {
    const row = this.orm
      .select({ count: sql<number>`COUNT(*)` })
      .from(threads)
      .where(and(
        isNull(threads.deletedAt),
        isNotNull(threads.userCompletedAt),
        eq(threads.cleanupState, "blocked"),
      ))
      .get();
    return row?.count ?? 0;
  }

  /**
   * Requeue one bounded page of blocked retention candidates.
   * Each candidate is updated and its retention job is rebuilt in the same
   * transaction so a worker cannot observe a queued thread without a job.
   */
  requeueBlockedRetentionBatch(limit = CLEANUP_BATCH_LIMIT): RequeuedRetentionBatch {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.orm
      .select({
        id: threads.id,
        workspacePath: workspaces.path,
        worktreePath: threads.worktreePath,
        branch: threads.branch,
      })
      .from(threads)
      .innerJoin(workspaces, eq(workspaces.id, threads.workspaceId))
      .where(and(
        isNull(threads.deletedAt),
        isNotNull(threads.userCompletedAt),
        eq(threads.cleanupState, "blocked"),
      ))
      .orderBy(asc(threads.id))
      .limit(boundedLimit)
      .all();

    if (rows.length === 0) return { threadIds: [], hasMore: false };

    const now = Date.now();
    const threadIds = this.db.transaction(() => {
      const changed: string[] = [];
      for (const row of rows) {
        const claimed = runChanges(
          this.orm
            .update(threads)
            .set({ cleanupState: "queued", cleanupReason: null })
            .where(and(
              eq(threads.id, row.id),
              isNull(threads.deletedAt),
              isNotNull(threads.userCompletedAt),
              eq(threads.cleanupState, "blocked"),
            )),
        );
        if (claimed.changes === 0) continue;
        this.orm
          .delete(cleanupJobs)
          .where(and(eq(cleanupJobs.threadId, row.id), eq(cleanupJobs.kind, "retention")))
          .run();
        this.orm
          .insert(cleanupJobs)
          .values({
            id: NodeCrypto.randomUUID(),
            threadId: row.id,
            workspacePath: row.workspacePath,
            worktreePath: row.worktreePath,
            branch: row.branch,
            kind: "retention",
            attempts: 0,
            nextRetryAt: 0,
            createdAt: now,
          })
          .onConflictDoNothing()
          .run();
        changed.push(row.id);
      }
      return changed;
    })();

    return {
      threadIds,
      hasMore: rows.length === boundedLimit && this.hasRequeueableBlockedRetentionCandidates(),
    };
  }

  private hasRequeueableBlockedRetentionCandidates(): boolean {
    const row = this.orm
      .select({ id: threads.id })
      .from(threads)
      .innerJoin(workspaces, eq(workspaces.id, threads.workspaceId))
      .where(and(
        isNull(threads.deletedAt),
        isNotNull(threads.userCompletedAt),
        eq(threads.cleanupState, "blocked"),
      ))
      .limit(1)
      .get();
    return row !== undefined;
  }

  /** Atomically rebuild one blocked thread's retention job and queue it. */
  requeueBlockedRetention(threadId: string): boolean {
    return this.db.transaction(() => {
      const row = this.orm
        .select({
          id: threads.id,
          workspacePath: workspaces.path,
          worktreePath: threads.worktreePath,
          branch: threads.branch,
        })
        .from(threads)
        .innerJoin(workspaces, eq(workspaces.id, threads.workspaceId))
        .where(and(
          eq(threads.id, threadId),
          isNull(threads.deletedAt),
          isNotNull(threads.userCompletedAt),
          eq(threads.cleanupState, "blocked"),
        ))
        .get();
      if (!row) return false;

      const changed = runChanges(
        this.orm
          .update(threads)
          .set({ cleanupState: "queued", cleanupReason: null })
          .where(and(eq(threads.id, threadId), eq(threads.cleanupState, "blocked"))),
      );
      if (changed.changes === 0) return false;

      this.orm
        .delete(cleanupJobs)
        .where(and(eq(cleanupJobs.threadId, threadId), eq(cleanupJobs.kind, "retention")))
        .run();
      this.orm
        .insert(cleanupJobs)
        .values({
          id: NodeCrypto.randomUUID(),
          threadId: row.id,
          workspacePath: row.workspacePath,
          worktreePath: row.worktreePath,
          branch: row.branch,
          kind: "retention",
          attempts: 0,
          nextRetryAt: 0,
          createdAt: Date.now(),
        })
        .onConflictDoNothing()
        .run();
      return true;
    })();
  }

  /**
   * Insert multiple cleanup jobs in a single transaction.
   * Skips any thread_id that already has a pending job (ON CONFLICT IGNORE).
   */
  insertBatch(jobs: Array<{ thread_id: string; workspace_path: string; worktree_path: string | null; branch: string | null }>): number {
    if (jobs.length === 0) return 0;

    let inserted = 0;
    const now = Date.now();

    const tx = this.db.transaction(() => {
      for (const job of jobs) {
        const result = runChanges(
          this.orm
            .insert(cleanupJobs)
            .values({
              id: NodeCrypto.randomUUID(),
              threadId: job.thread_id,
              workspacePath: job.workspace_path,
              worktreePath: job.worktree_path,
              branch: job.branch,
              kind: "explicit",
              attempts: 0,
              nextRetryAt: 0,
              createdAt: now,
            })
            .onConflictDoNothing(),
        );
        if (result.changes > 0) inserted++;
      }
    });
    tx();

    return inserted;
  }

  /** Count pending cleanup jobs for a given workspace path. */
  countByWorkspacePath(workspacePath: string): number {
    const row = this.orm
      .select({ count: sql<number>`COUNT(*)` })
      .from(cleanupJobs)
      .where(eq(cleanupJobs.workspacePath, workspacePath))
      .get();
    return row?.count ?? 0;
  }

  /** Find a cleanup job by thread ID. Returns null if no job exists. */
  findByThreadId(threadId: string): CleanupJob | null {
    const row = this.orm
      .select()
      .from(cleanupJobs)
      .where(eq(cleanupJobs.threadId, threadId))
      .get();
    return row ? rowToJob(row) : null;
  }

  /** Delete a cleanup job by its associated thread ID. Returns true if a row was removed. */
  deleteByThreadId(threadId: string): boolean {
    const job = this.findByThreadId(threadId);
    if (!job) return false;
    return this.delete(job.id);
  }

  /** Count jobs that still have retries remaining for a workspace path. */
  countRetriableByWorkspacePath(workspacePath: string): number {
    const row = this.orm
      .select({ count: sql<number>`COUNT(*)` })
      .from(cleanupJobs)
      .where(and(eq(cleanupJobs.workspacePath, workspacePath), lt(cleanupJobs.attempts, 5)))
      .get();
    return row?.count ?? 0;
  }

  /** Get the most recent error message from cleanup jobs for a workspace path. */
  getLastErrorByWorkspacePath(workspacePath: string): string | null {
    const row = this.orm
      .select({ lastError: cleanupJobs.lastError })
      .from(cleanupJobs)
      .where(and(
        eq(cleanupJobs.workspacePath, workspacePath),
        isNotNull(cleanupJobs.lastError),
      ))
      .orderBy(desc(cleanupJobs.nextRetryAt), desc(cleanupJobs.createdAt))
      .limit(1)
      .get();
    return row?.lastError ?? null;
  }
}
