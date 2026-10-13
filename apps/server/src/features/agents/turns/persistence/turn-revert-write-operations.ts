import type { Database } from "bun:sqlite";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { messages, turnReverts } from "../../../../runtime/persistence/sqlite/schema.js";
import { databaseWriteHandler, databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { MessageStore } from "../../conversation/persistence/message-store.js";
import { RevertContextSchema, RevertPathSchema, transitionRevert } from "../../../projects/diffs/revert/turn-revert-model.js";

/** Persist the full journal only after recovery material has been pinned. */
export const prepareTurnRevert = databaseWriteOperation("turnRevert.prepare", z.object({
  id: z.string().uuid(), requestId: z.string().uuid(), threadId: z.string(), targetMessageId: z.string(),
  fromMessageId: z.string().nullable(), kind: z.enum(["turn", "file", "undo"]), path: z.string().nullable(),
  undoesRevertId: z.string().nullable(), context: RevertContextSchema,
  files: z.array(RevertPathSchema).max(512), recoveryRef: z.string(),
}), z.void());
/** Commit the state transition, any recovery receipt, and Undo link in one writer transaction. */
export const settleTurnRevert = databaseWriteOperation("turnRevert.settle", z.object({
  id: z.string(), state: z.enum(["committed", "rolled_back", "recovery_failed"]), content: z.string().nullable(),
  failure: z.object({ paths: z.array(z.string()), detail: z.string() }).nullable(),
  failCommit: z.boolean().optional(),
}), z.void());
/** Clear expired recovery material without deleting replay history. */
export const expireTurnRevert = databaseWriteOperation("turnRevert.expire", z.object({ id: z.string() }), z.void());

/** Claim exactly the prompt's reverts inside the caller's user-message transaction. */
export function markTurnRevertsAgentNotified(db: Database, threadId: string, revertIds: readonly string[]): void {
  if (revertIds.length === 0) return;
  const claimed = drizzle(db).update(turnReverts).set({ agentNotifiedAt: new Date().toISOString() }).where(and(
    eq(turnReverts.threadId, threadId), inArray(turnReverts.id, [...revertIds]),
    eq(turnReverts.state, "committed"), inArray(turnReverts.kind, ["turn", "file"]),
    isNull(turnReverts.undoneByRevertId), isNull(turnReverts.agentNotifiedAt),
  )).returning({ id: turnReverts.id }).all();
  if (claimed.length !== revertIds.length) throw new StaleRevertNoticeError();
}

/** An Undo or a concurrent admission claimed a revert after its note entered the prompt. */
export class StaleRevertNoticeError extends Error {
  name = "StaleRevertNoticeError";
  constructor() {
    super("Revert notice changed during turn admission");
  }
}

/** Journal writes execute only on the application's writable connection. */
export function turnRevertWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const orm = drizzle(db);
  return new Map([
    [prepareTurnRevert.name, databaseWriteHandler(prepareTurnRevert, (input) => {
      const { context, files, ...row } = input;
      orm.insert(turnReverts).values({ ...row, state: "prepared", requestParams: JSON.stringify(context), files: JSON.stringify(files) }).run();
    })],
    [settleTurnRevert.name, databaseWriteHandler(settleTurnRevert, (input) => db.transaction(() => {
      const row = orm.select().from(turnReverts).where(eq(turnReverts.id, input.id)).get();
      if (!row) throw new Error("Revert journal disappeared");
      const state = transitionRevert(row.state, input.state);
      const receiptMessageId = writeReceipt(db, { ...row, state }, input.content);
      orm.update(turnReverts).set({ state, receiptMessageId, failure: input.failure ? JSON.stringify(input.failure) : null,
        updatedAt: new Date().toISOString() }).where(eq(turnReverts.id, row.id)).run();
      if (state === "committed" && row.undoesRevertId) orm.update(turnReverts).set({ undoneByRevertId: row.id }).where(eq(turnReverts.id, row.undoesRevertId)).run();
      if (input.failCommit) throw new Error("Injected revert commit failure");
    })())],
    [expireTurnRevert.name, databaseWriteHandler(expireTurnRevert, ({ id }) => {
      const row = orm.select().from(turnReverts).where(eq(turnReverts.id, id)).get();
      if (row?.state === "committed" || row?.state === "rolled_back") orm.update(turnReverts).set({ recoveryRef: null }).where(eq(turnReverts.id, id)).run();
    })],
  ]);
}

function writeReceipt(db: Database, row: typeof turnReverts.$inferSelect, content: string | null): string | null {
  if (content === null) return row.receiptMessageId;
  if (row.receiptMessageId) {
    drizzle(db).update(messages).set({ content }).where(eq(messages.id, row.receiptMessageId)).run();
    return row.receiptMessageId;
  }
  const notices = new MessageStore(db);
  const kind = row.state === "committed" ? (row.kind === "undo" ? "turn-revert-undone" : "turn-reverted") : "turn-revert-interrupted";
  return notices.createSystemNotice(row.threadId, content, notices.getLatestSequenceIncludingInternal(row.threadId) + 1,
    { kind, presentation: "timeline", revertId: row.id }).id;
}
