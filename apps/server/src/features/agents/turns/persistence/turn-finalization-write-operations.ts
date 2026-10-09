import type { Database } from "bun:sqlite";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { threads } from "../../../../runtime/persistence/sqlite/schema.js";
import { databaseWriteHandler, databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { TurnSnapshotStore } from "./turn-snapshot-store.js";
import { snapshotInput } from "./turn-snapshot-write-operations.js";

const persistSnapshotInput = z.object({
  snapshot: snapshotInput,
  markFilesChanged: z.boolean(),
}).strict();

/** Commit a snapshot and its thread file-change marker as one business write. */
export const persistTurnSnapshot = databaseWriteOperation(
  "turnFinalization.persistSnapshot",
  persistSnapshotInput,
  z.object({ snapshotId: z.string().min(1) }).strict(),
);

/**
 * Commit an interrupted attempt's snapshot only when its message has none. The check runs inside
 * the write because `turn_snapshots.message_id` is not unique and recovery can run concurrently.
 */
export const persistInterruptedAttemptSnapshot = databaseWriteOperation(
  "turnFinalization.persistInterruptedAttemptSnapshot",
  persistSnapshotInput,
  z.object({ snapshotId: z.string().min(1).nullable() }).strict(),
);

/** Construct terminal snapshot persistence against the writer connection. */
export function turnFinalizationWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const snapshots = new TurnSnapshotStore(db);
  const orm = drizzle(db);
  const persist = (input: z.infer<typeof persistSnapshotInput>): string => {
    const created = snapshots.create(input.snapshot);
    if (input.markFilesChanged) {
      orm.update(threads).set({ hasFileChanges: 1 })
        .where(and(eq(threads.id, input.snapshot.threadId), eq(threads.hasFileChanges, 0))).run();
    }
    return created.id;
  };
  return new Map([
    [persistTurnSnapshot.name, databaseWriteHandler(persistTurnSnapshot, (input) => ({ snapshotId: persist(input) }))],
    [persistInterruptedAttemptSnapshot.name, databaseWriteHandler(persistInterruptedAttemptSnapshot, (input) => ({
      snapshotId: snapshots.getByMessage(input.snapshot.messageId) ? null : persist(input),
    }))],
  ]);
}
