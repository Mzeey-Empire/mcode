import type Database from "better-sqlite3";

export const description = "provider model cache";

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE provider_model_cache (
      provider_id TEXT PRIMARY KEY,
      models_json TEXT NOT NULL,
      fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
      model_count INTEGER NOT NULL DEFAULT 0
    )
  `);
}

export function down(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS provider_model_cache");
}
