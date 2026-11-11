import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { Database } from "bun:sqlite";
import { buildFilteredCopy } from "../../db-seed.mjs";
import { buildStoppedFamilies } from "../../db-seed-filter.mjs";

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const count = (db, sql) => db.query(sql).get().n;

/** Derive lossless filter caps using the seed filter's stopped-family rules. */
export function donorCaps(db) {
  const familiesPerWorkspace = new Map();
  for (const family of buildStoppedFamilies(db)) {
    familiesPerWorkspace.set(family.workspaceId, (familiesPerWorkspace.get(family.workspaceId) ?? 0) + 1);
  }
  return {
    maxWorkspaces: Math.max(1, count(db, "SELECT COUNT(*) AS n FROM workspaces")),
    maxFamiliesPerWorkspace: Math.max(1, ...familiesPerWorkspace.values()),
  };
}

/** Numeric statistics only; donor connections are always read-only. */
export function databaseStats(path) {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    return {
      tables: Object.fromEntries(tables.map(({ name }) => [name, count(db, `SELECT COUNT(*) AS n FROM ${quote(name)}`)])),
      worktreeThreads: count(db, "SELECT COUNT(*) AS n FROM threads WHERE worktree_path IS NOT NULL"),
      openOrDraftPrThreads: count(db, "SELECT COUNT(*) AS n FROM threads WHERE pr_status IN ('open', 'draft')"),
      fileBytes: NodeFS.statSync(path).size,
      freelistCount: db.query("PRAGMA freelist_count").get().freelist_count,
    };
  } finally {
    db.close(true);
  }
}

/** Repoint the retained schema's filesystem bindings, leaving history text untouched. */
export function repointFixture(db, runRoot, fixtureRepo) {
  const workspaces = db.query("SELECT id FROM workspaces ORDER BY id").all();
  for (const [index, workspace] of workspaces.entries()) {
    const destination = NodePath.join(runRoot, `workspace-${index}`);
    NodeChildProcess.execFileSync("git", ["clone", "--no-hardlinks", "--quiet", "--", fixtureRepo, destination], {
      stdio: "pipe",
    });
    db.run("UPDATE workspaces SET path = ?, icon_path = NULL WHERE id = ?", [destination, workspace.id]);
  }
  db.run("UPDATE threads SET worktree_path = NULL");
  db.run("UPDATE provider_catalog_snapshots SET cwd = NULL");
  db.run("UPDATE tool_call_records SET output_artifact_path = NULL");
}

/** Build a private fixture directly, never publishing into the developer database. */
export function buildFixture(source, target, runRoot, fixtureRepo) {
  if (!NodeFS.existsSync(NodePath.join(fixtureRepo, ".git"))) {
    throw new Error("Fixture repo missing; run bun run agent:setup");
  }
  const donor = new Database(source, { readonly: true });
  let caps;
  try {
    caps = donorCaps(donor);
  } finally {
    donor.close(true);
  }
  buildFilteredCopy(source, target, caps);
  const db = new Database(target);
  try {
    repointFixture(db, runRoot, fixtureRepo);
    db.run("VACUUM");
  } finally {
    db.close(true);
  }
  return caps;
}
