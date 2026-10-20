/**
 * Per-provider native session memory for a thread.
 *
 * A thread can run on several providers over its life. Each provider keeps its own native session,
 * and `last_seen_sequence` records how much of the thread that session has seen so a later switch
 * back can send only what it missed.
 */

import type { Database } from "bun:sqlite";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { threadProviderSessions } from "../../../runtime/persistence/sqlite/schema.js";
import { runChanges } from "../../../runtime/persistence/sqlite/drizzle-changes.js";

/** One provider's native session for a thread and the newest message sequence it has seen. */
export interface ThreadProviderSession {
  threadId: string;
  providerId: string;
  sessionId: string;
  lastSeenSequence: number;
  updatedAt: string;
}

/** Input for recording a provider's session on a thread. */
export interface UpsertThreadProviderSessionInput {
  threadId: string;
  providerId: string;
  sessionId: string;
  lastSeenSequence: number;
}

function rowToSession(row: typeof threadProviderSessions.$inferSelect): ThreadProviderSession {
  return {
    threadId: row.threadId,
    providerId: row.providerId,
    sessionId: row.sessionId,
    lastSeenSequence: row.lastSeenSequence,
    updatedAt: row.updatedAt,
  };
}

/** Synchronous access to `thread_provider_sessions` on one SQLite connection. */
export class ThreadProviderSessionStore {
  private readonly orm: BunSQLiteDatabase;

  constructor(db: Database) {
    this.orm = drizzle(db);
  }

  /** Return the provider's session on the thread, or null when it never ran there. */
  find(threadId: string, providerId: string): ThreadProviderSession | null {
    const row = this.orm.select().from(threadProviderSessions)
      .where(and(eq(threadProviderSessions.threadId, threadId), eq(threadProviderSessions.providerId, providerId)))
      .get();
    return row ? rowToSession(row) : null;
  }

  /** Return every provider session on the thread, ordered by provider id. */
  listForThread(threadId: string): ThreadProviderSession[] {
    return this.orm.select().from(threadProviderSessions)
      .where(eq(threadProviderSessions.threadId, threadId))
      .orderBy(asc(threadProviderSessions.providerId))
      .all()
      .map(rowToSession);
  }

  /** Insert the provider's session or replace the one already recorded for it. */
  upsert(input: UpsertThreadProviderSessionInput): void {
    const values = {
      sessionId: input.sessionId,
      lastSeenSequence: input.lastSeenSequence,
      updatedAt: new Date().toISOString(),
    };
    runChanges(this.orm.insert(threadProviderSessions)
      .values({ threadId: input.threadId, providerId: input.providerId, ...values })
      .onConflictDoUpdate({
        target: [threadProviderSessions.threadId, threadProviderSessions.providerId],
        set: values,
      }));
  }

  /**
   * Record that the provider's session has seen messages through the sequence. No-op without a row.
   * The mark only moves forward, so a replayed or late finalization cannot make the next switch
   * resend what the session already saw.
   */
  markSeen(threadId: string, providerId: string, lastSeenSequence: number): void {
    runChanges(this.orm.update(threadProviderSessions)
      .set({
        lastSeenSequence: sql`max(${threadProviderSessions.lastSeenSequence}, ${lastSeenSequence})`,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(threadProviderSessions.threadId, threadId), eq(threadProviderSessions.providerId, providerId))));
  }

  /** Forget the provider's session on the thread. Other providers' sessions stay. */
  remove(threadId: string, providerId: string): void {
    runChanges(this.orm.delete(threadProviderSessions)
      .where(and(eq(threadProviderSessions.threadId, threadId), eq(threadProviderSessions.providerId, providerId))));
  }
}
