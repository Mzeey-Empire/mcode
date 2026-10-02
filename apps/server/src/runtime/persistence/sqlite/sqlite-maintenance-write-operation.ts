import type { Database } from "bun:sqlite";
import { z } from "zod";
import { databaseWriteHandler, databaseWriteOperation } from "./database-write-operation.js";
import { optimizeSQLiteConnection } from "./sqlite-connection-policy.js";

/** Statistics maintenance can write ANALYZE results and belongs to the writable owner. */
export const sqliteOptimizeWriteOperation = databaseWriteOperation("database.optimize", z.void(), z.void());

/** Construct the fixed statistics command without accepting arbitrary SQL. */
export function sqliteMaintenanceWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  return new Map([
    [sqliteOptimizeWriteOperation.name, databaseWriteHandler(sqliteOptimizeWriteOperation, () => optimizeSQLiteConnection(db))],
  ]);
}
