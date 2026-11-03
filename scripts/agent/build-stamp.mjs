#!/usr/bin/env bun
/**
 * Records the source content that agent:setup built the runtime bundles from, so agent:ready can
 * name the files that changed since and the running server and desktop no longer reflect.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assertRuntimeFileSafe, getRuntimePaths } from "./runtime-contract.mjs";

/**
 * Git pathspecs for the sources compiled into the server and desktop bundles. The web app is left
 * out because Vite serves it from the working tree, so it never goes stale.
 */
const BUNDLE_INPUTS = [
  "apps/server",
  "apps/desktop/src",
  "apps/desktop/scripts",
  "packages",
  "scripts/build-server-dev-bundle.mjs",
  "bun.lock",
  ":(exclude)packages/oxlint-plugin",
  ":(exclude,glob)**/__tests__/**",
  ":(exclude,glob)**/*.test.*",
];

const STAMP_VERSION = 1;
const LISTED_CHANGES = 5;

/**
 * @typedef {{ head: string | null, files: Record<string, string> }} BuildInputs
 * @typedef {{ status: "missing" }
 *   | { status: "current", head: string | null, builtAt: string }
 *   | { status: "stale", head: string | null, builtAt: string, changed: string[] }} BuildStampCheck
 */

/**
 * Hashes the working-tree content of every bundle input, tracked or not. Content hashes, rather
 * than the commit, keep a stamp current when built edits are committed unchanged.
 *
 * @param {string} repoRoot
 * @returns {BuildInputs}
 */
export function captureBuildInputs(repoRoot) {
  const listed = git(repoRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...BUNDLE_INPUTS]);
  const paths = [...new Set(listed.split("\0"))]
    .filter((path) => path !== "" && NodeFS.existsSync(NodePath.join(repoRoot, path)));
  const hashes = paths.length === 0 ? [] : git(repoRoot, ["hash-object", "--stdin-paths"], paths.join("\n")).trim().split("\n");
  if (hashes.length !== paths.length) {
    throw new Error(`git hashed ${hashes.length} of ${paths.length} bundle inputs.`);
  }
  const head = git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"], undefined, { allowFailure: true }).trim();
  return { head: head || null, files: Object.fromEntries(paths.map((path, index) => [path, hashes[index]])) };
}

/**
 * Deletes the stamp before a rebuild, so a build that fails partway leaves no stamp to vouch for it.
 *
 * @param {string} repoRoot
 */
export function clearBuildStamp(repoRoot) {
  const { buildStampFile } = getRuntimePaths(repoRoot);
  assertRuntimeFileSafe(buildStampFile, "build stamp", true);
  NodeFS.rmSync(buildStampFile, { force: true });
}

/**
 * Records the inputs captured before a successful build.
 *
 * @param {string} repoRoot
 * @param {BuildInputs} inputs
 */
export function writeBuildStamp(repoRoot, inputs) {
  const { devDir, buildStampFile } = getRuntimePaths(repoRoot);
  assertRuntimeFileSafe(buildStampFile, "build stamp", true);
  NodeFS.mkdirSync(devDir, { recursive: true });
  const stamp = { version: STAMP_VERSION, head: inputs.head, builtAt: new Date().toISOString(), files: inputs.files };
  NodeFS.writeFileSync(buildStampFile, `${JSON.stringify(stamp)}\n`);
}

/**
 * Compares the current bundle inputs with the stamp agent:setup wrote.
 *
 * @param {string} repoRoot
 * @returns {BuildStampCheck}
 */
export function checkBuildStamp(repoRoot) {
  const stamp = readBuildStamp(repoRoot);
  if (!stamp) return { status: "missing" };
  const { files } = captureBuildInputs(repoRoot);
  const paths = new Set([...Object.keys(stamp.files), ...Object.keys(files)]);
  const changed = [...paths].filter((path) => stamp.files[path] !== files[path]).sort();
  const builtFrom = { head: stamp.head, builtAt: stamp.builtAt };
  return changed.length === 0 ? { status: "current", ...builtFrom } : { status: "stale", ...builtFrom, changed };
}

/**
 * Explains a missing or stale stamp, or returns null when the bundles match the source.
 *
 * @param {BuildStampCheck} check
 * @returns {string | null}
 */
export function describeBuildStamp(check) {
  const rebuild = "To rebuild them, run agent:down, agent:setup, then agent:up.";
  if (check.status === "current") return null;
  if (check.status === "missing") {
    return `Warning: no readable build stamp, so the server and desktop bundles may not match the source. ${rebuild}\n`;
  }
  const from = check.head ? `${check.head.slice(0, 9)}, ` : "";
  const listed = check.changed.slice(0, LISTED_CHANGES).map((path) => `  ${path}\n`).join("");
  const more = check.changed.length > LISTED_CHANGES ? `  and ${check.changed.length - LISTED_CHANGES} more\n` : "";
  const files = check.changed.length === 1 ? "1 source file" : `${check.changed.length} source files`;
  return `Warning: the server and desktop bundles are stale. ${files} changed since `
    + `agent:setup built them (${from}${check.builtAt}):\n${listed}${more}${rebuild}\n`;
}

function readBuildStamp(repoRoot) {
  const { buildStampFile } = getRuntimePaths(repoRoot);
  assertRuntimeFileSafe(buildStampFile, "build stamp", true);
  if (!NodeFS.existsSync(buildStampFile)) return null;
  try {
    const stamp = JSON.parse(NodeFS.readFileSync(buildStampFile, "utf8"));
    return stamp?.version === STAMP_VERSION && stamp.files && typeof stamp.files === "object" ? stamp : null;
  } catch {
    // An unreadable stamp vouches for nothing, the same as a missing one.
    return null;
  }
}

function git(repoRoot, args, input, { allowFailure = false } = {}) {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
