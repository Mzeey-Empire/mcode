#!/usr/bin/env bun
/**
 * Provisions the per-worktree agent runtime: local database, fixture repo, and bundles.
 */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { captureBuildInputs, clearBuildStamp, writeBuildStamp } from "./build-stamp.mjs";
import { isFixtureRepo, seedFixtureRepo } from "./fixture-repo.mjs";
import {
  assertRuntimeDirectorySafe,
  assertRuntimeFileSafe,
  assertRuntimeRootSafe,
  getRuntimePaths,
  resolveRepoRoot,
} from "./runtime-contract.mjs";
import { MANAGED_DESKTOP_SESSION_FILE } from "./managed-desktop.mjs";
import { formatGigabytes } from "./agent-worktrees.mjs";
import { rebuildServerDevBundle } from "../build-server-dev-bundle.mjs";
import { ensureRuntimeDatabase } from "../db-seed.mjs";

// Measured on 2026-11-18 in a T3 Code worktree on F:: node_modules held 1.93 GB in 57,094
// files, copied rather than hardlinked because Bun's cache was on another drive. After
// setup and builds, .dev held up to 0.61 GB and apps/desktop/dist up to 0.52 GB.
// 1.93 + 0.61 + 0.52 = 3.06 GB, rounded up.
const DEFAULT_MINIMUM_FREE_GB = 3.1;
// Overrides the limit, for example to prove the failure without filling a disk.
const MINIMUM_FREE_GB_ENV = "MCODE_AGENT_SETUP_MIN_FREE_GB";

let agentSetupTestHooks = {};

/**
 * Installs process-local hooks for focused agentSetup tests.
 *
 * @param {Partial<{
 *   ensureRuntimeDatabase: typeof ensureRuntimeDatabase,
 *   seedFixtureRepo: typeof seedFixtureRepo,
 *   isFixtureRepo: typeof isFixtureRepo,
 *   rebuildServerDevBundle: typeof rebuildServerDevBundle,
 *   buildDesktopMain: typeof buildDesktopMain,
 *   readFreeBytes: typeof readFreeBytes,
 * }>} hooks
 * @returns {() => void}
 */
export function setAgentSetupTestHooks(hooks) {
  agentSetupTestHooks = hooks;
  return () => {
    agentSetupTestHooks = {};
  };
}

/**
 * Runs the one-time provisioning steps for the agent runtime.
 *
 * @param {string} [repoRoot]
 * @returns {Promise<void>}
 */
export async function agentSetup(repoRoot = resolveRepoRoot()) {
  const operations = getSetupOperations();

  assertFreeDiskSpace(repoRoot, operations.readFreeBytes(repoRoot));
  assertRuntimeStopped(repoRoot);
  operations.ensureDatabase({ repoRoot });
  if (!operations.fixtureIsReady(repoRoot)) {
    operations.seedFixture(repoRoot);
  }
  // Capture before building: an edit made during the build then reads as stale, never as current.
  const inputs = captureBuildInputs(repoRoot);
  clearBuildStamp(repoRoot);
  await operations.rebuildBundle({ repoRoot });
  await operations.buildMain(repoRoot);
  writeBuildStamp(repoRoot, inputs);
}

function getSetupOperations() {
  return {
    ensureDatabase: agentSetupTestHooks.ensureRuntimeDatabase ?? ensureRuntimeDatabase,
    seedFixture: agentSetupTestHooks.seedFixtureRepo ?? seedFixtureRepo,
    fixtureIsReady: agentSetupTestHooks.isFixtureRepo ?? isFixtureRepo,
    rebuildBundle: agentSetupTestHooks.rebuildServerDevBundle ?? rebuildServerDevBundle,
    buildMain: agentSetupTestHooks.buildDesktopMain ?? buildDesktopMain,
    readFreeBytes: agentSetupTestHooks.readFreeBytes ?? readFreeBytes,
  };
}

function readFreeBytes(repoRoot) {
  const stats = NodeFS.statfsSync(repoRoot);
  return stats.bavail * stats.bsize;
}

function readMinimumFreeGigabytes() {
  const override = process.env[MINIMUM_FREE_GB_ENV];
  if (override === undefined || override === "") return DEFAULT_MINIMUM_FREE_GB;
  const gigabytes = Number(override);
  if (!Number.isFinite(gigabytes) || gigabytes < 0) {
    throw new Error(`${MINIMUM_FREE_GB_ENV} must be a number of gigabytes, not "${override}".`);
  }
  return gigabytes;
}

/** Fails before setup writes anything when the worktree's drive is nearly full. */
function assertFreeDiskSpace(repoRoot, freeBytes) {
  const minimumGigabytes = readMinimumFreeGigabytes();
  if (freeBytes >= minimumGigabytes * 1024 ** 3) return;
  const drive = NodePath.parse(NodePath.resolve(repoRoot)).root;
  throw new Error(
    `agent:setup needs ${minimumGigabytes} GB free on ${drive}, and only ${formatGigabytes(freeBytes)} is free. `
      + "Run `bun run agent:worktrees` to list worktrees that can be removed.",
  );
}

/** Replaces the local database with an empty one. */
export function refreshRuntimeDatabase(repoRoot, ensureDatabase = ensureRuntimeDatabase) {
  ensureDatabase({ repoRoot, refresh: true });
}

function assertRuntimeStopped(repoRoot) {
  const { devDir, pidsDir } = getRuntimePaths(repoRoot);
  assertRuntimeRootSafe(repoRoot);
  assertRuntimeDirectorySafe(pidsDir, "runtime PID directory", true);
  assertRuntimeFileSafe(NodePath.join(devDir, MANAGED_DESKTOP_SESSION_FILE), "desktop session", true);
  if (NodeFS.existsSync(pidsDir) && NodeFS.readdirSync(pidsDir).some((name) => name.endsWith(".pid"))) {
    throw new Error("Stop the agent runtime before agent:setup refreshes the local database.");
  }
  if (NodeFS.existsSync(NodePath.join(devDir, MANAGED_DESKTOP_SESSION_FILE))) {
    throw new Error("Stop the agent runtime before agent:setup refreshes the local database.");
  }
}

async function buildDesktopMain(repoRoot) {
  await new Promise((resolveBuild, rejectBuild) => {
    NodeChildProcess.execFile(process.execPath, ["scripts/build-main.mjs", "--main-only"], {
      cwd: NodePath.join(repoRoot, "apps", "desktop"),
      env: process.env,
      windowsHide: true,
    }, (error) => error ? rejectBuild(error) : resolveBuild());
  });
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.argv[2] ? NodePath.resolve(process.argv[2]) : resolveRepoRoot();
  await agentSetup(repoRoot);
}
