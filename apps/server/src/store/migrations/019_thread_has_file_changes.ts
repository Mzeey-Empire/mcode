/**
 * Add has_file_changes flag to the threads table.
 * DEFAULT 0 because the backfill below sets it to 1 only for threads that
 * have at least one turn_snapshot row with a non-empty files_changed array.
 */

import type Database from "better-sqlite3";

export const description = "Add has_file_changes column to threads";

/** Apply migration: add column, then backfill from turn_snapshots. */
export function up(db: Database.Database): void {
  db.exec(
    "ALTER TABLE threads ADD COLUMN has_file_changes INTEGER NOT NULL DEFAULT 0",
  );

  // Backfill: flip the flag for any thread with at least one snapshot
  // whose files_changed array is non-empty. The turn_snapshots(thread_id)
  // index from migration 007 keeps this efficient.
  db.exec(
    `UPDATE threads
     SET has_file_changes = 1
     WHERE id IN (
       SELECT DISTINCT thread_id
       FROM turn_snapshots
       WHERE json_array_length(files_changed) > 0
     )`,
  );
}

/** Revert migration: remove the column. */
export function down(db: Database.Database): void {
  db.exec(
    "ALTER TABLE threads DROP COLUMN has_file_changes",
  );
}
