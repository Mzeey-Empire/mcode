#!/usr/bin/env node
/**
 * Codex Stop hook wrapper.
 * Runs verify-tests.mjs and returns Codex's expected JSON response:
 * {"decision":"approve"} to continue, {"decision":"block","reason":"..."} to block.
 */
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const verifyScript = resolve(__dirname, "..", "verify-tests.mjs");

try {
  execSync(`node "${verifyScript}"`, { stdio: "pipe" });
  console.log(JSON.stringify({ decision: "approve" }));
} catch (err) {
  const output = (err.stderr || err.stdout || "").toString().slice(-500);
  console.log(JSON.stringify({
    decision: "block",
    reason: `verify-tests failed: ${output.replace(/\n/g, " ").trim()}`,
  }));
}
