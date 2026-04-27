import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description =
  "Add context_window_mode and thinking columns to threads (per-thread 200k/1M opt-in + Haiku thinking toggle)";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  // context_window_mode: '200k' | '1m' | NULL (NULL = inherit from settings).
  // thinking: 0 | 1 | NULL (NULL = inherit). Stored as INTEGER because SQLite
  // has no native boolean type; the repo layer converts to TypeScript boolean.
  const sql = `
    ALTER TABLE threads ADD COLUMN context_window_mode TEXT DEFAULT NULL;
    ALTER TABLE threads ADD COLUMN thinking INTEGER DEFAULT NULL;
  `;
  db.exec(sql);
}

/**
 * Reverse this migration.
 * Drops both new columns. SQLite supports DROP COLUMN since 3.35 (2021),
 * which is comfortably below the better-sqlite3 minimum.
 */
export function down(db: Database.Database): void {
  const dropMode = "ALTER TABLE threads DROP COLUMN context_window_mode";
  const dropThinking = "ALTER TABLE threads DROP COLUMN thinking";
  db.exec(dropMode);
  db.exec(dropThinking);
}
