import type { Database } from "bun:sqlite";
import { databaseWriteHandler } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { ThreadControlAuditStore } from "./thread-control-audit-store.js";
import { threadControlAuditWriteOperations } from "./thread-control-audit-write-operations.js";

/** Register synchronous complete operations on the application writer connection. */
export function buildThreadControlAuditStoreWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new ThreadControlAuditStore(db);
  return new Map<string, (input: unknown) => unknown>([
    [threadControlAuditWriteOperations.write.name, databaseWriteHandler(threadControlAuditWriteOperations.write, (input) => store.write(...input))],
  ]);
}
