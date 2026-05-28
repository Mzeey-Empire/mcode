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
  hasCodeChanges,
  runPhase,
  runPhasesInParallel,
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
