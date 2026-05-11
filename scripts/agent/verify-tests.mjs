#!/usr/bin/env node
/**
 * Cross-platform verification script: typecheck + lint + unit tests.
 * Skips verification when no code changes are detected (brainstorming-only sessions).
 */
import { execSync } from "node:child_process";

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: "inherit", ...opts });
}

/** Returns true when there are uncommitted code changes. */
function hasCodeChanges() {
  try {
    // Check unstaged + staged changes
    execSync('git diff --quiet HEAD -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.mts" "*.cts" "*.mjs" "*.cjs"', { stdio: "ignore" });
  } catch {
    return true; // non-zero exit = changes exist
  }
  try {
    // Check untracked files
    const untracked = execSync(
      'git ls-files --others --exclude-standard -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.mts" "*.cts" "*.mjs" "*.cjs"',
      { encoding: "utf-8" },
    ).trim();
    if (untracked.length > 0) return true;
  } catch {
    // git not available or not a repo; run verification to be safe
    return true;
  }
  return false;
}

if (!hasCodeChanges()) {
  console.log("=== No code changes detected, skipping verification ===");
  process.exit(0);
}

console.log("=== Typecheck ===");
run("bun run typecheck");

console.log("=== Lint ===");
run("bun run lint");

console.log("=== Unit Tests ===");
run("bun run test");

console.log("\n=== All checks passed ===");
