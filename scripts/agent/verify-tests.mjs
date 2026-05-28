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
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const isWindows = process.platform === "win32";

// Workspaces that run vitest. Tests are scoped per-workspace because vitest's
// `--related` traces import graphs within a single project, not across the
// monorepo. Order matters only for output readability; iteration uses Set.
const TESTABLE_WORKSPACES = ["apps/web", "apps/server", "packages/contracts", "packages/shared"];

// Edits in these workspaces force a full test run: their exported types and
// runtime modules are imported across the whole repo, so vitest's --related
// graph in a single downstream package cannot prove what is or isn't safe.
const SHARED_WORKSPACES = ["packages/contracts", "packages/shared"];

// Glob applied to every git diff / ls-files call. Mirrors the file types that
// the verify orchestrator considers "code" for change detection.
const CODE_GLOB_ARGS = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.mts",
  "*.cts",
  "*.mjs",
  "*.cjs",
];

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
  const files = getChangedFiles();
  // null = git-error fallback. Treat as "changed" so verification still runs.
  if (files === null) return true;
  return files.length > 0;
}

/**
 * Enumerates code files that differ from the merge-base with `main`, including
 * uncommitted (staged + unstaged + untracked) edits.
 *
 * Returns `null` when git is unavailable or the merge-base cannot be resolved
 * (detached HEAD, shallow clone, missing `main`). Callers MUST treat `null` as
 * a fallback signal (run the full test suite), not as "no changes".
 *
 * Paths are returned relative to the repo root using forward slashes (git's
 * native output), with duplicates removed.
 *
 * @param {{ cwd?: string }} [options]
 * @returns {string[] | null}
 */
export function getChangedFiles({ cwd = process.cwd() } = {}) {
  const seen = new Set();
  const collect = (raw) => {
    if (!raw) return;
    for (const line of raw.split(/\r?\n/)) {
      const f = line.trim();
      if (f.length > 0) seen.add(f);
    }
  };

  // Use execFileSync-like behavior by routing each git invocation through
  // execSync but passing the glob list as separate path args to git itself.
  // `git -- <pathspecs>` accepts shell-style globs without shell interpretation.
  const gitGlob = CODE_GLOB_ARGS.join(" ");

  try {
    collect(
      execSync(`git diff --name-only HEAD -- ${gitGlob}`, {
        cwd,
        encoding: "utf-8",
      }),
    );
  } catch {
    return null;
  }

  try {
    collect(
      execSync(`git ls-files --others --exclude-standard -- ${gitGlob}`, {
        cwd,
        encoding: "utf-8",
      }),
    );
  } catch {
    return null;
  }

  try {
    const mergeBase = execSync("git merge-base HEAD main", {
      cwd,
      encoding: "utf-8",
    }).trim();
    if (mergeBase.length > 0) {
      collect(
        execSync(`git diff --name-only ${mergeBase} HEAD -- ${gitGlob}`, {
          cwd,
          encoding: "utf-8",
        }),
      );
    }
  } catch {
    return null;
  }

  return Array.from(seen);
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

/**
 * Phase that runs every workspace's unit tests via the root `bun run test`
 * (which fans out through turbo). Used as the shared-package fallback and
 * when `--full` is passed.
 */
export const FULL_TEST_PHASE = {
  name: "Unit Tests",
  command: "bun",
  args: ["run", "test"],
};

/** Default phases used when callers don't need scoped test selection. */
export const DEFAULT_PHASES = [
  { name: "Typecheck", command: "bun", args: ["run", "typecheck"] },
  { name: "Lint", command: "bun", args: ["run", "lint"] },
  FULL_TEST_PHASE,
];

/**
 * Plans the unit-test phases for a given set of changed files.
 *
 * Rules (in order):
 *   - `forceFull: true` or a null/missing file list → run the full suite.
 *     (`null` from `getChangedFiles` means git failed; the safe move is to
 *     run everything.)
 *   - Any change inside a shared workspace (`packages/contracts` or
 *     `packages/shared`) → run the full suite. Their exports flow everywhere.
 *   - Otherwise → one `vitest related <file...> --run` phase per testable
 *     workspace that owns at least one changed file. Files in workspaces
 *     without a test runner (`apps/desktop`, `scripts/`, `docs/`, …) are
 *     dropped because nothing in this repo's vitest setup would run them.
 *
 * Returning `[]` means "no tests need to run for this diff" - the typecheck
 * and lint phases still execute.
 *
 * @param {string[] | null} changedFiles Paths relative to repo root, or
 *   `null` to signal a git-error fallback.
 * @param {{ forceFull?: boolean, cwd?: string }} [options]
 * @returns {PhaseSpec[]}
 */
export function selectTestPhases(changedFiles, { forceFull = false, cwd = process.cwd() } = {}) {
  if (forceFull || changedFiles === null) return [FULL_TEST_PHASE];

  // Empty diff -> no test phases. (`hasCodeChanges` gates the orchestrator
  // before this point, so an empty array here means the only changes were
  // non-code files like Markdown.)
  if (changedFiles.length === 0) return [];

  const isShared = changedFiles.some((f) =>
    SHARED_WORKSPACES.some((ws) => f === ws || f.startsWith(ws + "/")),
  );
  if (isShared) return [FULL_TEST_PHASE];

  /** @type {Map<string, string[]>} workspace → files relative to repo root */
  const buckets = new Map();
  for (const file of changedFiles) {
    const ws = TESTABLE_WORKSPACES.find((w) => file === w || file.startsWith(w + "/"));
    if (!ws) continue;
    const list = buckets.get(ws);
    if (list) {
      list.push(file);
    } else {
      buckets.set(ws, [file]);
    }
  }

  /** @type {PhaseSpec[]} */
  const phases = [];
  for (const [ws, files] of buckets) {
    // Strip the workspace prefix so vitest receives paths relative to its cwd.
    const rel = files.map((f) => f.slice(ws.length + 1));
    phases.push({
      name: `Unit Tests (${ws})`,
      command: "bunx",
      // Vitest 4 exposes related-file scoping as a subcommand:
      //   vitest related <files> --run
      // The `--run` flag opts out of the watch mode that `related` defaults
      // to. `bunx` resolves the workspace-local vitest binary, picking up
      // each package's own vitest config (setup files, environment, etc.).
      args: ["vitest", "related", ...rel, "--run"],
      cwd: resolvePath(cwd, ws),
    });
  }
  return phases;
}

/**
 * Builds the parallel phase list for a given diff: typecheck and lint
 * unchanged, tests scoped via `selectTestPhases`.
 *
 * @param {string[] | null} changedFiles
 * @param {{ forceFull?: boolean, cwd?: string }} [options]
 * @returns {PhaseSpec[]}
 */
export function buildPhases(changedFiles, options = {}) {
  return [
    { name: "Typecheck", command: "bun", args: ["run", "typecheck"] },
    { name: "Lint", command: "bun", args: ["run", "lint"] },
    ...selectTestPhases(changedFiles, options),
  ];
}

/**
 * Entry point. Gates on `hasCodeChanges`, then orchestrates the planned
 * phases and exits with the aggregate code.
 *
 * CLI: pass `--full` to force the full test suite even when only a single
 * downstream file changed. `bun run verify` passes this flag so the
 * full-gate semantics survive the changed-file optimization.
 */
async function main() {
  const forceFull = process.argv.includes("--full");
  const changedFiles = getChangedFiles();

  // When git works AND the diff is empty (no code-relevant changes), skip
  // the entire pipeline. Use `getChangedFiles` directly here (instead of
  // `hasCodeChanges`) so we reuse the file list for `buildPhases` below
  // without re-running git.
  if (changedFiles !== null && changedFiles.length === 0) {
    console.log("=== No code changes detected, skipping verification ===");
    process.exit(0);
  }

  const phases = buildPhases(changedFiles, { forceFull });

  const testPhaseCount = phases.length - 2; // minus typecheck + lint
  const scope = forceFull || changedFiles === null
    ? "full suite"
    : testPhaseCount === 1 && phases[2] === FULL_TEST_PHASE
      ? "full suite (shared-package fallback)"
      : `${testPhaseCount} scoped vitest phase(s)`;
  console.log(`=== Running typecheck, lint, ${scope} in parallel ===`);

  const startedAt = Date.now();
  const { code } = await runPhasesInParallel(phases);
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
