#!/usr/bin/env bun
/**
 * Builds the worktree's development database from a filtered copy of the real one.
 *
 * The donor is only read through `VACUUM INTO`. The copy is pruned to recent, stopped history in
 * {@link filterSeedDatabase}, then renamed over `.dev/db/app.sqlite`, so a failed build never touches the
 * database a runtime may already be using.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { Database } from "bun:sqlite";

import {
  markRuntimeDatabase,
  prepareRuntimeDatabaseSnapshot,
  readRuntimeDatabaseSeedVersion,
} from "./agent/runtime-database.mjs";
import { resolveRepoRoot } from "./agent/runtime-contract.mjs";
import { SEED_FILTER_VERSION, filterSeedDatabase } from "./db-seed-filter.mjs";

/**
 * Resolves default source database path (`~/.mcode/mcode.db` or `~/.mcode-dev/mcode.db`).
 *
 * @param {string} [preferredSource]
 * @returns {string}
 */
export function resolveSourceDbPath(preferredSource) {
  if (preferredSource) return NodePath.resolve(preferredSource);

  const prodPath = NodePath.join(NodeOS.homedir(), ".mcode", "mcode.db");
  if (NodeFS.existsSync(prodPath)) return prodPath;

  const devPath = NodePath.join(NodeOS.homedir(), ".mcode-dev", "mcode.db");
  if (NodeFS.existsSync(devPath)) return devPath;

  return prodPath;
}

/**
 * Makes sure the worktree has a filtered development database, building one when needed.
 *
 * Reuses the existing database when `refresh` is false and its marker carries the current
 * {@link SEED_FILTER_VERSION}; a missing or older marker is rebuilt, which discards local data in it.
 * Any failure throws and leaves the existing database untouched.
 *
 * @param {{
 *   repoRoot?: string,
 *   refresh?: boolean,
 *   source?: string,
 *   maxWorkspaces?: number,
 *   maxFamiliesPerWorkspace?: number,
 * }} [options] `refresh` forces a rebuild and makes a missing donor an error.
 * @returns {{ status: "reused" | "seeded" | "no-donor", targetPath: string, sourcePath?: string, kept?: { workspaces: number, threads: number } }}
 *   `no-donor` means a launch found nothing to seed from, so the runtime starts from an empty database.
 */
export function ensureRuntimeDatabase(options = {}) {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const refresh = options.refresh ?? false;
  const paths = prepareRuntimeDatabaseSnapshot(repoRoot);
  const targetPath = paths.dbPath;

  if (!refresh && readRuntimeDatabaseSeedVersion(repoRoot) === SEED_FILTER_VERSION) {
    return { status: "reused", targetPath };
  }

  const sourcePath = resolveSourceDbPath(options.source);
  if (!NodeFS.existsSync(sourcePath)) {
    if (refresh) throw new Error(`Source database not found at: ${sourcePath}`);
    return { status: "no-donor", targetPath };
  }

  NodeFS.mkdirSync(paths.dbDir, { recursive: true });
  removeAbandonedBuilds(paths.dbDir, targetPath);
  const temporaryPath = NodePath.join(paths.dbDir, `.${NodePath.basename(targetPath)}.seed-${NodeCrypto.randomUUID()}`);
  try {
    const kept = buildFilteredCopy(sourcePath, temporaryPath, options);
    publishDatabase(temporaryPath, targetPath);
    markRuntimeDatabase(repoRoot);
    return { status: "seeded", targetPath, sourcePath, kept };
  } finally {
    NodeFS.rmSync(temporaryPath, { force: true });
    NodeFS.rmSync(`${temporaryPath}-journal`, { force: true });
  }
}

/**
 * Removes copies left by a build that was killed before its cleanup ran. They are full-size databases of
 * private history, so they must not accumulate. A copy another build still has open is skipped.
 */
function removeAbandonedBuilds(dbDir, targetPath) {
  const prefix = `.${NodePath.basename(targetPath)}.seed-`;
  for (const name of NodeFS.readdirSync(dbDir)) {
    if (!name.startsWith(prefix)) continue;
    try {
      NodeFS.rmSync(NodePath.join(dbDir, name), { force: true });
    } catch (error) {
      if (!error || (error.code !== "EBUSY" && error.code !== "EPERM")) throw error;
    }
  }
}

/** Copies the donor read-only, then prunes the copy; the donor is never opened for writing. */
function buildFilteredCopy(sourcePath, temporaryPath, limits) {
  const donor = new Database(sourcePath, { readonly: true });
  try {
    donor.run(`VACUUM INTO '${temporaryPath.replaceAll("'", "''")}'`);
  } finally {
    donor.close(true);
  }

  const copy = new Database(temporaryPath);
  try {
    const kept = filterSeedDatabase(copy, limits);
    // Deleting rows leaves their bytes in free pages, so rebuild the file to leave no private history behind.
    copy.run("VACUUM");
    return kept;
  } finally {
    copy.close(true);
  }
}

/**
 * Renames the finished copy over the target. The target is never removed first, so a rename that fails
 * (for example because a running server holds it) leaves the old database as it was.
 */
function publishDatabase(temporaryPath, targetPath) {
  try {
    NodeFS.renameSync(temporaryPath, targetPath);
  } catch (error) {
    if (error && (error.code === "EBUSY" || error.code === "EPERM")) {
      throw new Error(
        `Target database is locked by a running process (${targetPath}). Stop the server ('bun run agent:down') before seeding.`,
      );
    }
    throw error;
  }
  // A leftover WAL from the replaced database must not be replayed into the new file.
  NodeFS.rmSync(`${targetPath}-wal`, { force: true });
  NodeFS.rmSync(`${targetPath}-shm`, { force: true });
}

/**
 * Parses CLI arguments for the donor and the filter limits.
 *
 * @param {string[]} args
 * @returns {{ source?: string, maxWorkspaces?: number, maxFamiliesPerWorkspace?: number }}
 */
function parseCliArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === "--source" && value) {
      parsed.source = value;
      i++;
    } else if (args[i] === "--projects" && value) {
      parsed.maxWorkspaces = Number(value);
      i++;
    } else if (args[i] === "--threads-per-project" && value) {
      parsed.maxFamiliesPerWorkspace = Number(value);
      i++;
    }
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  try {
    const result = ensureRuntimeDatabase({ ...parseCliArgs(process.argv.slice(2)), refresh: true });
    console.log(`Source DB : ${result.sourcePath}`);
    console.log(`Target DB : ${result.targetPath}`);
    console.log(`Kept      : ${result.kept.workspaces} workspaces, ${result.kept.threads} threads`);
  } catch (err) {
    console.error(`Failed to seed database: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
