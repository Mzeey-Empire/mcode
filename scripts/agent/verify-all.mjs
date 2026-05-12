#!/usr/bin/env node
/**
 * Cross-platform full verification pipeline.
 * Runs verify-tests.mjs then verify-e2e.mjs.
 */
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

execSync(`node "${resolve(__dirname, "verify-tests.mjs")}"`, { stdio: "inherit" });
execSync(`node "${resolve(__dirname, "verify-e2e.mjs")}"`, { stdio: "inherit" });

console.log("\n=== All verification passed ===");
