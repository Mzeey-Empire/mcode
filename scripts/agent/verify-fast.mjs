#!/usr/bin/env node
/**
 * Cross-platform fast-gate verification orchestrator: typecheck + lint only.
 *
 * This is the *fast gate* in the two-tier verification model documented in
 * `docs/guides/agent-workflow.md`. Agent stop hooks (Claude, Cursor, Codex)
 * invoke this on every turn to give type errors and lint violations sub-10s
 * feedback. The full gate (`scripts/agent/verify-tests.mjs`, exposed as
 * `bun run verify`) additionally runs the unit tests and is the canonical
 * pre-commit check.
 *
 * Reuses the parallel phase orchestrator and `hasCodeChanges()` early-exit
 * bypass from `verify-tests.mjs` so the two gates stay behaviorally
 * consistent — the only difference between them is the phase set.
 *
 * External interface: exit 0 when typecheck and lint both pass (or when
 * there are no code changes to verify); exit non-zero when either fails.
 * The Codex (`scripts/agent/hooks/codex-stop.mjs`) and Cursor
 * (`scripts/agent/hooks/cursor-stop.mjs`) wrappers depend on this contract.
 */
import { pathToFileURL } from "node:url";

import {
  hasCodeChanges,
  runPhasesInParallel,
} from "./verify-tests.mjs";

/**
 * Phases executed by the fast gate. Intentionally excludes the unit-test
 * phase — that is the defining difference between this gate and the full
 * gate. See the module docstring for context.
 */
export const FAST_PHASES = [
  { name: "Typecheck", command: "bun", args: ["run", "typecheck"] },
  { name: "Lint", command: "bun", args: ["run", "lint"] },
];

// Re-export `runPhasesInParallel` so callers (including the test suite) can
// import the orchestrator from either module without coupling to the file
// that happens to define it.
export { runPhasesInParallel };

/**
 * Entry point. Gates on `hasCodeChanges`, then orchestrates the fast phases
 * and exits with the aggregate code.
 */
async function main() {
  if (!hasCodeChanges()) {
    console.log("=== No code changes detected, skipping verification ===");
    process.exit(0);
  }

  console.log("=== Running typecheck and lint in parallel (fast gate) ===");
  const startedAt = Date.now();
  const { code } = await runPhasesInParallel(FAST_PHASES);
  const totalSecs = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (code === 0) {
    console.log(`\n=== Fast gate passed in ${totalSecs}s ===`);
  } else {
    console.log(`\n=== Fast gate failed in ${totalSecs}s ===`);
  }
  process.exit(code);
}

// Run main only when invoked directly. The module is also imported by
// tests in `scripts/agent/__tests__/` which exercise the exported phase
// set and the shared orchestrator without triggering the full pipeline.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
