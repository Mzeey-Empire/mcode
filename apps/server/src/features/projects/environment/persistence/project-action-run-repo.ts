import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { and, desc, eq, lt, ne, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
  WorkspaceEnvironmentActionRunSchema,
  type WorkspaceEnvironmentActionRun,
} from "@mcode/contracts";
import { projectActionRuns } from "../../../../runtime/persistence/sqlite/schema.js";
import { runChanges } from "../../../../runtime/persistence/sqlite/drizzle-changes.js";

type ProjectActionRunRow = typeof projectActionRuns.$inferSelect;

const PROJECT_ACTION_RUNS_PER_THREAD_MAX = 256;

/** Persists the single latest retained Project Action result for each Action slot. */
@injectable()
export class ProjectActionRunRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") db: Database) {
    this.orm = drizzle(db);
  }

  /** Returns the retained result for one Thread and Action slot. */
  get(threadId: string, actionId: string): WorkspaceEnvironmentActionRun | null {
    const row = this.orm
      .select()
      .from(projectActionRuns)
      .where(and(eq(projectActionRuns.threadId, threadId), eq(projectActionRuns.actionId, actionId)))
      .get();
    return row ? parseRow(row) : null;
  }

  /** Lists all retained Action results for one Thread. */
  list(threadId: string): WorkspaceEnvironmentActionRun[] {
    const runningRows = this.orm
      .select()
      .from(projectActionRuns)
      .where(and(eq(projectActionRuns.threadId, threadId), eq(projectActionRuns.status, "running")))
      .orderBy(desc(projectActionRuns.createdAt), desc(projectActionRuns.actionId))
      .all();
    const finalizedRows = this.orm
      .select()
      .from(projectActionRuns)
      .where(and(eq(projectActionRuns.threadId, threadId), ne(projectActionRuns.status, "running")))
      .orderBy(desc(projectActionRuns.createdAt), desc(projectActionRuns.actionId))
      .limit(PROJECT_ACTION_RUNS_PER_THREAD_MAX)
      .all();
    return [...runningRows, ...finalizedRows].flatMap((row) => {
      const run = parseRow(row);
      return run ? [run] : [];
    });
  }

  /** Replaces a completed slot result with the new run after slot exclusion has passed. */
  replace(run: WorkspaceEnvironmentActionRun): WorkspaceEnvironmentActionRun {
    const parsed = WorkspaceEnvironmentActionRunSchema().parse(run);
    this.orm.transaction((tx) => {
      tx
        .insert(projectActionRuns)
        .values({
          threadId: parsed.threadId,
          workspaceId: parsed.workspaceId,
          actionId: parsed.actionId,
          runId: parsed.runId,
          revision: parsed.revision,
          terminalSessionId: parsed.terminalSessionId,
          actionName: parsed.actionName,
          status: parsed.status,
          snapshotJson: JSON.stringify(parsed.snapshot),
          createdAt: parsed.createdAt,
          startedAt: parsed.startedAt,
          finishedAt: parsed.finishedAt,
          exitCode: parsed.exitCode,
          transcript: parsed.transcript,
          transcriptTruncated: parsed.transcriptTruncated,
        })
        .onConflictDoUpdate({
          target: [projectActionRuns.threadId, projectActionRuns.actionId],
          set: {
            workspaceId: parsed.workspaceId,
            runId: parsed.runId,
            revision: parsed.revision,
            terminalSessionId: parsed.terminalSessionId,
            actionName: parsed.actionName,
            status: parsed.status,
            snapshotJson: JSON.stringify(parsed.snapshot),
            createdAt: parsed.createdAt,
            startedAt: parsed.startedAt,
            finishedAt: parsed.finishedAt,
            exitCode: parsed.exitCode,
            transcript: parsed.transcript,
            transcriptTruncated: parsed.transcriptTruncated,
          },
        })
        .run();
      if (parsed.status !== "running") this.pruneFinalizedSlots(parsed.threadId, parsed.actionId);
    });
    return parsed;
  }

  /** Updates a retained run only while its run ID still owns the slot. */
  updateIfCurrent(run: WorkspaceEnvironmentActionRun): boolean {
    const parsed = WorkspaceEnvironmentActionRunSchema().parse(run);
    return this.orm.transaction((tx) => {
      const result = runChanges(tx
        .update(projectActionRuns)
        .set({
          revision: parsed.revision,
          terminalSessionId: parsed.terminalSessionId,
          actionName: parsed.actionName,
          status: parsed.status,
          snapshotJson: JSON.stringify(parsed.snapshot),
          createdAt: parsed.createdAt,
          startedAt: parsed.startedAt,
          finishedAt: parsed.finishedAt,
          exitCode: parsed.exitCode,
          transcript: parsed.transcript,
          transcriptTruncated: parsed.transcriptTruncated,
        })
        .where(
          and(
            eq(projectActionRuns.threadId, parsed.threadId),
            eq(projectActionRuns.actionId, parsed.actionId),
            eq(projectActionRuns.runId, parsed.runId),
            lt(projectActionRuns.revision, parsed.revision),
          ),
        )
        );
      if (result.changes === 1 && parsed.status !== "running") {
        this.pruneFinalizedSlots(parsed.threadId, parsed.actionId);
      }
      return result.changes === 1;
    });
  }

  /** Marks durable in-progress runs interrupted after startup has reaped stale terminals. */
  interruptRunning(finishedAt: string): WorkspaceEnvironmentActionRun[] {
    const rows = this.orm
      .select()
      .from(projectActionRuns)
      .where(eq(projectActionRuns.status, "running"))
      .limit(PROJECT_ACTION_RUNS_PER_THREAD_MAX)
      .all();
    const interrupted = rows.flatMap((row) => {
      const run = parseRow(row);
      if (!run) return [];
      return [{
        ...run,
        revision: run.revision + 1,
        status: "interrupted" as const,
        finishedAt,
        exitCode: null,
      }];
    });
    this.orm.transaction(() => {
      for (const run of interrupted) this.updateIfCurrent(run);
    });
    return interrupted;
  }

  /** Keeps a bounded finalized history while preserving the result currently being finalized. */
  private pruneFinalizedSlots(threadId: string, preservedActionId: string): void {
    this.orm
      .delete(projectActionRuns)
      .where(
        sql`rowid IN (
          SELECT rowid
          FROM project_action_runs
          WHERE thread_id = ${threadId} AND status <> 'running' AND action_id <> ${preservedActionId}
          ORDER BY created_at DESC, action_id DESC
          LIMIT -1 OFFSET ${PROJECT_ACTION_RUNS_PER_THREAD_MAX - 1}
        )`,
      )
      .run();
  }
}

function parseRow(row: ProjectActionRunRow): WorkspaceEnvironmentActionRun | null {
  try {
    const snapshot = JSON.parse(row.snapshotJson) as unknown;
    const parsed = WorkspaceEnvironmentActionRunSchema().safeParse({
      threadId: row.threadId,
      workspaceId: row.workspaceId,
      actionId: row.actionId,
      runId: row.runId,
      revision: row.revision,
      terminalSessionId: row.terminalSessionId,
      actionName: row.actionName,
      status: row.status,
      snapshot,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      exitCode: row.exitCode,
      transcript: row.transcript,
      transcriptTruncated: row.transcriptTruncated,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
