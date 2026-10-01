import type { Database } from "bun:sqlite";
import { z } from "zod";
import { databaseWriteHandler, databaseWriteOperation } from "../database-write-operation.js";

const changesSchema = z.object({ count: z.number().int().nonnegative() });

/** Connection-local diagnostics used only by the isolated SQLite profile. */
export const sqliteProfileWriteOperations = {
  totalChanges: databaseWriteOperation("sqliteProfile.totalChanges", z.void(), z.number().int().nonnegative()),
};

/** Count the production owner's changed rows rather than the read connection's changes. */
export function sqliteProfileWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const operation = sqliteProfileWriteOperations.totalChanges;
  const statement = db.prepare("SELECT total_changes() AS count");
  return new Map([[operation.name, databaseWriteHandler(operation, () => changesSchema.parse(statement.get()).count)]]);
}
