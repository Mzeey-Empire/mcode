/** Validates and marks the worktree-local database seed owned by the runtime launchers. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import { SEED_FILTER_VERSION } from "../db-seed-filter.mjs";
import {
  assertRuntimeDirectorySafe,
  assertRuntimeFileSafe,
  assertRuntimeRootSafe as assertSafeRuntimeRoot,
  ensureRuntimeRoot,
  getRuntimePaths,
} from "./runtime-contract.mjs";

const DATABASE_MARKER = ".agent-runtime-database";
const MARKER_HEADER = "agent-runtime-snapshot\n";
const MARKER_PATTERN = /^agent-runtime-snapshot\nseed-filter-version=(\d+)\n$/;

/** Version of the marker written before the seed was filtered; it vouches for an unfiltered copy of a real database. */
const UNFILTERED_SEED_VERSION = 0;

/** Rejects a linked runtime root before setup inspects or removes its contents. */
export function assertRuntimeRootSafe(repoRoot) {
  assertSafeRuntimeRoot(repoRoot);
}

/** Prepares safe local paths before SQLite replaces the worktree database. */
export function prepareRuntimeDatabaseSnapshot(repoRoot) {
  assertRuntimeRootSafe(repoRoot);
  const paths = ensureRuntimeRoot(repoRoot);
  assertRuntimeDirectorySafe(paths.dbDir, "database directory", true);
  assertRuntimeFileSafe(paths.dbPath, "database", true);
  assertRuntimeFileSafe(NodePath.join(paths.dbDir, DATABASE_MARKER), "database marker", true);
  return paths;
}

/** Marks a safely seeded local database with the filter version that produced it. */
export function markRuntimeDatabase(repoRoot, seedVersion = SEED_FILTER_VERSION) {
  assertRuntimeRootSafe(repoRoot);
  const paths = getRuntimePaths(repoRoot);
  assertRuntimeDirectorySafe(paths.devDir, "runtime directory");
  assertRuntimeDirectorySafe(paths.dbDir, "database directory");
  assertRuntimeFileSafe(paths.dbPath, "database");
  const markerPath = NodePath.join(paths.dbDir, DATABASE_MARKER);
  assertRuntimeFileSafe(markerPath, "database marker", true);
  const temporaryMarkerPath = NodePath.join(paths.dbDir, `.${DATABASE_MARKER}.${NodeCrypto.randomUUID()}`);
  const contents = `${MARKER_HEADER}seed-filter-version=${seedVersion}\n`;
  try {
    NodeFS.writeFileSync(temporaryMarkerPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    NodeFS.renameSync(temporaryMarkerPath, markerPath);
  } finally {
    NodeFS.rmSync(temporaryMarkerPath, { force: true });
  }
  if (!hasRuntimeDatabaseMarker(repoRoot)) throw new Error("The local database marker is invalid.");
  return paths.dbPath;
}

/** Returns whether the launchers created the local database. */
export function hasRuntimeDatabaseMarker(repoRoot) {
  return readRuntimeDatabaseSeedVersion(repoRoot) !== null;
}

/**
 * Returns the filter version that seeded the local database, 0 for the unfiltered legacy marker,
 * or null when the database is missing, unmarked, or the marker is not ours.
 */
export function readRuntimeDatabaseSeedVersion(repoRoot) {
  try {
    assertRuntimeRootSafe(repoRoot);
  } catch {
    return null;
  }
  const { dbDir, dbPath } = getRuntimePaths(repoRoot);
  const markerPath = NodePath.join(dbDir, DATABASE_MARKER);
  try {
    assertRuntimeDirectorySafe(dbDir, "database directory");
    assertRuntimeFileSafe(dbPath, "database");
    assertRuntimeFileSafe(markerPath, "database marker");
    const contents = NodeFS.readFileSync(markerPath, "utf8");
    if (contents === MARKER_HEADER) return UNFILTERED_SEED_VERSION;
    const match = MARKER_PATTERN.exec(contents);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
