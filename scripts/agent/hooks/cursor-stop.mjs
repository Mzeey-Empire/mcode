#!/usr/bin/env node
/**
 * Cursor Stop hook wrapper.
 * Runs verify-fast.mjs (typecheck + lint only, the fast gate) and translates
 * the result for Cursor: exit 0 = allow, exit 2 = block. The full gate
 * (typecheck + lint + tests) runs at `bun run verify` time, not on every
 * stop. See docs/guides/agent-workflow.md for the two-tier model.
 */
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const verifyScript = resolve(__dirname, "..", "verify-fast.mjs");

try {
  execSync(`node "${verifyScript}"`, { stdio: "inherit" });
  process.exit(0);
} catch (err) {
  console.error("BLOCK: verify-fast failed. Fix the errors before finishing.");
  process.exit(2);
}
