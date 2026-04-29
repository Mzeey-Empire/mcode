/**
 * SQLite database setup with WAL mode, foreign keys, and forward-only migrations.
 * Migrated from apps/desktop/src/main/store/database.ts for standalone server use.
 */

import Database from "better-sqlite3";
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { getMcodeDir } from "@mcode/shared";
import { MigrationRunner } from "./migrations/runner.js";
import type { MigrationModule } from "./migrations/runner.js";
import * as m001 from "./migrations/00000000000001_initial_schema.js";
import * as m002 from "./migrations/00000000000002_thread_model.js";
import * as m003 from "./migrations/00000000000003_thread_worktree_managed.js";
import * as m004 from "./migrations/00000000000004_message_attachments.js";
import * as m005 from "./migrations/00000000000005_thread_sdk_session_id.js";
import * as m006 from "./migrations/00000000000006_drop_thread_pid_session_name.js";
import * as m007 from "./migrations/00000000000007_tool_call_records_turn_snapshots.js";
import * as m008 from "./migrations/00000000000008_thread_tasks.js";
import * as m009 from "./migrations/00000000000009_thread_context_tracking.js";
import * as m010 from "./migrations/00000000000010_cleanup_jobs.js";
import * as m011 from "./migrations/00000000000011_thread_provider.js";
import * as m012 from "./migrations/00000000000012_thread_reasoning_interaction_permission.js";
import * as m013 from "./migrations/00000000000013_clear_non_claude_context_window.js";
import * as m014 from "./migrations/00000000000014_thread_branching.js";
import * as m015 from "./migrations/00000000000015_thread_compact_summary.js";
import * as m016 from "./migrations/00000000000016_copilot_agent.js";
import * as m017 from "./migrations/00000000000017_workspace_is_git_repo.js";
import * as m018 from "./migrations/00000000000018_thread_context_window_mode_thinking.js";
import * as m020 from "./migrations/00000000000020_thread_has_file_changes.js";
import * as mPinned from "./migrations/20260429000000_workspace_pinned_and_last_opened.js";

/**
 * Resolve the correct native binding for better-sqlite3 based on runtime.
 *
 * Priority:
 * 1. `BETTER_SQLITE3_BINDING` env var — set by server-manager when the app is
 *    packaged, pointing to the asarUnpack'd `.node` file outside the asar archive.
 * 2. Electron runtime path resolution — used in dev mode when running under
 *    Electron with the source tree present.
 * 3. `undefined` — falls back to better-sqlite3's default binding resolution
 *    for plain Node.js (e.g. vitest).
 */
function resolveNativeBinding(): string | undefined {
  if (process.env.BETTER_SQLITE3_BINDING) {
    return process.env.BETTER_SQLITE3_BINDING;
  }

  if (!process.versions.electron) return undefined;

  const localRequire = createRequire(import.meta.url);
  const betterSqliteDir = dirname(
    localRequire.resolve("better-sqlite3/package.json"),
  );
  const bindingCandidates = [
    join(betterSqliteDir, "build", "Release", "better_sqlite3.electron.node"),
    join(betterSqliteDir, "build", "Release", "better_sqlite3.node"),
  ];
  const bindingPath = bindingCandidates.find((candidate) => existsSync(candidate));

  if (!bindingPath) {
    throw new Error(
      `Electron prebuild not found. Checked: ${bindingCandidates.join(", ")}. Run 'bun install' to download it.`,
    );
  }

  return bindingPath;
}

/** Builds the ordered map of all migration modules keyed by 14-char zero-padded version string. */
export function loadMigrations(): Map<string, MigrationModule> {
  const migrations = new Map<string, MigrationModule>();
  migrations.set("00000000000001", m001);
  migrations.set("00000000000002", m002);
  migrations.set("00000000000003", m003);
  migrations.set("00000000000004", m004);
  migrations.set("00000000000005", m005);
  migrations.set("00000000000006", m006);
  migrations.set("00000000000007", m007);
  migrations.set("00000000000008", m008);
  migrations.set("00000000000009", m009);
  migrations.set("00000000000010", m010);
  migrations.set("00000000000011", m011);
  migrations.set("00000000000012", m012);
  migrations.set("00000000000013", m013);
  migrations.set("00000000000014", m014);
  migrations.set("00000000000015", m015);
  migrations.set("00000000000016", m016);
  migrations.set("00000000000017", m017);
  migrations.set("00000000000018", m018);
  // 00000000000019 is intentionally absent: the original 019 was renumbered to
  // 020 before the integer→timestamp migration landed, to avoid a version
  // collision with the feat/modern-project-selector branch's 019 migration.
  migrations.set("00000000000020", m020);
  // Project-selector PR landed `020_workspace_pinned_and_last_opened.ts` on
  // main while this branch was concurrently switching to timestamp keys.
  // It was renamed to a real UTC timestamp on merge; legacy DBs that applied
  // it as integer 20 are translated by schema sniffing in the runner.
  migrations.set("20260429000000", mPinned);
  return migrations;
}

/**
 * Open (or create) a SQLite database with WAL mode and foreign keys enabled,
 * then run any pending migrations.
 */
export function openDatabase(dbPath?: string): Database.Database {
  const resolvedPath =
    dbPath ?? process.env.MCODE_DB_PATH ?? join(getMcodeDir(), "mcode.db");
  const nativeBinding = resolveNativeBinding();
  const db = new Database(resolvedPath, { nativeBinding });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000"); // Wait up to 5s for concurrent writer to finish
  db.pragma("foreign_keys = ON");
  db.pragma("cache_size = -2000");  // 2MB page cache (negative = KB)
  db.pragma("mmap_size = 0");       // Disable memory-mapped I/O
  try {
    new MigrationRunner(db, loadMigrations()).up();
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Open an in-memory database for testing. Applies the same WAL mode, foreign
 * keys, and migrations as a file-backed database. Memory-tuning pragmas
 * (cache_size, mmap_size) are omitted as they are not meaningful for
 * in-memory databases.
 */
export function openMemoryDatabase(): Database.Database {
  const nativeBinding = resolveNativeBinding();
  const db = new Database(":memory:", { nativeBinding });
  db.pragma("foreign_keys = ON");
  try {
    new MigrationRunner(db, loadMigrations()).up();
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
