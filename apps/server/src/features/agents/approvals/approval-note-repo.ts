import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { inject, injectable } from "tsyringe";
import { z } from "zod";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { runChanges } from "../../../runtime/persistence/sqlite/drizzle-changes.js";
import { approvalNotes } from "../../../runtime/persistence/sqlite/schema.js";
import type { ApprovalNoteAdmissionError } from "@mcode/contracts";

/** Stable admission failure preserved across the database writer boundary. */
export class ApprovalNoteAlreadyDeliveredError extends Error implements ApprovalNoteAdmissionError {
  readonly code = "note_already_delivered";
  constructor() {
    super("This note was already sent or removed");
    this.name = "ApprovalNoteAlreadyDeliveredError";
  }
}

const deliverySchema = z.enum(["native", "steer", "next_turn"]);
const heldStateSchema = z.enum(["queued", "delivery_unknown"]);
const intentSchema = z.object({ requestId: z.string(), threadId: z.string(), note: z.string(), delivery: deliverySchema });
const rowSchema = intentSchema.extend({
  state: z.enum(["pending", "queued", "delivered", "delivery_unknown", "removed"]),
  createdAt: z.string(), updatedAt: z.string(),
});
/** Persisted note and the last known delivery state. */
export type ApprovalNoteRow = z.infer<typeof rowSchema>;

const insert = databaseWriteOperation("approvalNote.insert", intentSchema, z.void());
const recover = databaseWriteOperation("approvalNote.recover", z.string().optional(), z.void());
const settle = databaseWriteOperation("approvalNote.settle", z.object({
  requestId: z.string(), delivery: z.enum(["native", "steer", "next_turn", "unknown"]),
}), z.void());
const update = databaseWriteOperation("approvalNote.update", z.object({ requestId: z.string(), note: z.string().trim().min(1).max(4_000) }), z.boolean());
const resend = databaseWriteOperation("approvalNote.resend", z.string(), z.boolean());
const remove = databaseWriteOperation("approvalNote.remove", z.string(), z.boolean());

/** Allowlisted mutations executed on the database writer connection. */
export function approvalNoteWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const orm = drizzle(db);
  const held = (requestId: string) => and(eq(approvalNotes.requestId, requestId), inArray(approvalNotes.state, ["queued", "delivery_unknown"]));
  return new Map([
    [insert.name, databaseWriteHandler(insert, (input) => {
      orm.insert(approvalNotes).values({ ...input, state: "pending" }).onConflictDoNothing().run();
    })],
    [recover.name, databaseWriteHandler(recover, (requestId) => {
      orm.update(approvalNotes).set({
        state: sql`CASE WHEN ${approvalNotes.delivery} = 'next_turn' THEN 'queued' ELSE 'delivery_unknown' END`,
        updatedAt: new Date().toISOString(),
      }).where(and(eq(approvalNotes.state, "pending"), requestId === undefined ? undefined : eq(approvalNotes.requestId, requestId))).run();
    })],
    [settle.name, databaseWriteHandler(settle, ({ requestId, delivery }) => {
      let state: ApprovalNoteRow["state"] = "delivered";
      if (delivery === "unknown") state = "delivery_unknown";
      if (delivery === "next_turn") state = "queued";
      orm.update(approvalNotes).set({ state, ...(delivery === "unknown" ? {} : { delivery }), updatedAt: new Date().toISOString() })
        .where(and(eq(approvalNotes.requestId, requestId), eq(approvalNotes.state, "pending"))).run();
    })],
    [update.name, databaseWriteHandler(update, ({ requestId, note }) => runChanges(orm.update(approvalNotes)
      .set({ note, updatedAt: new Date().toISOString() }).where(held(requestId))).changes > 0)],
    [resend.name, databaseWriteHandler(resend, (requestId) => runChanges(orm.update(approvalNotes)
      .set({ state: "queued", delivery: "next_turn", updatedAt: new Date().toISOString() }).where(held(requestId))).changes > 0)],
    [remove.name, databaseWriteHandler(remove, (requestId) => runChanges(orm.update(approvalNotes)
      .set({ state: "removed", updatedAt: new Date().toISOString() }).where(held(requestId))).changes > 0)],
  ]);
}

/** Reads note state and commits every mutation through the shared database writer. */
@injectable()
export class ApprovalNoteRepo {
  private readonly orm;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.orm = drizzle(db);
  }

  /** Read durable intent by approval request id. */
  find(requestId: string): ApprovalNoteRow | null {
    const row = this.orm.select().from(approvalNotes).where(eq(approvalNotes.requestId, requestId)).get();
    return row ? rowSchema.parse(row) : null;
  }

  /** Restore only notes that still need a user message or an explicit decision. */
  listNotes() {
    return this.orm.select({ requestId: approvalNotes.requestId, threadId: approvalNotes.threadId, note: approvalNotes.note, state: approvalNotes.state })
      .from(approvalNotes).where(inArray(approvalNotes.state, ["queued", "delivery_unknown"]))
      .orderBy(asc(approvalNotes.createdAt), asc(approvalNotes.requestId)).limit(500).all()
      .map((row) => ({ ...row, state: heldStateSchema.parse(row.state) }));
  }

  /** Persist intent before calling the provider. */
  insertPending(input: z.infer<typeof intentSchema>): Promise<void> {
    return this.writer.execute(insert, input);
  }

  /** Recover all pending attempts at startup, or one ended attempt on retry. */
  recoverPending(requestId?: string): Promise<void> {
    return this.writer.execute(recover, requestId);
  }

  /** Record the adapter's final delivery result. */
  settle(requestId: string, delivery: z.infer<typeof settle.input>["delivery"]): Promise<void> {
    return this.writer.execute(settle, { requestId, delivery });
  }

  /** Edit only a held note. */
  updateNote(requestId: string, note: string): Promise<boolean> {
    return this.writer.execute(update, { requestId, note });
  }

  /** Explicitly authorize a held note to enter turn admission. */
  resendNote(requestId: string): Promise<boolean> {
    return this.writer.execute(resend, requestId);
  }

  /** Retain a tombstone so removed notes cannot return on reconnect. */
  removeNote(requestId: string): Promise<boolean> {
    return this.writer.execute(remove, requestId);
  }
}
