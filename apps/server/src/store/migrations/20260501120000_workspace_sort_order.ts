/**
 * Add sort_order for persistent sidebar project ordering.
 * Backfills from legacy pinned + last_opened_at visual order (with id tiebreaker).
 *
 * Idempotent: some databases already have `workspaces.sort_order` from a sibling
 * legacy migration (`00000000000019`) while `_migrations` has no row for this
 * timestamp. Re-adding the column would raise SQLITE_ERROR duplicate column.
 */

import type Database from "better-sqlite3";

export const description = "Add workspaces.sort_order and backfill from legacy order";

function workspacesHasSortOrder(db: Database.Database): boolean {
  const cols = db.pragma("table_info(workspaces)") as Array<{ name: string }>;
  return cols.some((c) => c.name === "sort_order");
}

/** Apply migration: add sort_order if missing, rank rows, index for list queries. */
export function up(db: Database.Database): void {
  if (!workspacesHasSortOrder(db)) {
    db.exec(
      "ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
    );
  }

  db.exec(`
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
  db.exec("DROP INDEX IF EXISTS idx_workspaces_sort_order;");
  if (!workspacesHasSortOrder(db)) {
    return;
  }
  db.exec("ALTER TABLE workspaces DROP COLUMN sort_order;");
}
