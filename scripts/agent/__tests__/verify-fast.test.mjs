/**
 * Tests for the fast-gate verify orchestrator.
 *
 * The fast gate runs only typecheck + lint (no tests) and is what the agent
 * stop hooks invoke on every turn. The full gate (verify-tests.mjs) still
 * runs at `bun run verify` time. These tests verify the fast gate's
 * external contract: the phase set, exit-code aggregation, and the shared
 * `hasCodeChanges()` early-exit bypass.
 *
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
  FAST_PHASES,
  runPhasesInParallel,
} from "../verify-fast.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, "..", "verify-fast.mjs");

const NODE = process.execPath;

/**
 * Build a phase that runs a snippet of JS through `node -e`. `shell: false`
 * keeps Windows cmd.exe quoting from garbling the snippet.
 */
function nodePhase(name, code) {
  return { name, command: NODE, args: ["-e", code], shell: false };
}

test("FAST_PHASES wires only typecheck and lint (no tests)", () => {
  const names = FAST_PHASES.map((p) => p.name);
  assert.deepEqual(names, ["Typecheck", "Lint"]);
  for (const phase of FAST_PHASES) {
    assert.equal(phase.command, "bun");
    assert.equal(phase.args[0], "run");
  }
  // Explicitly assert the test phase is absent: this is the defining
  // difference between the fast gate and the full gate.
  const hasTestPhase = FAST_PHASES.some((p) =>
    p.args.some((arg) => arg === "test" || arg === "tests"),
  );
  assert.equal(hasTestPhase, false, "fast gate must not include a test phase");
});

test("FAST_PHASES is a strict subset of the full gate phase set", async () => {
  const { DEFAULT_PHASES } = await import("../verify-tests.mjs");
  const fastNames = new Set(FAST_PHASES.map((p) => p.name));
  const fullNames = new Set(DEFAULT_PHASES.map((p) => p.name));
  for (const name of fastNames) {
    assert.ok(
      fullNames.has(name),
      `fast phase ${name} should also appear in DEFAULT_PHASES`,
    );
  }
  assert.ok(
    fullNames.size > fastNames.size,
    "full gate should include strictly more phases than the fast gate",
  );
});

test("runPhasesInParallel exits non-zero when typecheck fails", async () => {
  const { code } = await runPhasesInParallel(
    [
      nodePhase("Typecheck", "process.exit(2)"),
      nodePhase("Lint", "process.exit(0)"),
    ],
    { printer: () => {} },
  );

  assert.notEqual(code, 0, "fast gate must propagate typecheck failure");
});

test("runPhasesInParallel exits non-zero when lint fails", async () => {
  const { code } = await runPhasesInParallel(
    [
      nodePhase("Typecheck", "process.exit(0)"),
      nodePhase("Lint", "process.exit(4)"),
    ],
    { printer: () => {} },
  );

  assert.notEqual(code, 0, "fast gate must propagate lint failure");
});

test("script exits 0 with skip message when run in a clean repo with no code changes", async () => {
  const tmp = mkdtempSync(resolve(tmpdir(), "verify-fast-"));
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
 * Spawns the verify-fast script in a given directory and resolves with its
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
    child.on("close", (code, signal) =>
      resolve({ code: code === null ? 1 : code, stdout, signal }),
    );
  });
}
