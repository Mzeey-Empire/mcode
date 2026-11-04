import type { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import { z } from "zod";
import { openReadOnlyDatabase } from "../../persistence/sqlite/read-only-database.js";
import type { DiagQuery, Evidence } from "./model.js";

const idRowSchema = z.object({ id: z.string() });
const threadRowSchema = z.object({ id: z.string(), workspace_id: z.string(), title: z.string() });
const eventRowSchema = z.object({
  thread_id: z.string(),
  accepted_at: z.string(),
  accepted_sequence: z.number(),
  type: z.string().nullable(),
});
const checkpointRowSchema = z.object({
  thread_id: z.string(),
  phase: z.string(),
  terminal_outcome: z.string().nullable(),
  updated_at: z.string(),
});

/** Title and workspace of one thread. */
export interface ThreadSummary {
  id: string;
  workspaceId: string;
  title: string;
}

/** One accepted canonical event, reduced to what the timeline shows. */
export interface CanonicalEventSummary {
  threadId: string;
  t: number;
  sequence: number;
  type: string;
}

/** The latest ingest checkpoint of one thread. */
export interface CheckpointSummary {
  threadId: string;
  phase: string;
  terminal: string | null;
  updated: number;
}

/**
 * A read-only handle that turns database failures into a status the report can show. The
 * recordings stay readable when the database is missing, locked, or in an unexpected shape.
 */
export class CanonicalDatabase {
  private failure?: string;

  private constructor(
    private readonly db: Database | undefined,
    private readonly wanted: boolean,
    openFailure: string | undefined,
  ) {
    this.failure = openFailure;
  }

  /** Open the database named by the query, or a handle that reports why it is unavailable. */
  static open(q: DiagQuery): CanonicalDatabase {
    if (q.noDb) return new CanonicalDatabase(undefined, false, undefined);
    if (!q.dbPath || !NodeFS.existsSync(q.dbPath)) {
      return new CanonicalDatabase(undefined, true, "database file missing");
    }
    try {
      return new CanonicalDatabase(openReadOnlyDatabase(q.dbPath), true, undefined);
    } catch (error) {
      return new CanonicalDatabase(undefined, true, errorMessage(error));
    }
  }

  /** Run one read, returning the fallback and remembering the first failure when it throws. */
  read<T>(fallback: T, read: (db: Database) => T): T {
    if (!this.db) return fallback;
    try {
      return read(this.db);
    } catch (error) {
      this.failure ??= errorMessage(error);
      return fallback;
    }
  }

  get status(): Evidence["database"] {
    if (!this.wanted) return "not used";
    if (this.db && this.failure === undefined) return "available";
    return "missing";
  }

  get error(): string | undefined {
    return this.failure;
  }

  close(): void {
    this.db?.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Every thread of a workspace, resolved by a join on the threads table. */
export function findWorkspaceThreadIds(db: Database, workspaceId: string): string[] {
  const rows = db.query("SELECT id FROM threads WHERE workspace_id = ?").all(workspaceId);
  return rows.map((row) => idRowSchema.parse(row).id);
}

/** Threads whose ingest checkpoint changed inside the window. */
export function findThreadIdsWithCheckpointIn(db: Database, since: number, until: number): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT thread_id AS id
       FROM canonical_agent_ingest_checkpoints
       WHERE updated_at >= ? AND updated_at <= ?`,
    )
    .all(toIso(since), toIso(until));
  return rows.map((row) => idRowSchema.parse(row).id);
}

const THREAD_ID_LIST = "thread_id IN (SELECT value FROM json_each(?))";

/** Titles and workspaces for a set of threads, in one query. */
export function readThreadSummaries(db: Database, threadIds: readonly string[]): ThreadSummary[] {
  const rows = db
    .query("SELECT id, workspace_id, title FROM threads WHERE id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(threadIds));
  return rows.map((raw) => {
    const row = threadRowSchema.parse(raw);
    return { id: row.id, workspaceId: row.workspace_id, title: row.title };
  });
}

/** The newest checkpoint at or before `until` for each thread, in one query. */
export function readLatestCheckpoints(
  db: Database,
  threadIds: readonly string[],
  until: number,
): CheckpointSummary[] {
  const rows = db
    .query(
      `SELECT thread_id, phase, terminal_outcome, updated_at
       FROM (
         SELECT thread_id, phase, terminal_outcome, updated_at,
                ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY updated_at DESC) AS recency
         FROM canonical_agent_ingest_checkpoints
         WHERE ${THREAD_ID_LIST} AND updated_at <= ?
       )
       WHERE recency = 1`,
    )
    .all(JSON.stringify(threadIds), toIso(until));
  return rows.map((raw) => {
    const row = checkpointRowSchema.parse(raw);
    return {
      threadId: row.thread_id,
      phase: row.phase,
      terminal: row.terminal_outcome,
      updated: Date.parse(row.updated_at),
    };
  });
}

/** Accepted canonical events inside the window, in one query. */
export function readCanonicalEvents(
  db: Database,
  threadIds: readonly string[],
  since: number,
  until: number,
): CanonicalEventSummary[] {
  const rows = db
    .query(
      `SELECT thread_id, accepted_at, accepted_sequence,
              json_extract(envelope_json, '$.payload.type') AS type
       FROM canonical_agent_events
       WHERE ${THREAD_ID_LIST} AND accepted_at >= ? AND accepted_at <= ?
       ORDER BY accepted_at, accepted_sequence`,
    )
    .all(JSON.stringify(threadIds), toIso(since), toIso(until));
  return rows.map((raw) => {
    const row = eventRowSchema.parse(raw);
    return {
      threadId: row.thread_id,
      t: Date.parse(row.accepted_at),
      sequence: row.accepted_sequence,
      type: row.type ?? "unknown",
    };
  });
}
