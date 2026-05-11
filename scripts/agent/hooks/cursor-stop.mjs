#!/usr/bin/env node
/**
 * Cursor Stop hook wrapper.
 * Runs verify-tests.mjs and translates the result for Cursor:
 * exit 0 = allow, exit 2 = block.
 */
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const verifyScript = resolve(__dirname, "..", "verify-tests.mjs");

try {
  execSync(`node "${verifyScript}"`, { stdio: "inherit" });
  process.exit(0);
} catch (err) {
  console.error("BLOCK: verify-tests failed. Fix the errors before finishing.");
  process.exit(2);
}
