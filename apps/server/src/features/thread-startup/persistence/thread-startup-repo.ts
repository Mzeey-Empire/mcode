import type { Database } from "bun:sqlite";
import { inject, injectable } from "tsyringe";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { logger } from "@mcode/shared";
import {
  ThreadStartupSchema,
  type ThreadStartup,
} from "@mcode/contracts";
import { threadStartups } from "../../../runtime/persistence/sqlite/schema.js";

type ThreadStartupRow = typeof threadStartups.$inferSelect;

/** SQLite repository for server-owned thread startup lifecycle snapshots. */
@injectable()
export class ThreadStartupRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") db: Database) {
    this.orm = drizzle(db);
  }

  /** Insert one new startup snapshot. */
  insert(startup: ThreadStartup, requestFingerprint?: string): void {
    this.orm.insert(threadStartups).values({
      startupId: startup.startupId,
      workspaceId: startup.workspaceId,
      kind: startup.kind,
      state: startup.state,
      phase: startup.phase,
      stepsJson: JSON.stringify(startup.steps),
      transcriptJson: JSON.stringify(startup.transcript),
      cancellation: startup.cancellation,
      revision: startup.revision,
      requestFingerprint: requestFingerprint ?? null,
      threadId: startup.threadId ?? null,
      errorJson: startup.error ? JSON.stringify(startup.error) : null,
      blockJson: startup.block ? JSON.stringify(startup.block) : null,
      createdAt: startup.createdAt,
      updatedAt: startup.updatedAt,
    }).run();
  }

  /** Return the private request identity without exposing it in lifecycle snapshots. */
  requestFingerprint(startupId: string): string | null {
    const row = this.orm
      .select({ requestFingerprint: threadStartups.requestFingerprint })
      .from(threadStartups)
      .where(eq(threadStartups.startupId, startupId))
      .get();
    return row?.requestFingerprint ?? null;
  }

  /** Commit direct thread creation and its startup binding together. */
  transaction<T>(operation: () => T): T {
    return this.orm.transaction(operation);
  }

  /** Return one startup snapshot by its client-generated identity. */
  findById(startupId: string): ThreadStartup | null {
    const row = this.orm
      .select()
      .from(threadStartups)
      .where(eq(threadStartups.startupId, startupId))
      .get();
    return row ? rowToStartup(row) : null;
  }

  /** Return a bounded reverse-chronological list for one workspace. */
  listByWorkspace(workspaceId: string, limit = 100): ThreadStartup[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.orm
      .select()
      .from(threadStartups)
      .where(eq(threadStartups.workspaceId, workspaceId))
      .orderBy(desc(threadStartups.updatedAt), desc(threadStartups.startupId))
      .limit(boundedLimit)
      .all();
    return rows.map(rowToStartup);
  }

  /** Return startups with in-flight work that cannot survive a server restart. */
  listInterruptible(): ThreadStartup[] {
    const rows = this.orm
      .select()
      .from(threadStartups)
      .where(inArray(threadStartups.state, ["pending", "running"]))
      .all();
    return mapStartupRows(rows);
  }

  /** Return startups left interrupted by a server restart. */
  listInterrupted(): ThreadStartup[] {
    const rows = this.orm
      .select()
      .from(threadStartups)
      .where(eq(threadStartups.state, "interrupted"))
      .all();
    return mapStartupRows(rows);
  }

  /** Return an active startup or the newest terminal startup bound to one Thread. */
  findByThreadId(threadId: string): ThreadStartup | null {
    const row = this.orm
      .select()
      .from(threadStartups)
      .where(eq(threadStartups.threadId, threadId))
      .orderBy(
        asc(sql`CASE WHEN ${threadStartups.state} IN ('pending', 'running', 'blocked') THEN 0 ELSE 1 END`),
        desc(threadStartups.updatedAt),
        desc(threadStartups.startupId),
      )
      .limit(1)
      .get();
    return row ? rowToStartup(row) : null;
  }

  /** Replace one persisted startup snapshot after its next revision is calculated. */
  update(startup: ThreadStartup): void {
    this.orm
      .update(threadStartups)
      .set({
        state: startup.state,
        phase: startup.phase,
        stepsJson: JSON.stringify(startup.steps),
        transcriptJson: JSON.stringify(startup.transcript),
        cancellation: startup.cancellation,
        revision: startup.revision,
        threadId: startup.threadId ?? null,
        errorJson: startup.error ? JSON.stringify(startup.error) : null,
        blockJson: startup.block ? JSON.stringify(startup.block) : null,
        updatedAt: startup.updatedAt,
      })
      .where(eq(threadStartups.startupId, startup.startupId))
      .run();
  }
}

// Boot-path scans must not let one schema-drifted row kill the server, so
// invalid rows are logged and skipped instead of thrown.
function mapStartupRows(rows: ThreadStartupRow[]): ThreadStartup[] {
  const startups: ThreadStartup[] = [];
  for (const row of rows) {
    try {
      startups.push(rowToStartup(row));
    } catch (error) {
      logger.warn("Skipping invalid thread startup row", {
        startupId: row.startupId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return startups;
}

function rowToStartup(row: ThreadStartupRow): ThreadStartup {
  return ThreadStartupSchema().parse({
    startupId: row.startupId,
    workspaceId: row.workspaceId,
    kind: row.kind,
    state: row.state,
    phase: row.phase,
    steps: JSON.parse(row.stepsJson),
    transcript: JSON.parse(row.transcriptJson),
    cancellation: row.cancellation,
    revision: row.revision,
    ...(row.threadId ? { threadId: row.threadId } : {}),
    ...(row.errorJson ? { error: JSON.parse(row.errorJson) } : {}),
    ...(row.blockJson ? { block: JSON.parse(row.blockJson) } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
