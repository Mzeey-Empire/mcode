#!/usr/bin/env bun
/**
 * Reruns named test files or folders in the workspaces that own them, with short output.
 *
 * Usage: bun run test:files <path> [<path> ...]
 *
 * Paths are repository-relative or absolute. Vitest treats an empty file list as "run everything", so a list built by
 * a shell pipeline that failed would silently run a whole suite; this script refuses an empty list and any path that
 * does not exist before Vitest starts.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { readWorkspaces, workspaceOf } from "./check-changed.mjs";

const USAGE = "Usage: bun run test:files <path> [<path> ...]";
const VITEST_FLAGS = ["--reporter=dot", "--silent=passed-only"];
// Only a script that ends in the Vitest CLI receives appended paths; packages/oxlint-plugin starts Vitest from inline
// code that ignores them, so a named file there would run nothing or everything.
const TAKES_FILE_ARGUMENTS = /\bvitest(?:\.mjs)?\s+run\s*$/;

/**
 * One Vitest run per workspace that owns a requested path, in first-mention order. Throws before any run when the list
 * is empty, or a path is missing or outside every workspace whose test script takes file arguments.
 */
export function planTestRuns({ paths, root, workspaces, exists }) {
  // A quoted "$files" from a failed pipeline arrives as one empty argument.
  const given = paths.filter((path) => path.trim() !== "");
  if (given.length === 0) {
    throw new Error(`No test files given, so nothing ran. An empty list would run the whole suite. ${USAGE}`);
  }
  const runs = new Map();
  for (const path of given) {
    const absolute = NodePath.resolve(root, path);
    const relative = NodePath.relative(root, absolute).split(NodePath.sep).join("/");
    if (!exists(absolute)) throw new Error(`No such file or folder: ${path}. Nothing ran.`);
    const workspace = workspaceOf(relative, workspaces);
    if (!workspace?.scripts.test) throw new Error(`${path} is not inside a workspace with a test script. Nothing ran.`);
    if (!TAKES_FILE_ARGUMENTS.test(workspace.scripts.test)) {
      throw new Error(`${workspace.dir}'s test script cannot run named files; run its whole suite with bun run --cwd ${workspace.dir} test. Nothing ran.`);
    }
    const run = runs.get(workspace.dir) ?? { cwd: workspace.dir, files: [] };
    run.files.push(relative.slice(workspace.dir.length + 1));
    runs.set(workspace.dir, run);
  }
  return [...runs.values()].map((run) => ({ ...run, args: ["run", "test", "--", ...VITEST_FLAGS, ...run.files] }));
}

function main() {
  const root = process.cwd();
  let runs;
  try {
    runs = planTestRuns({ paths: process.argv.slice(2), root, workspaces: readWorkspaces(root), exists: NodeFS.existsSync });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  let failed = false;
  for (const run of runs) {
    console.log(`\n== ${run.cwd}: ${run.files.join(" ")}`);
    const result = NodeChildProcess.spawnSync(process.execPath, run.args, { cwd: NodePath.join(root, run.cwd), stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) failed = true;
  }
  console.log("\nBefore you commit, run bun run check:changed.");
  process.exitCode = failed ? 1 : 0;
}

const invokedScript = process.argv[1] ? NodePath.resolve(process.argv[1]) : null;
if (invokedScript === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) {
  main();
}
