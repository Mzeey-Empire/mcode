#!/usr/bin/env bun
/**
 * CLI entry point for managing SQLite migrations.
 *
 * Usage:
 *   bun run db:migrate status        - Show applied and pending migrations
 *   bun run db:migrate up [n]        - Apply all (or next n) pending migrations
 *   bun run db:migrate down [n]      - Roll back last 1 (or n) migrations
 *   bun run db:migrate new <name>    - Scaffold a new migration file
 */

import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { getMcodeDir } from "@mcode/shared";
import { MigrationRunner } from "../migrations/runner.js";
import { loadMigrations } from "../database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsDir = join(__dirname, "..", "migrations");

const dbPath = process.env.MCODE_DB_PATH ?? join(getMcodeDir(), "mcode.db");

/**
 * Generates a 14-character UTC timestamp suitable as a migration ID.
 * Format: YYYYMMDDHHMMSS (e.g. "20260428192500").
 */
function nowTimestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * Parses a 14-char `YYYYMMDDHHMMSS` UTC timestamp into a Date instance.
 */
function timestampToDate(ts: string): Date {
  const year = parseInt(ts.slice(0, 4), 10);
  const month = parseInt(ts.slice(4, 6), 10) - 1;
  const day = parseInt(ts.slice(6, 8), 10);
  const hour = parseInt(ts.slice(8, 10), 10);
  const minute = parseInt(ts.slice(10, 12), 10);
  const second = parseInt(ts.slice(12, 14), 10);
  return new Date(Date.UTC(year, month, day, hour, minute, second));
}

/**
 * Formats a Date as a 14-char `YYYYMMDDHHMMSS` UTC timestamp.
 */
function dateToTimestamp(d: Date): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * Returns the highest existing migration ID (the 14-digit prefix of any
 * `<id>_<slug>.ts` file) in `migrationsDir`, or `null` if none exist.
 */
function highestExistingMigrationId(): string | null {
  if (!existsSync(migrationsDir)) {
    return null;
  }
  const ids: string[] = [];
  for (const file of readdirSync(migrationsDir)) {
    const match = /^(\d{14})_.+\.ts$/.exec(file);
    if (match) {
      ids.push(match[1]);
    }
  }
  if (ids.length === 0) {
    return null;
  }
  return ids.reduce((a, b) => (a > b ? a : b));
}

/**
 * Returns a migration ID strictly greater than every existing migration ID
 * in `migrationsDir`. Falls back to `nowTimestamp()` when wall-clock time is
 * already ahead; otherwise bumps the highest existing ID by 1 second so
 * lexicographic ordering stays monotonic even if the local clock lags or a
 * branch with a later timestamp has already been merged.
 */
function nextMigrationId(): string {
  const now = nowTimestamp();
  const max = highestExistingMigrationId();
  if (max === null || now > max) {
    return now;
  }
  return dateToTimestamp(new Date(timestampToDate(max).getTime() + 1000));
}

/** Prints usage instructions and exits with the given code. */
function printUsage(exitCode = 0): never {
  console.log(`Usage:
  bun run db:migrate status          Show applied and pending migrations
  bun run db:migrate up [n]          Apply all (or next n) pending migrations
  bun run db:migrate down [n]        Roll back last 1 (or n) migrations
  bun run db:migrate new <name>      Scaffold a new migration file`);
  process.exit(exitCode);
}

/** Opens the database without running migrations (used by CLI to inspect state). */
function openDb(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

const [, , command, ...args] = process.argv;

if (!command || command === "--help" || command === "-h") {
  printUsage(0);
}

let db: Database.Database | undefined;

try {
  switch (command) {
    case "status": {
      db = openDb();
      const runner = new MigrationRunner(db, loadMigrations());
      const applied = runner.applied();
      const pending = runner.pending();

      if (applied.length === 0 && pending.length === 0) {
        console.log("No migrations found.");
      }

      for (const m of applied) {
        console.log(`✅ V${m.version} ${m.name}  (applied: ${m.appliedAt})`);
      }
      for (const m of pending) {
        console.log(`⏳ V${m.version} ${m.name}  [not yet applied]`);
      }
      break;
    }

    case "up": {
      const steps = args[0] !== undefined ? parseInt(args[0], 10) : undefined;
      if (steps !== undefined && (isNaN(steps) || steps <= 0)) {
        console.error("Error: n must be a positive integer");
        process.exit(1);
      }

      db = openDb();
      const runner = new MigrationRunner(db, loadMigrations());
      const pending = runner.pending();

      if (pending.length === 0) {
        console.log("Already up to date.");
        break;
      }

      const toApply = steps !== undefined ? pending.slice(0, steps) : pending;
      console.log(`Applying ${toApply.length} pending migration${toApply.length === 1 ? "" : "s"}...`);

      try {
        const result = runner.up(steps);
        for (const m of result.migrations) {
          console.log(`✅ V${m.version} ${m.name}`);
        }
        console.log(`Done. ${result.applied} migration${result.applied === 1 ? "" : "s"} applied.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case "down": {
      const steps = args[0] !== undefined ? parseInt(args[0], 10) : 1;
      if (isNaN(steps) || steps <= 0) {
        console.error("Error: n must be a positive integer");
        process.exit(1);
      }

      db = openDb();
      const runner = new MigrationRunner(db, loadMigrations());

      const appliedCount = runner.applied().length;
      const actualSteps = Math.min(steps, appliedCount);
      if (actualSteps === 0) {
        console.log("Nothing to roll back.");
        break;
      }
      console.log(`Rolling back ${actualSteps} migration${actualSteps !== 1 ? "s" : ""}...`);

      try {
        const result = runner.down(actualSteps);
        for (const m of result.migrations) {
          console.log(`↩️  V${m.version} ${m.name}`);
        }
        console.log(`Done. ${result.reverted} migration${result.reverted === 1 ? "" : "s"} reverted.`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case "new": {
      const name = args[0];
      if (!name) {
        console.error("Error: missing required argument <name>");
        process.exit(1);
      }

      const slug = name
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_]/g, "");

      if (!slug) {
        console.error("Error: migration name must contain at least one alphanumeric character");
        process.exit(1);
      }

      const timestamp = nextMigrationId();
      const filename = `${timestamp}_${slug}.ts`;
      const outputPath = join(migrationsDir, filename);

      if (existsSync(outputPath)) {
        console.error(`Error: ${filename} already exists`);
        process.exit(1);
      }

      mkdirSync(migrationsDir, { recursive: true });

      const scaffold = `import type Database from "better-sqlite3";

export const description = ${JSON.stringify(name)};

/** Apply this migration. Runner wraps this in a transaction. */
export function up(_db: Database.Database): void {
  // TODO: implement migration
}

/** Reverse this migration. Throw if rollback is not possible. */
export function down(_db: Database.Database): void {
  // TODO: implement rollback
}
`;

      writeFileSync(outputPath, scaffold);
      console.log(`Created: apps/server/src/store/migrations/${filename}`);
      console.log(`  Next: register it in apps/server/src/store/database.ts (loadMigrations)`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage(1);
  }
} finally {
  db?.close();
}
