/**
 * Tests for the parallel verify orchestrator.
 * Uses Node's built-in test runner (`node:test`) so no extra dev dep is
 * required. Run with `node --test scripts/agent/__tests__/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PHASES,
  FULL_TEST_PHASE,
  getChangedFiles,
  hasCodeChanges,
  runPhase,
  runPhasesInParallel,
  selectTestPhases,
} from "../verify-tests.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, "..", "verify-tests.mjs");

// Node binary used to spawn deterministic, cross-platform test phases.
const NODE = process.execPath;

/**
 * Build a phase that runs a snippet of JS through `node -e`. Always passes
 * `shell: false` so Windows cmd.exe quoting does not garble the snippet —
 * the absolute node path means no shell wrapping is needed.
 */
function nodePhase(name, code) {
  return { name, command: NODE, args: ["-e", code], shell: false };
}

test("runPhase resolves with code 0 and captured stdout for a successful command", async () => {
  const result = await runPhase(nodePhase("echo", "console.log('hello-stdout')"));

  assert.equal(result.name, "echo");
  assert.equal(result.code, 0);
  assert.match(result.output, /hello-stdout/);
  assert.ok(result.durationMs >= 0);
});

test("runPhase preserves the child's non-zero exit code", async () => {
  const result = await runPhase(nodePhase("fail", "process.exit(7)"));

  assert.equal(result.code, 7);
});

test("runPhase captures stderr output as part of the buffered phase log", async () => {
  const result = await runPhase(nodePhase("stderr", "console.error('boom')"));

  assert.equal(result.code, 0);
  assert.match(result.output, /boom/);
});

test("runPhase resolves (does not throw) when the command cannot be spawned", async () => {
  const result = await runPhase({
    name: "missing",
    command: "this-binary-does-not-exist-xyz123",
    args: [],
    shell: false,
  });

  assert.notEqual(result.code, 0);
});

test("runPhasesInParallel returns aggregate code 0 when every phase passes", async () => {
  const lines = [];
  const { code, results } = await runPhasesInParallel(
    [
      nodePhase("alpha", "console.log('A')"),
      nodePhase("beta", "console.log('B')"),
      nodePhase("gamma", "console.log('C')"),
    ],
    { printer: (line) => lines.push(line) },
  );

  assert.equal(code, 0);
  assert.equal(results.length, 3);
  for (const r of results) assert.equal(r.code, 0);
});

test("runPhasesInParallel returns the first failing phase's code when any phase fails", async () => {
  const { code, results } = await runPhasesInParallel(
    [
      nodePhase("ok", "console.log('a')"),
      nodePhase("bad", "process.exit(3)"),
      nodePhase("also-bad", "process.exit(5)"),
    ],
    { printer: () => {} },
  );

  assert.equal(code, 3);
  // All phases run even though one (or more) failed.
  assert.equal(results.length, 3);
  assert.equal(results.find((r) => r.name === "ok").code, 0);
  assert.equal(results.find((r) => r.name === "bad").code, 3);
  assert.equal(results.find((r) => r.name === "also-bad").code, 5);
});

test("runPhasesInParallel prints buffered output in declared order, not finish order", async () => {
  const lines = [];
  // Phase A is intentionally slower than phase B. Output for A must still
  // print before B's output because A is listed first.
  await runPhasesInParallel(
    [
      nodePhase("A_slow", "setTimeout(function(){console.log('AAA')},150)"),
      nodePhase("B_fast", "console.log('BBB')"),
    ],
    { printer: (line) => lines.push(line) },
  );

  const combined = lines.join("\n");
  const idxA = combined.indexOf("AAA");
  const idxB = combined.indexOf("BBB");
  assert.ok(idxA >= 0, "expected A output in printed lines");
  assert.ok(idxB >= 0, "expected B output in printed lines");
  assert.ok(idxA < idxB, `A output should print before B output (got A@${idxA}, B@${idxB})`);
});

test("runPhasesInParallel actually runs phases concurrently (wall time ≈ max, not sum)", async () => {
  const sleepMs = 400;
  const start = Date.now();
  const sleepCode = `setTimeout(function(){},${sleepMs})`;
  await runPhasesInParallel(
    [
      nodePhase("s1", sleepCode),
      nodePhase("s2", sleepCode),
      nodePhase("s3", sleepCode),
    ],
    { printer: () => {} },
  );
  const elapsed = Date.now() - start;

  // Sequential would be ~3 * sleepMs = 1200ms. Concurrent should be well
  // under 2x sleep even on slow CI. Generous bound to avoid flakiness.
  assert.ok(
    elapsed < sleepMs * 2.5,
    `expected concurrent execution (~${sleepMs}ms), got ${elapsed}ms`,
  );
});

test("DEFAULT_PHASES wires the three required phases for `bun run verify`", () => {
  const names = DEFAULT_PHASES.map((p) => p.name);
  assert.deepEqual(names, ["Typecheck", "Lint", "Unit Tests"]);
  for (const phase of DEFAULT_PHASES) {
    assert.equal(phase.command, "bun");
    assert.equal(phase.args[0], "run");
  }
});

test("hasCodeChanges is exported and returns a boolean for the current repo", () => {
  const result = hasCodeChanges();
  assert.equal(typeof result, "boolean");
});

test("script exits 0 with skip message when run in a clean repo with no code changes", async () => {
  const tmp = mkdtempSync(resolve(tmpdir(), "verify-orchestrator-"));
  try {
    const gitOpts = { cwd: tmp, stdio: "ignore" };
    execSync("git init -q -b main", gitOpts);
    execSync('git config user.email "t@t"', gitOpts);
    execSync('git config user.name "t"', gitOpts);
    execSync("git config commit.gpgsign false", gitOpts);
    writeFileSync(resolve(tmp, "README.md"), "ok\n");
    execSync("git add README.md", gitOpts);
    execSync('git commit -q -m "init"', gitOpts);

    const { code, stdout } = await runScript(SCRIPT_PATH, tmp);

    assert.equal(code, 0, `expected exit 0, got ${code}. output:\n${stdout}`);
    assert.match(
      stdout,
      /skipping verification/i,
      "expected early-exit bypass to log a skip message",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("selectTestPhases falls back to the full suite when a packages/contracts file changed", () => {
  const phases = selectTestPhases(["packages/contracts/src/index.ts"]);

  assert.equal(phases.length, 1);
  assert.equal(phases[0].name, FULL_TEST_PHASE.name);
  assert.deepEqual(phases[0].args, FULL_TEST_PHASE.args);
});

test("selectTestPhases falls back to the full suite when a packages/shared file changed", () => {
  const phases = selectTestPhases([
    "apps/web/src/foo.ts",
    "packages/shared/src/model-effort/index.ts",
  ]);

  assert.equal(phases.length, 1);
  assert.equal(phases[0].name, FULL_TEST_PHASE.name);
});

test("selectTestPhases scopes a single apps/web change to that workspace's vitest related run", () => {
  const phases = selectTestPhases(["apps/web/src/components/foo.tsx"]);

  assert.equal(phases.length, 1);
  const [phase] = phases;
  assert.match(phase.name, /apps\/web/);
  assert.equal(phase.cwd.endsWith("apps/web") || phase.cwd.endsWith("apps\\web"), true);
  // Vitest 4: `vitest related <files> --run`. `--run` opts out of watch mode.
  assert.equal(phase.command, "bunx");
  assert.equal(phase.args[0], "vitest");
  assert.equal(phase.args[1], "related");
  assert.ok(phase.args.includes("--run"), `expected --run in args, got ${phase.args.join(" ")}`);
  // The changed file is forwarded (path is relative to the package root).
  assert.ok(
    phase.args.some((a) => a.endsWith("foo.tsx")),
    `expected the changed file in args, got ${phase.args.join(" ")}`,
  );
});

test("selectTestPhases buckets multi-workspace changes into one phase per workspace", () => {
  const phases = selectTestPhases([
    "apps/web/src/a.ts",
    "apps/web/src/b.ts",
    "apps/server/src/c.ts",
  ]);

  assert.equal(phases.length, 2);
  const names = phases.map((p) => p.name);
  assert.ok(names.some((n) => n.includes("apps/web")));
  assert.ok(names.some((n) => n.includes("apps/server")));
  // The apps/web phase carries both of its changed files as positional args
  // to `vitest related`, with `--run` somewhere in the same arg list.
  const web = phases.find((p) => p.name.includes("apps/web"));
  // Files are everything between `related` and `--run`.
  const startIdx = web.args.indexOf("related") + 1;
  const endIdx = web.args.indexOf("--run");
  const related = web.args.slice(startIdx, endIdx);
  assert.equal(related.length, 2);
  assert.ok(related.some((a) => a.endsWith("a.ts")));
  assert.ok(related.some((a) => a.endsWith("b.ts")));
});

test("selectTestPhases returns no phases when changes only touch workspaces without tests (e.g., scripts/)", () => {
  const phases = selectTestPhases(["scripts/agent/foo.mjs", "docs/guides/x.md"]);
  assert.deepEqual(phases, []);
});

test("selectTestPhases returns the full suite when changedFiles is null (git-error fallback)", () => {
  const phases = selectTestPhases(null);
  assert.equal(phases.length, 1);
  assert.equal(phases[0].name, FULL_TEST_PHASE.name);
});

test("getChangedFiles returns null OR an array of paths from the current repo", () => {
  const result = getChangedFiles();
  assert.ok(result === null || Array.isArray(result));
  if (Array.isArray(result)) {
    for (const f of result) assert.equal(typeof f, "string");
  }
});

test("getChangedFiles reports a code file edited in a fresh git repo", () => {
  const tmp = mkdtempSync(resolve(tmpdir(), "verify-getchanged-"));
  try {
    const gitOpts = { cwd: tmp, stdio: "ignore" };
    execSync("git init -q -b main", gitOpts);
    execSync('git config user.email "t@t"', gitOpts);
    execSync('git config user.name "t"', gitOpts);
    execSync("git config commit.gpgsign false", gitOpts);
    writeFileSync(resolve(tmp, "README.md"), "ok\n");
    execSync("git add README.md", gitOpts);
    execSync('git commit -q -m "init"', gitOpts);
    // Add an uncommitted code file to be detected by `getChangedFiles`.
    writeFileSync(resolve(tmp, "edited.ts"), "export const a = 1;\n");
    execSync("git add edited.ts", gitOpts);

    const files = getChangedFiles({ cwd: tmp });
    assert.ok(Array.isArray(files), "expected array, got " + files);
    assert.ok(files.includes("edited.ts"), `expected "edited.ts" in ${files.join(",")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--full flag forces the full test suite regardless of changed files", async () => {
  // Drive the script with a tiny fixture where only apps/web/src/foo.ts was
  // edited. Without --full, that would scope to apps/web vitest --related;
  // with --full, the orchestrator runs `bun run test` directly.
  // We exercise this indirectly: the exported planner should honor a
  // `forceFull` option even when scoping is possible.
  const phases = selectTestPhases(["apps/web/src/foo.ts"], { forceFull: true });
  assert.equal(phases.length, 1);
  assert.equal(phases[0].name, FULL_TEST_PHASE.name);
});

/**
 * Spawns the verify script in a given directory and resolves with its
 * combined output and exit code.
 *
 * @param {string} scriptPath
 * @param {string} cwd
 * @returns {Promise<{ code: number, stdout: string, signal: NodeJS.Signals | null }>}
 */
function runScript(scriptPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      env: { ...process.env },
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stdout += d.toString();
    });
    child.on("error", reject);
    // Signal-terminated runs report `code === null`. Treat them as failure
    // (exit 1) so abnormal termination is never silently treated as success;
    // expose the signal so callers can disambiguate if needed.
    child.on("close", (code, signal) =>
      resolve({ code: code === null ? 1 : code, stdout, signal }),
    );
  });
}
