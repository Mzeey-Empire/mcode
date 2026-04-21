/**
 * Add is_git_repo flag to the workspaces table.
 * DEFAULT 1 because all existing workspaces were created from git repos
 * (non-git support did not exist before this migration).
 */

import type Database from "better-sqlite3";

export const description = "Add is_git_repo column to workspaces";

export function up(db: Database.Database): void {
  db.prepare(
    "ALTER TABLE workspaces ADD COLUMN is_git_repo INTEGER NOT NULL DEFAULT 1",
  ).run();
}

export function down(db: Database.Database): void {
  db.prepare(
    "ALTER TABLE workspaces DROP COLUMN is_git_repo",
  ).run();
}
