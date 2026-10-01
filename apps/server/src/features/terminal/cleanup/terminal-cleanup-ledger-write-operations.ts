import { z } from "zod";
import type { Database } from "bun:sqlite";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { TerminalCleanupLedgerStore } from "./terminal-cleanup-ledger-store.js";

const record = z.object({
  sessionId: z.string().uuid(), hostGeneration: z.string(), rootPid: z.number().int(),
  processGroupId: z.string(), containment: z.enum(["job-object", "process-group"]),
  createdAt: z.string().optional(), updatedAt: z.string().optional(),
}).strict();

/** Durable process cleanup identities and generation-fenced removals. */
export const terminalCleanupLedgerWriteOperations = {
  record: databaseWriteOperation("terminalCleanupLedger.record", z.tuple([record, z.number().int().min(1).max(20)]), z.void()),
  remove: databaseWriteOperation("terminalCleanupLedger.remove", z.tuple([z.string(), z.string()]), z.boolean()),
};

/** Bind terminal ledger writes to the sole writable connection. */
export function terminalCleanupLedgerWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new TerminalCleanupLedgerStore(db);
  const operations = terminalCleanupLedgerWriteOperations;
  return new Map([
    [operations.record.name, databaseWriteHandler(operations.record, (input) => new TerminalCleanupLedgerStore(db, input[1]).record(input[0]))],
    [operations.remove.name, databaseWriteHandler(operations.remove, (input) => store.remove(...input))],
  ]);
}
