#!/usr/bin/env node
/**
 * Cross-platform E2E test runner.
 * Runs Playwright E2E tests from the apps/web directory.
 */
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const webDir = resolve(repoRoot, "apps/web");

console.log("=== E2E Tests ===");
execSync("bun run e2e", { stdio: "inherit", cwd: webDir });
