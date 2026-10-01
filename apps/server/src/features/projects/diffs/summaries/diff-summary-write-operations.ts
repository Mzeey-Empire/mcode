import { z } from "zod";
import type { Database } from "bun:sqlite";
import { databaseWriteHandler, databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { DiffSummaryStore } from "./diff-summary-store.js";

const record = z.object({ id: z.string(), threadId: z.string(), content: z.string(), turnCount: z.number().int().nonnegative(), lastTurnId: z.string().nullable(), model: z.string(), createdAt: z.string() }).strict();

/** Committed per-thread diff summary replacement. */
export const diffSummaryWriteOperations = { upsert: databaseWriteOperation("diffSummary.upsert", z.tuple([record]), record) };

/** Bind diff summary writes to the sole writable connection. */
export function diffSummaryWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new DiffSummaryStore(db);
  const operation = diffSummaryWriteOperations.upsert;
  return new Map([[operation.name, databaseWriteHandler(operation, (input) => store.upsert(...input))]]);
}
