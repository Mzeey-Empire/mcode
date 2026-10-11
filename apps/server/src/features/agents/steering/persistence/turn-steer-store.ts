/**
 * SQLite access for durable steers. Rows are parsed into the state union here, so the rest of
 * the server never reads loose nullable columns. Every transition is a conditional write on the
 * state it leaves, so two windows racing on one steer settle it once.
 */
import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { runChanges } from "../../../../runtime/persistence/sqlite/drizzle-changes.js";
import { turnSteers } from "../../../../runtime/persistence/sqlite/schema.js";
import {
  TurnSteerRecordSchema,
  type PendingTurnSteerInput,
  type TurnSteerRecord,
  type TurnSteerSettlement,
} from "../turn-steer.js";

type TurnSteerRow = typeof turnSteers.$inferSelect;

const nowSql = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const HELD_STATES = ["delivery_unknown", "resend_queued"] as const;
const SETTLED_STATES = ["delivered", "rejected", "closed"] as const;

/** Parse one row into the state union; a row that does not fit throws instead of being guessed at. */
export function parseTurnSteerRow(row: TurnSteerRow): TurnSteerRecord {
  return TurnSteerRecordSchema.parse({
    messageId: row.messageId,
    threadId: row.threadId,
    turnExecutionId: row.turnExecutionId,
    inputsHash: row.inputsHash,
    payload: JSON.parse(row.payload),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    state: row.state,
    ...(row.state === "rejected" && row.rejection !== null ? { rejection: JSON.parse(row.rejection) } : {}),
    ...(row.state === "resend_queued" || row.state === "closed" ? { replacementMessageId: row.replacementMessageId } : {}),
  });
}

/** Synchronous storage for turn_steers. Writes run on the database writer. */
export class TurnSteerStore {
  private readonly db: BunSQLiteDatabase;

  constructor(database: Database) {
    this.db = drizzle(database);
  }

  /** Read one steer by its client message id. */
  find(messageId: string): TurnSteerRecord | null {
    const row = this.db.select().from(turnSteers).where(eq(turnSteers.messageId, messageId)).get();
    return row ? parseTurnSteerRow(row) : null;
  }

  /** Whether a Send again minted this id for a resend, which only turn admission may send. */
  isReplacementId(messageId: string): boolean {
    return this.db.select({ messageId: turnSteers.messageId }).from(turnSteers)
      .where(eq(turnSteers.replacementMessageId, messageId)).get() !== undefined;
  }

  /** Held steers, oldest first. */
  listHeld(limit: number): TurnSteerRecord[] {
    return this.db.select().from(turnSteers).where(inArray(turnSteers.state, [...HELD_STATES]))
      .orderBy(asc(turnSteers.createdAt), asc(turnSteers.messageId)).limit(limit).all()
      .map(parseTurnSteerRow);
  }

  /** Insert a pending steer. A duplicate messageId fails instead of overwriting. */
  insertPending(input: PendingTurnSteerInput): void {
    this.db.insert(turnSteers).values({
      messageId: input.messageId,
      threadId: input.threadId,
      turnExecutionId: input.turnExecutionId,
      inputsHash: input.inputsHash,
      payload: JSON.stringify(input.payload),
      state: "pending",
      createdAt: nowSql,
      updatedAt: nowSql,
    }).run();
  }

  /** Settle a pending steer as rejected or delivery_unknown. Returns false when it was no longer pending. */
  settle(messageId: string, settlement: TurnSteerSettlement): boolean {
    return this.transition(messageId, ["pending"], {
      state: settlement.state,
      rejection: settlement.state === "rejected" ? JSON.stringify(settlement.rejection) : null,
    });
  }

  /**
   * Mark a steer delivered. Runs inside the transaction that appends the steered user message, so
   * the transcript and the row agree. A save that lands after a replay or restart marked the steer
   * delivery_unknown still settles it, because the transcript now proves the provider took it.
   */
  markDelivered(messageId: string): boolean {
    return this.transition(messageId, ["pending", "delivery_unknown"], { state: "delivered" });
  }

  /** Store a Send again resend under a fresh id. Returns false when the steer was not delivery_unknown. */
  requeue(messageId: string, replacementMessageId: string): boolean {
    return this.transition(messageId, ["delivery_unknown"], { state: "resend_queued", replacementMessageId });
  }

  /** Remove a held steer. Returns false when another window settled it first. */
  remove(messageId: string): boolean {
    return this.transition(messageId, [...HELD_STATES], { state: "closed" });
  }

  /** Consume a queued resend once, inside the admission transaction. Returns false when it was already consumed or removed. */
  claimResend(resendOfSteerId: string, replacementMessageId: string): boolean {
    return runChanges(this.db.update(turnSteers).set({ state: "closed", updatedAt: nowSql }).where(and(
      eq(turnSteers.messageId, resendOfSteerId),
      eq(turnSteers.state, "resend_queued"),
      eq(turnSteers.replacementMessageId, replacementMessageId),
    ))).changes === 1;
  }

  /** At startup no adapter call survives, and the provider may hold any pending steer. */
  markPendingUnknown(): number {
    return runChanges(this.db.update(turnSteers).set({ state: "delivery_unknown", updatedAt: nowSql })
      .where(eq(turnSteers.state, "pending"))).changes;
  }

  /** Delete settled steers last changed more than `maxAgeDays` ago. Held steers never expire. */
  deleteSettledOlderThan(maxAgeDays: number): number {
    return runChanges(this.db.delete(turnSteers).where(and(
      inArray(turnSteers.state, [...SETTLED_STATES]),
      lt(turnSteers.updatedAt, sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${maxAgeDays}`} || ' days')`),
    ))).changes;
  }

  private transition(
    messageId: string,
    from: readonly TurnSteerRecord["state"][],
    columns: Partial<Pick<TurnSteerRow, "state" | "rejection" | "replacementMessageId">>,
  ): boolean {
    return runChanges(this.db.update(turnSteers).set({ ...columns, updatedAt: nowSql })
      .where(and(eq(turnSteers.messageId, messageId), inArray(turnSteers.state, [...from])))).changes === 1;
  }
}
