/**
 * Add sort_order for persistent sidebar project ordering.
 * Backfills from legacy pinned + last_opened_at visual order (with id tiebreaker).
 */

import type Database from "better-sqlite3";

export const description = "Add workspaces.sort_order and backfill from legacy order";

/** Apply migration: add sort_order, rank rows, index for list queries. */
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

    UPDATE workspaces SET sort_order = (
      SELECT COUNT(*) FROM workspaces w2
      WHERE (w2.pinned > workspaces.pinned)
         OR (w2.pinned = workspaces.pinned AND w2.last_opened_at IS NOT NULL
             AND workspaces.last_opened_at IS NOT NULL
             AND w2.last_opened_at > workspaces.last_opened_at)
         OR (w2.pinned = workspaces.pinned AND w2.last_opened_at IS NOT NULL
             AND workspaces.last_opened_at IS NULL)
         OR (w2.pinned = workspaces.pinned
             AND ((w2.last_opened_at IS NULL AND workspaces.last_opened_at IS NULL)
                  OR (w2.last_opened_at IS NOT NULL AND workspaces.last_opened_at IS NOT NULL
                      AND w2.last_opened_at = workspaces.last_opened_at))
             AND w2.id < workspaces.id)
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_sort_order ON workspaces (sort_order ASC);
  `);
}

/** Revert migration: drop sort_order. Requires SQLite 3.35+. */
export function down(db: Database.Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_workspaces_sort_order;
    ALTER TABLE workspaces DROP COLUMN sort_order;
  `);
}
