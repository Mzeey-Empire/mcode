#!/usr/bin/env node
/**
 * Codex Stop hook wrapper.
 * Runs verify-fast.mjs (typecheck + lint only, the fast gate) and returns
 * Codex's expected JSON response: {"decision":"approve"} to continue,
 * {"decision":"block","reason":"..."} to block. The full gate (typecheck +
 * lint + tests) runs at `bun run verify` time, not on every stop. See
 * docs/guides/agent-workflow.md for the two-tier model.
 */
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const verifyScript = resolve(__dirname, "..", "verify-fast.mjs");

try {
  execSync(`node "${verifyScript}"`, { stdio: "pipe" });
  console.log(JSON.stringify({ decision: "approve" }));
} catch (err) {
  const output = ((err?.stderr ?? err?.stdout) || "").toString().slice(-500);
  console.log(JSON.stringify({
    decision: "block",
    reason: `verify-fast failed: ${output.replace(/\n/g, " ").trim()}`,
  }));
}
