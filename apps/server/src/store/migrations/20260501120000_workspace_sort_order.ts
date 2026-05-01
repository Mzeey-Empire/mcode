/**
 * Add sort_order for persistent sidebar project ordering.
 * Backfills from legacy pinned + last_opened_at visual order (with id tiebreaker).
 *
 * Idempotent: some databases already have `workspaces.sort_order` from a sibling
 * legacy migration (`00000000000019`) while `_migrations` has no row for this
 * timestamp. Re-adding the column would raise SQLITE_ERROR duplicate column.
 * When the column already exists with non-default ranks, the UPDATE backfill is
 * skipped so a persisted order is not reset.
 */

import type Database from "better-sqlite3";

export const description = "Add workspaces.sort_order and backfill from legacy order";

function workspacesHasSortOrder(db: Database.Database): boolean {
  const cols = db.pragma("table_info(workspaces)") as Array<{ name: string }>;
  return cols.some((c) => c.name === "sort_order");
}

/**
 * True when every row still has the default rank (0). Used so a re-run of this
 * migration does not overwrite a persisted custom order after the column already
 * existed (for example only `_migrations` was missing).
 */
function sortOrdersLookUninitialized(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n, MIN(sort_order) AS lo, MAX(sort_order) AS hi FROM workspaces",
    )
    .get() as { n: number; lo: number | null; hi: number | null };
  if (row.n === 0) return false;
  return row.lo === 0 && row.hi === 0;
}

/** Apply migration: add sort_order if missing, rank rows, index for list queries. */
export function up(db: Database.Database): void {
  const hadSortOrder = workspacesHasSortOrder(db);
  if (!hadSortOrder) {
    db.exec(
      "ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
    );
  }

  if (!hadSortOrder || sortOrdersLookUninitialized(db)) {
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
    `);
  }

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_workspaces_sort_order ON workspaces (sort_order ASC);",
  );
}

/** Revert migration: drop sort_order. Requires SQLite 3.35+. */
export function down(db: Database.Database): void {
  db.exec("DROP INDEX IF EXISTS idx_workspaces_sort_order;");
  if (!workspacesHasSortOrder(db)) {
    return;
  }
  db.exec("ALTER TABLE workspaces DROP COLUMN sort_order;");
}
