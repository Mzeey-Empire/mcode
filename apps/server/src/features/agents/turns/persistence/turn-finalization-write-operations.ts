import type { Database } from "bun:sqlite";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { threads } from "../../../../runtime/persistence/sqlite/schema.js";
import { databaseWriteHandler, databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { TurnSnapshotStore } from "./turn-snapshot-store.js";
import { snapshotInput } from "./turn-snapshot-write-operations.js";

/** Commit a snapshot and its thread file-change marker as one business write. */
export const persistTurnSnapshot = databaseWriteOperation("turnFinalization.persistSnapshot", z.object({
  snapshot: snapshotInput,
  markFilesChanged: z.boolean(),
}).strict(), z.object({ snapshotId: z.string().min(1) }).strict());

/** Construct terminal snapshot persistence against the writer connection. */
export function turnFinalizationWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const snapshots = new TurnSnapshotStore(db);
  const orm = drizzle(db);
  return new Map([[persistTurnSnapshot.name, databaseWriteHandler(persistTurnSnapshot, (input) => {
    const created = snapshots.create(input.snapshot);
    if (input.markFilesChanged) {
      orm.update(threads).set({ hasFileChanges: 1 })
        .where(and(eq(threads.id, input.snapshot.threadId), eq(threads.hasFileChanges, 0))).run();
    }
    return { snapshotId: created.id };
  })]]);
}
