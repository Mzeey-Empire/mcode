/**
 * Seeds Drizzle migration bookkeeping when opening a database that was migrated
 * with the legacy `_migrations` runner so `migrate()` stays in sync without
 * re-applying the baseline SQL.
 */

import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== undefined;
}

/**
 * When `_migrations` has rows but Drizzle tracking is absent, inserts the
 * baseline migration row using the same hash algorithm as Drizzle Kit.
 * Packaged production builds hit this path once per legacy database so
 * `migrate()` never replays destructive baseline SQL on existing installs.
 *
 * @param db Open SQLite database (foreign keys enabled by caller).
 * @param drizzleDir Absolute or cwd-relative path to `apps/server/drizzle`.
 */
export function bootstrapDrizzle(db: Database.Database, drizzleDir: string): void {
  if (tableExists(db, "__drizzle_migrations")) return;

  if (!tableExists(db, "_migrations")) return;
  const legacyCount = (
    db.prepare("SELECT count(*) AS c FROM _migrations").get() as { c: number }
  ).c;
  if (legacyCount === 0) return;

  const journalPath = join(drizzleDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const baseline = journal.entries[0];
  if (!baseline) {
    throw new Error("Drizzle journal has no entries; cannot bootstrap");
  }

  const sqlPath = join(drizzleDir, `${baseline.tag}.sql`);
  const sqlContent = readFileSync(sqlPath, "utf-8");
  const hash = createHash("sha256").update(sqlContent).digest("hex");

  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      hash text NOT NULL,
      created_at numeric
    )
  `);
  db.prepare(
    `INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)`,
  ).run(hash, baseline.when);
}
