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

/**
 * What the launchers put in the local database. Copies made by an older filter, and the bare
 * header older launchers wrote next to an unfiltered copy, match neither and must be replaced.
 */
const MARKER_CONTENTS = {
  empty: "agent-runtime-snapshot\nseed=empty\n",
  filtered: `agent-runtime-snapshot\nseed=filtered-v${SEED_FILTER_VERSION}\n`,
};

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

/**
 * Marks the local database as created by the launchers.
 *
 * @param {string} repoRoot
 * @param {"empty" | "filtered"} seed whether it started empty or from a filtered copy of real data
 */
export function markRuntimeDatabase(repoRoot, seed) {
  assertRuntimeRootSafe(repoRoot);
  const paths = getRuntimePaths(repoRoot);
  assertRuntimeDirectorySafe(paths.devDir, "runtime directory");
  assertRuntimeDirectorySafe(paths.dbDir, "database directory");
  assertRuntimeFileSafe(paths.dbPath, "database");
  const markerPath = NodePath.join(paths.dbDir, DATABASE_MARKER);
  assertRuntimeFileSafe(markerPath, "database marker", true);
  const temporaryMarkerPath = NodePath.join(paths.dbDir, `.${DATABASE_MARKER}.${NodeCrypto.randomUUID()}`);
  try {
    NodeFS.writeFileSync(temporaryMarkerPath, MARKER_CONTENTS[seed], { encoding: "utf8", flag: "wx", mode: 0o600 });
    NodeFS.renameSync(temporaryMarkerPath, markerPath);
  } finally {
    NodeFS.rmSync(temporaryMarkerPath, { force: true });
  }
  if (!hasRuntimeDatabaseMarker(repoRoot)) throw new Error("The local database marker is invalid.");
  return paths.dbPath;
}

/** Returns whether the launchers created the local database. */
export function hasRuntimeDatabaseMarker(repoRoot) {
  return readRuntimeDatabaseSeed(repoRoot) !== null;
}

/**
 * Returns how the launchers created the local database, or null when it is missing, unmarked,
 * made by an older seed, or the marker is not ours.
 *
 * @returns {"empty" | "filtered" | null}
 */
export function readRuntimeDatabaseSeed(repoRoot) {
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
    if (contents === MARKER_CONTENTS.empty) return "empty";
    if (contents === MARKER_CONTENTS.filtered) return "filtered";
    return null;
  } catch {
    return null;
  }
}
