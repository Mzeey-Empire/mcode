/**
 * Add pinned and last_opened_at columns to workspaces.
 * last_opened_at tracks recency separately from updated_at so pinning/recency
 * operations don't pollute the general update timestamp.
 * Backfills last_opened_at from updated_at so existing workspaces appear in recents.
 */

import type Database from "better-sqlite3";

export const description = "Add pinned and last_opened_at columns to workspaces";

/** Apply migration: add pinned and last_opened_at to workspaces, backfill last_opened_at from updated_at. */
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE workspaces ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE workspaces ADD COLUMN last_opened_at INTEGER;
    UPDATE workspaces SET last_opened_at = updated_at WHERE last_opened_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_workspaces_pinned_last_opened
      ON workspaces (pinned DESC, last_opened_at DESC);
  `);
}

/** Revert migration: remove pinned and last_opened_at from workspaces. Requires SQLite 3.35+. */
export function down(db: Database.Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_workspaces_pinned_last_opened;
    ALTER TABLE workspaces DROP COLUMN last_opened_at;
    ALTER TABLE workspaces DROP COLUMN pinned;
  `);
}
