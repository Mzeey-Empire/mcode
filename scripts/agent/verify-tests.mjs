#!/usr/bin/env node
/**
 * Cross-platform verification script: typecheck + lint + unit tests.
 * Skips verification when no code changes are detected (brainstorming-only sessions).
 */
import { execSync } from "node:child_process";

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: "inherit", ...opts });
}

/** Returns true when the branch has code changes (committed or uncommitted). */
function hasCodeChanges() {
  const codeGlob = '"*.ts" "*.tsx" "*.js" "*.jsx" "*.mts" "*.cts" "*.mjs" "*.cjs"';

  // Check uncommitted changes (staged + unstaged)
  try {
    execSync(`git diff --quiet HEAD -- ${codeGlob}`, { stdio: "ignore" });
  } catch {
    return true;
  }

  // Check untracked files
  try {
    const untracked = execSync(
      `git ls-files --others --exclude-standard -- ${codeGlob}`,
      { encoding: "utf-8" },
    ).trim();
    if (untracked.length > 0) return true;
  } catch {
    return true;
  }

  // Check committed changes on this branch vs main
  try {
    const mergeBase = execSync("git merge-base HEAD main", {
      encoding: "utf-8",
    }).trim();
    const diff = execSync(
      `git diff --name-only ${mergeBase} HEAD -- ${codeGlob}`,
      { encoding: "utf-8" },
    ).trim();
    if (diff.length > 0) return true;
  } catch {
    // Not on a branch or no main; run verification to be safe
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
