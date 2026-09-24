import type { Database } from "bun:sqlite";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
  canonicalAgentTurns,
  messages,
  turnDiffSnapshots,
  turnSnapshots,
} from "../../../../runtime/persistence/sqlite/schema.js";

/** Provider-neutral settled evidence owned by one assistant message. */
export interface StoredTurnDiff {
  id: string;
  message_id: string;
  thread_id: string;
  source: "native" | "tracked" | "git";
  patch: string | null;
  revision: number;
}

interface TurnDiffRow {
  id: string;
  messageId: string;
  threadId: string;
  source: string;
  patch: string | null;
  revision: number | null;
}

function rowToStoredTurnDiff(row: TurnDiffRow): StoredTurnDiff {
  return {
    id: row.id,
    message_id: row.messageId,
    thread_id: row.threadId,
    source: row.source as StoredTurnDiff["source"],
    patch: row.patch,
    // StoredTurnDiff.revision was never nullable in the legacy row contract;
    // the column is nullable in schema only for legacy rows that predated it.
    revision: row.revision as number,
  };
}

const TURN_DIFF_SELECTION = {
  id: turnDiffSnapshots.id,
  messageId: turnDiffSnapshots.messageId,
  threadId: turnDiffSnapshots.threadId,
  source: turnDiffSnapshots.source,
  patch: turnDiffSnapshots.patch,
  revision: turnDiffSnapshots.revision,
};

/** Persists final evidence without changing historical Git snapshots. */
export class TurnDiffRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(db: Database) {
    this.orm = drizzle(db);
  }

  /** Preserve the first settled comparison when a terminal projection replays. */
  create(record: StoredTurnDiff): void {
    this.orm
      .insert(turnDiffSnapshots)
      .values({
        id: record.id,
        messageId: record.message_id,
        threadId: record.thread_id,
        state: "snapshot",
        source: record.source,
        fidelity: record.source === "git" ? "same-file-changes-possible" : "agent",
        patch: record.patch,
        revision: record.revision,
      })
      .onConflictDoNothing({ target: turnDiffSnapshots.messageId })
      .run();
  }

  /** Read the newest durable comparison in conversation order. */
  latest(threadId: string): StoredTurnDiff | undefined {
    const row = this.orm
      .select(TURN_DIFF_SELECTION)
      .from(turnDiffSnapshots)
      .innerJoin(messages, eq(messages.id, turnDiffSnapshots.messageId))
      .where(eq(turnDiffSnapshots.threadId, threadId))
      .orderBy(desc(messages.sequence))
      .limit(1)
      .get();
    return row ? rowToStoredTurnDiff(row) : undefined;
  }

  /** Read the durable comparison owned by one assistant message. */
  findByMessage(threadId: string, messageId: string): StoredTurnDiff | undefined {
    const row = this.orm
      .select(TURN_DIFF_SELECTION)
      .from(turnDiffSnapshots)
      .where(
        and(
          eq(turnDiffSnapshots.threadId, threadId),
          eq(turnDiffSnapshots.messageId, messageId),
        ),
      )
      .get();
    return row ? rowToStoredTurnDiff(row) : undefined;
  }

  /** Read one comparison only within its owning thread. */
  find(threadId: string, id: string): StoredTurnDiff | undefined {
    const row = this.orm
      .select(TURN_DIFF_SELECTION)
      .from(turnDiffSnapshots)
      .where(
        and(
          eq(turnDiffSnapshots.threadId, threadId),
          eq(turnDiffSnapshots.id, id),
        ),
      )
      .get();
    return row ? rowToStoredTurnDiff(row) : undefined;
  }

  /** Preserve pre-outcome history while excluding known unfinished or failed turns. */
  latestLegacySnapshotId(threadId: string): string | undefined {
    return this.orm
      .select({ id: turnSnapshots.id })
      .from(turnSnapshots)
      .innerJoin(messages, eq(messages.id, turnSnapshots.messageId))
      .leftJoin(
        canonicalAgentTurns,
        and(
          eq(canonicalAgentTurns.id, messages.sourceTurnId),
          eq(canonicalAgentTurns.threadId, messages.threadId),
        ),
      )
      .where(
        and(
          eq(turnSnapshots.threadId, threadId),
          eq(messages.role, "assistant"),
          or(
            eq(messages.outcome, "completed"),
            and(
              isNull(messages.outcome),
              or(
                eq(canonicalAgentTurns.status, "completed"),
                and(
                  isNull(canonicalAgentTurns.id),
                  isNull(messages.outcomeExecutionId),
                ),
              ),
            ),
          ),
        ),
      )
      .orderBy(desc(messages.sequence))
      .limit(1)
      .get()?.id;
  }
}
