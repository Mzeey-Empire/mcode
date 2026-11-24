#!/usr/bin/env bun
/**
 * Stops only the processes recorded for the per-worktree agent runtime.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  assertRuntimeDirectorySafe,
  assertRuntimeFileSafe,
  assertRuntimeRootSafe,
  getRuntimePaths,
  readPortsFile,
  resolveRepoRoot,
} from "./runtime-contract.mjs";
import { parsePidFile, stopPid, stopRecordedPidFile } from "./runtime-processes.mjs";
import { MANAGED_DESKTOP_SESSION_FILE, stopManagedDesktop } from "./managed-desktop.mjs";

/**
 * Stops the agent runtime processes recorded under `.dev/pids`.
 *
 * @param {string} [repoRoot]
 * @param {{ stop?: (pid: number, signal: NodeJS.Signals) => Promise<void> | void }} [options]
 * @returns {Promise<{ complete: boolean, unconfirmed: string[] }>}
 */
export async function agentDown(repoRoot = resolveRepoRoot(), options = {}) {
  assertRuntimeRootSafe(repoRoot);
  const paths = getRuntimePaths(repoRoot);
  assertRuntimeFileSafe(paths.portsFile, "runtime contract", true);
  assertRuntimeDirectorySafe(paths.pidsDir, "runtime PID directory", true);
  assertRuntimeFileSafe(NodePath.join(paths.devDir, MANAGED_DESKTOP_SESSION_FILE), "desktop session", true);
  const gracefulShutdownRequested = !hasDesktopOwnedServer(paths.pidsDir)
    && await requestRuntimeShutdown(repoRoot, options.shutdownTimeoutMs);

  return stopRecordedRuntimePids(repoRoot, {
    ...options,
    gracefulShutdownRequested,
  });
}

function hasDesktopOwnedServer(pidsDir) {
  return NodeFS.existsSync(NodePath.join(pidsDir, "desktop.pid"))
    && !NodeFS.existsSync(NodePath.join(pidsDir, "server.pid"));
}

/** Requests shutdown of the server named by the current worktree contract. */
export async function requestRuntimeShutdown(repoRoot, timeoutMs = 5_000) {
  const contract = readPortsFileForShutdown(repoRoot);
  if (!contract?.healthUrl) return false;
  try {
    await fetchWithTimeout(`http://127.0.0.1:${contract.serverPort}/shutdown`, {
      method: "POST",
      headers: { Authorization: contract.seedLogin.authHeader },
    }, timeoutMs);
  } catch {
    // The server may already have stopped with Electron.
  }
  return true;
}

/**
 * Sends a shutdown request without allowing an unavailable server to block
 * ownership cleanup in `.dev/pids`.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid shutdown timeout: ${timeoutMs}`);
  }
  const controller = new AbortController();
  let timeoutTimer;
  const timeout = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => {
      controller.abort();
      const error = new Error(`Shutdown request timed out after ${timeoutMs}ms`);
      error.code = "MCODE_SHUTDOWN_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/**
 * Reads ports.json for graceful shutdown without blocking PID cleanup.
 *
 * @param {string} repoRoot
 * @returns {import("./runtime-contract.mjs").AgentRuntimePorts | null}
 */
function readPortsFileForShutdown(repoRoot) {
  try {
    return readPortsFile(repoRoot);
  } catch (error) {
    console.warn(`[agent:down] Ignoring invalid ports.json: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Stops only runtime PID files recorded under this worktree's `.dev/pids`.
 *
 * @param {string} [repoRoot]
 * @param {{ stop?: (pid: number, signal: NodeJS.Signals) => Promise<void> | void }} [options]
 * @returns {Promise<{ complete: boolean, unconfirmed: string[] }>}
 */
export async function stopRecordedRuntimePids(repoRoot = resolveRepoRoot(), options = {}) {
  const paths = getRuntimePaths(repoRoot);
  assertRuntimeRootSafe(repoRoot);
  assertRuntimeDirectorySafe(paths.pidsDir, "runtime PID directory", true);
  assertRuntimeFileSafe(NodePath.join(paths.devDir, MANAGED_DESKTOP_SESSION_FILE), "desktop session", true);
  if (!NodeFS.existsSync(paths.pidsDir)) return { complete: true, unconfirmed: [] };
  const pidFiles = NodeFS.readdirSync(paths.pidsDir)
    .filter((name) => name.endsWith(".pid"))
    .sort()
    .reverse();
  const desktopOwnsServer = hasDesktopOwnedServer(paths.pidsDir);
  if (desktopOwnsServer) {
    pidFiles.splice(pidFiles.indexOf("desktop.pid"), 1);
    pidFiles.unshift("desktop.pid");
  }

  const unconfirmed = [];
  for (const name of pidFiles) {
    const pidFile = NodePath.join(paths.pidsDir, name);
    assertRuntimeFileSafe(pidFile, "runtime PID file", true);
    if (!NodeFS.existsSync(pidFile)) continue;
    try {
      await stopRuntimePidFile(name, pidFile, repoRoot, options, desktopOwnsServer);
    } catch (error) {
      unconfirmed.push(name);
      console.warn(`[agent:down] ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { complete: unconfirmed.length === 0, unconfirmed };
}

async function stopRuntimePidFile(name, pidFile, repoRoot, options, desktopOwnsServer) {
  if (name === "server.pid") {
    return stopRecordedServerPidFile(pidFile, repoRoot, options);
  }
  if (name === "desktop.pid") {
    await stopRecordedDesktopPidFile(pidFile, repoRoot, options);
    if (desktopOwnsServer) await requestRuntimeShutdown(repoRoot, options.shutdownTimeoutMs);
    return;
  }
  return stopRuntimePid(pidFile, repoRoot, options);
}

/** Stops the validated managed desktop process tree before removing its PID file. */
export async function stopRecordedDesktopPidFile(pidFile, repoRoot, options = {}) {
  const stopDesktop = options.stopManagedDesktop ?? stopManagedDesktop;
  const result = await stopDesktop(repoRoot);
  if (result.status === "not-running") {
    return stopRuntimePid(pidFile, repoRoot, options);
  }
  if (result.status === "unconfirmed") {
    throw new Error(`Could not confirm Electron stopped for PID ${result.pid}: ${result.reason}`);
  }
  if (result.status === "stopped" || result.status === "already-stopped") {
    NodeFS.rmSync(pidFile);
  }
}

/**
 * Lets the server's authenticated shutdown finish before force-stopping it.
 *
 * @param {string} pidFile
 * @param {string} repoRoot
 * @param {{ stop?: (pid: number, signal: NodeJS.Signals) => Promise<void> | void, shutdownGraceMs?: number, serverGraceMs?: number, isProcessAlive?: (pid: number) => boolean, sleep?: (ms: number) => Promise<void>, now?: () => number, gracefulShutdownRequested?: boolean }} options
 * @returns {Promise<void>}
 */
async function stopRecordedServerPidFile(pidFile, repoRoot, options) {
  if (!options.gracefulShutdownRequested) {
    return stopRuntimePid(pidFile, repoRoot, options);
  }
  const graceMs = options.serverGraceMs ?? options.shutdownGraceMs ?? 10_000;
  const isProcessAlive = options.isProcessAlive ?? isPidAlive;
  const pid = parsePidFile(pidFile);
  const stopped = await waitForProcessExit(pid, graceMs, {
    isProcessAlive,
    sleep: options.sleep,
    now: options.now,
  });
  if (stopped) {
    NodeFS.rmSync(pidFile);
    return;
  }
  await stopRuntimePid(pidFile, repoRoot, options);
}

function stopRuntimePid(pidFile, repoRoot, options) {
  return stopRecordedPidFile(pidFile, {
    repoRoot,
    stop: (pid, signal) => stopAndConfirmPid(pid, options, signal),
  });
}

async function stopAndConfirmPid(pid, options, signal) {
  const stop = options.stop ?? stopPid;
  await stop(pid, signal);
  const stopped = await waitForProcessExit(pid, 500, {
    isProcessAlive: options.isProcessAlive ?? isPidAlive,
    sleep: options.sleep,
    now: options.now,
  });
  if (!stopped) throw new Error(`Could not confirm PID ${pid} stopped`);
}

/**
 * Waits for a process to disappear without consulting process names or ports.
 *
 * @param {number} pid
 * @param {number} timeoutMs
 * @param {{ isProcessAlive: (pid: number) => boolean, sleep?: (ms: number) => Promise<void>, now?: () => number }} options
 * @returns {Promise<boolean>}
 */
async function waitForProcessExit(pid, timeoutMs, { isProcessAlive, sleep = delay, now = Date.now }) {
  const deadline = now() + timeoutMs;
  if (!isProcessAlive(pid)) return true;
  while (now() < deadline) {
    await sleep(Math.min(100, Math.max(1, deadline - now())));
    if (!isProcessAlive(pid)) return true;
  }
  return !isProcessAlive(pid);
}

/** Returns whether a PID currently refers to a live process. */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** Resolves after the requested delay. */
function delay(timeoutMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs));
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.argv[2] ? NodePath.resolve(process.argv[2]) : resolveRepoRoot();
  const result = await agentDown(repoRoot);
  if (!result.complete) {
    console.error(`[agent:down] Could not confirm stopped: ${result.unconfirmed.join(", ")}`);
    process.exitCode = 1;
  }
}
