/**
 * Add the provider_model_cache table for persistent, stale-while-revalidate
 * model lists per provider. Lets the model picker render instantly on app
 * launch without waiting for live provider responses.
 */

import type Database from "better-sqlite3";

export const description = "provider model cache";

/** Apply migration: create provider_model_cache table keyed by provider_id. */
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

/** Revert migration: drop provider_model_cache table. */
export function down(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS provider_model_cache");
}
