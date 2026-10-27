/**
 * Turn snapshot data access layer.
 * Provides creation and retrieval operations for git turn snapshots in SQLite.
 */

import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { asc, eq, lt, sql, type SQL } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { TurnFileEffectSummarySchema, type TurnFileEffectSummary } from "@mcode/contracts/models/file-effect";
import { type TurnSnapshot } from "@mcode/contracts/models/turn-snapshot";
import { runChanges } from "../../../../runtime/persistence/sqlite/drizzle-changes.js";
import { messages, turnSnapshots } from "../../../../runtime/persistence/sqlite/schema.js";

/** Row shape returned by drizzle for the turn_snapshots table. */
type TurnSnapshotRow = typeof turnSnapshots.$inferSelect;

/** Input for creating a new turn snapshot. */
export interface CreateTurnSnapshotInput {
  messageId: string;
  threadId: string;
  refBefore: string;
  refAfter: string;
  filesChanged: string[];
  fileEffects?: TurnFileEffectSummary;
  worktreePath: string | null;
}

/** Safely parse a JSON string array, returning [] on corrupt data. */
function safeParseArray(json: string): string[] {
  try {
    return JSON.parse(json) as string[];
  } catch {
    return [];
  }
}

function safeParseFileEffects(json: string): TurnFileEffectSummary {
  try {
    const parsed = TurnFileEffectSummarySchema().safeParse(JSON.parse(json));
    if (parsed.success) return parsed.data;
  } catch {
    // Corrupt legacy metadata is treated as an empty authored summary.
  }
  return { revision: 0, fileCount: 0, additions: 0, deletions: 0, effects: [] };
}

function rowToTurnSnapshot({ row, messageSequence }: { row: TurnSnapshotRow; messageSequence: number }): TurnSnapshot {
  return {
    id: row.id,
    message_id: row.messageId,
    thread_id: row.threadId,
    ref_before: row.refBefore,
    ref_after: row.refAfter,
    files_changed: safeParseArray(row.filesChanged),
    file_effects: safeParseFileEffects(row.fileEffects),
    worktree_path: row.worktreePath,
    created_at: row.createdAt,
    attempt_count: 1,
    reverted_paths: [],
    message_sequence: messageSequence,
  };
}

/** Repository for turn snapshot creation and retrieval against SQLite. */
export class TurnSnapshotStore {
  private readonly orm: BunSQLiteDatabase;

  constructor(db: Database) {
    this.orm = drizzle(db);
  }

  /** Create a new turn snapshot and return the fully-populated record. */
  create(input: CreateTurnSnapshotInput): TurnSnapshot {
    const id = NodeCrypto.randomUUID();
    const now = new Date().toISOString();
    const filesChangedJson = JSON.stringify(input.filesChanged);
    const fileEffects = TurnFileEffectSummarySchema().parse(input.fileEffects ?? {
      revision: 0,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      effects: [],
    });

    this.orm
      .insert(turnSnapshots)
      .values({
        id,
        messageId: input.messageId,
        threadId: input.threadId,
        refBefore: input.refBefore,
        refAfter: input.refAfter,
        filesChanged: filesChangedJson,
        fileEffects: JSON.stringify(fileEffects),
        worktreePath: input.worktreePath,
        createdAt: now,
      })
      .run();

    return {
      id,
      message_id: input.messageId,
      thread_id: input.threadId,
      ref_before: input.refBefore,
      ref_after: input.refAfter,
      files_changed: input.filesChanged,
      file_effects: fileEffects,
      worktree_path: input.worktreePath,
      created_at: now,
      attempt_count: 1,
      reverted_paths: [],
      message_sequence: this.selectWithSequence(eq(turnSnapshots.id, id)).get()?.messageSequence ?? 0,
    };
  }

  /** A missing message reads as sequence 0 so it never counts as settled after a seen baseline. */
  private selectWithSequence(where: SQL) {
    return this.orm
      .select({ row: turnSnapshots, messageSequence: sql<number>`coalesce(${messages.sequence}, 0)` })
      .from(turnSnapshots)
      .leftJoin(messages, eq(messages.id, turnSnapshots.messageId))
      .where(where);
  }

  /** Find a turn snapshot by its primary key. Returns null if not found. */
  getById(id: string): TurnSnapshot | null {
    const row = this.selectWithSequence(eq(turnSnapshots.id, id)).get();
    return row ? rowToTurnSnapshot(row) : null;
  }

  /** Find a turn snapshot by its associated message ID. Returns null if not found. */
  getByMessage(messageId: string): TurnSnapshot | null {
    const row = this.selectWithSequence(eq(turnSnapshots.messageId, messageId)).get();
    return row ? rowToTurnSnapshot(row) : null;
  }

  /** List all turn snapshots for a thread, ordered by created_at ascending. */
  listByThread(threadId: string): TurnSnapshot[] {
    const rows = this.selectWithSequence(eq(turnSnapshots.threadId, threadId))
      .orderBy(asc(turnSnapshots.createdAt), asc(sql`${turnSnapshots}.rowid`))
      .all();
    return rows.map(rowToTurnSnapshot);
  }

  /** Delete turn snapshots older than the specified number of days. Returns the count of deleted rows. */
  deleteExpired(maxAgeDays: number): number {
    const result = runChanges(
      this.orm
        .delete(turnSnapshots)
        .where(
          lt(
            turnSnapshots.createdAt,
            sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${maxAgeDays}`} || ' days')`,
          ),
        ),
    );
    return result.changes;
  }
}
