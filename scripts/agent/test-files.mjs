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

/**
 * One Vitest run per workspace that owns a requested path, in first-mention order. Throws before any run when the list
 * is empty or a path is missing or outside every workspace with a test script.
 */
export function planTestRuns({ paths, root, workspaces, exists }) {
  if (paths.length === 0) {
    throw new Error(`No test files given, so nothing ran. An empty list would run the whole suite. ${USAGE}`);
  }
  const runs = new Map();
  for (const path of paths) {
    const absolute = NodePath.resolve(root, path);
    const relative = NodePath.relative(root, absolute).split(NodePath.sep).join("/");
    if (!exists(absolute)) throw new Error(`No such file or folder: ${path}. Nothing ran.`);
    const workspace = workspaceOf(relative, workspaces);
    if (!workspace?.scripts.test) throw new Error(`${path} is not inside a workspace with a test script. Nothing ran.`);
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
  console.log("\nBefore you commit, run bun run check:changed: it also runs the tests these files do not cover.");
  process.exitCode = failed ? 1 : 0;
}

const invokedScript = process.argv[1] ? NodePath.resolve(process.argv[1]) : null;
if (invokedScript === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) {
  main();
}
