#!/usr/bin/env node
/**
 * Cross-platform verification orchestrator: typecheck + lint + unit tests
 * spawned as concurrent child processes. Per-phase stdout/stderr is buffered
 * and printed sequentially after every phase resolves, so the combined log
 * stays readable instead of interleaving three streams of output.
 *
 * Skips verification entirely when no code changes are detected
 * (brainstorming-only sessions).
 *
 * External interface: exit 0 when every phase passes (or when there are no
 * code changes to verify); exit non-zero when any phase fails. The Codex
 * (`scripts/agent/hooks/codex-stop.mjs`) and Cursor
 * (`scripts/agent/hooks/cursor-stop.mjs`) wrappers depend on this contract.
 */
import { execSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const isWindows = process.platform === "win32";

/**
 * Detects whether the current branch has code-relevant changes.
 *
 * Checks (in order): uncommitted diff against HEAD, untracked files, and
 * committed changes against the merge-base with `main`. Returns true on any
 * git error so verification still runs in unusual states (detached HEAD,
 * shallow clone, missing main branch).
 *
 * @returns {boolean} True if any code file differs from the baseline.
 */
export function hasCodeChanges() {
  const codeGlob = '"*.ts" "*.tsx" "*.js" "*.jsx" "*.mts" "*.cts" "*.mjs" "*.cjs"';

  try {
    execSync(`git diff --quiet HEAD -- ${codeGlob}`, { stdio: "ignore" });
  } catch {
    return true;
  }

  try {
    const untracked = execSync(
      `git ls-files --others --exclude-standard -- ${codeGlob}`,
      { encoding: "utf-8" },
    ).trim();
    if (untracked.length > 0) return true;
  } catch {
    return true;
  }

  try {
    const mergeBase = execSync("git merge-base HEAD main", {
      encoding: "utf-8",
    }).trim();
    const diff = execSync(
      `git diff --name-only ${mergeBase} HEAD -- ${codeGlob}`,
      { encoding: "utf-8" },
    ).trim();
    if (diff.length > 0) return true;
  } catch {
    return true;
  }

  return false;
}

/**
 * @typedef {Object} PhaseSpec
 * @property {string}   name     Human-readable phase label (e.g. "Typecheck").
 * @property {string}   command  Executable to spawn (e.g. "bun").
 * @property {string[]} [args]   Arguments passed to the command.
 * @property {string}   [cwd]    Working directory. Defaults to process.cwd().
 * @property {NodeJS.ProcessEnv} [env] Environment overrides. Defaults to process.env.
 * @property {boolean}  [shell]  Spawn through a shell. Defaults to true on
 *                               Windows so bare names like "bun" resolve via
 *                               PATH and `.cmd` shims; false on POSIX.
 */

/**
 * @typedef {Object} PhaseResult
 * @property {string} name        The phase label.
 * @property {number} code        Exit code (0 = success). Spawn errors yield 1.
 * @property {string} output      Merged stdout + stderr captured during the run.
 * @property {number} durationMs  Wall-clock duration in milliseconds.
 */

/**
 * Spawns a single verification phase and buffers its combined output.
 *
 * Always resolves (never rejects) so `Promise.all` over a set of phases
 * waits for every phase to complete even when one fails. A spawn error
 * is folded into the resolved value with code 1 and an explanatory line
 * appended to `output`.
 *
 * @param {PhaseSpec} spec
 * @returns {Promise<PhaseResult>}
 */
export function runPhase({
  name,
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  shell = isWindows,
}) {
  return new Promise((resolve) => {
    const start = Date.now();
    // `shell: true` on Windows is the default so bare names like "bun"
    // resolve through PATH and `.cmd` shims work. Callers that already
    // pass an absolute executable path (e.g. tests using process.execPath)
    // can opt out via `shell: false` to skip shell-quoting pitfalls.
    const child = spawn(command, args, { cwd, env, shell });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d.toString();
    });
    child.stderr.on("data", (d) => {
      output += d.toString();
    });
    child.on("error", (err) => {
      output += `\n[spawn error] ${err.message}\n`;
      resolve({ name, code: 1, output, durationMs: Date.now() - start });
    });
    child.on("close", (code) => {
      resolve({ name, code: code ?? 1, output, durationMs: Date.now() - start });
    });
  });
}

/**
 * Runs the supplied phases concurrently, then prints each phase's buffered
 * output in the order the phases were given (not the order they finished).
 *
 * Aggregation rule: returns the exit code of the first failing phase, or 0
 * if every phase succeeded. A failure in one phase does not cancel the
 * others; every phase runs to completion before this resolves.
 *
 * @param {PhaseSpec[]} phases
 * @param {{ printer?: (line: string) => void }} [options]
 * @returns {Promise<{ code: number, results: PhaseResult[] }>}
 */
export async function runPhasesInParallel(phases, { printer = console.log } = {}) {
  const results = await Promise.all(phases.map((phase) => runPhase(phase)));

  let aggregateCode = 0;
  for (const result of results) {
    const status = result.code === 0 ? "PASS" : "FAIL";
    const secs = (result.durationMs / 1000).toFixed(1);
    printer(`\n=== ${result.name} [${status}] (${secs}s) ===`);
    const trimmed = result.output.replace(/\s+$/g, "");
    if (trimmed.length > 0) printer(trimmed);
    if (result.code !== 0 && aggregateCode === 0) {
      aggregateCode = result.code;
    }
  }

  return { code: aggregateCode, results };
}

/** Default phases executed by `bun run verify`. */
export const DEFAULT_PHASES = [
  { name: "Typecheck", command: "bun", args: ["run", "typecheck"] },
  { name: "Lint", command: "bun", args: ["run", "lint"] },
  { name: "Unit Tests", command: "bun", args: ["run", "test"] },
];

/**
 * Entry point. Gates on `hasCodeChanges`, then orchestrates the default
 * phases and exits with the aggregate code.
 */
async function main() {
  if (!hasCodeChanges()) {
    console.log("=== No code changes detected, skipping verification ===");
    process.exit(0);
  }

  console.log("=== Running typecheck, lint, unit tests in parallel ===");
  const startedAt = Date.now();
  const { code } = await runPhasesInParallel(DEFAULT_PHASES);
  const totalSecs = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (code === 0) {
    console.log(`\n=== All checks passed in ${totalSecs}s ===`);
  } else {
    console.log(`\n=== Verification failed in ${totalSecs}s ===`);
  }
  process.exit(code);
}

// Run main only when invoked directly. The module is also imported by tests
// in `scripts/agent/__tests__/`, which exercise the exported helpers without
// triggering the full pipeline.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
