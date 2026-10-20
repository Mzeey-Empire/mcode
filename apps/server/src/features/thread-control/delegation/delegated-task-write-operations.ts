import type { Database } from "bun:sqlite";
import { z } from "zod";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { DelegatedTaskSchema, DelegatedTaskStore } from "./delegated-task-store.js";

/** Receipt claims cross the writer boundary as a single complete operation. */
export const claimDelegatedTask = databaseWriteOperation("delegatedTask.claim",
  z.tuple([DelegatedTaskSchema.omit({ taskId: true, createdAt: true })]),
  z.union([
    z.object({ kind: z.enum(["claimed", "existing"]), task: DelegatedTaskSchema }),
    z.object({ kind: z.literal("conflict") }),
  ]));

/** Register the receipt claim on the sole writable SQLite connection. */
export function delegatedTaskWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new DelegatedTaskStore(db);
  return new Map([[claimDelegatedTask.name, databaseWriteHandler(claimDelegatedTask, ([input]) => store.claim(input))]]);
}
