import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { terminateProcessTree } from "./process-tree.mjs";

const { spawnSync } = NodeChildProcess;
const { existsSync, readFileSync, rmSync } = NodeFS;
const { join, resolve } = NodePath;

const SESSION_FILE_NAME = "electron-live-testing.json";
const EXIT_WAIT_MS = 5_000;
const EXIT_POLL_MS = 100;

/** Stops only the Electron process tree recorded for this worktree. */
export function stopElectron(repoRoot = process.cwd(), options = {}) {
  const root = resolve(repoRoot);
  const sessionFileName = options.sessionFileName ?? SESSION_FILE_NAME;
  if (!/^electron-[a-z0-9-]+\.json$/.test(sessionFileName)) {
    throw new Error("sessionFileName must be a safe Electron session file name");
  }
  const sessionFile = join(root, ".dev", sessionFileName);
  if (!existsSync(sessionFile)) return { status: "not-running" };

  const record = JSON.parse(readFileSync(sessionFile, "utf8"));
  validateRecord(record, root);
  const result = stopRecordedProcess(record, options);
  if (result.status !== "unconfirmed") rmSync(sessionFile, { force: true });
  return { pid: record.pid, ...result };
}

function stopRecordedProcess(record, options) {
  const { isProcessAlive, runCommand, platform, kill, sleepSync, exitWaitMs } = {
    isProcessAlive: isPidAlive,
    runCommand: spawnSync,
    platform: process.platform,
    kill: (pid, signal) => process.kill(pid, signal),
    sleepSync: sleepSyncMs,
    exitWaitMs: EXIT_WAIT_MS,
    ...options,
  };
  const { pid } = record;
  if (!isProcessAlive(pid)) return { status: "already-stopped" };

  const commandLine = readCommandLine(pid, runCommand, platform);
  if (commandLine === null) {
    return { status: "unconfirmed", reason: "Reading the Electron command line timed out" };
  }
  if (!commandLine) {
    if (!isProcessAlive(pid)) return { status: "already-stopped" };
    return { status: "unconfirmed", reason: "Could not read the Electron command line" };
  }
  if (!matchesElectronCommand(record, commandLine)) {
    throw new Error("Recorded PID no longer matches the owned Electron command");
  }

  const hasExited = () => !isProcessAlive(pid) || (platform !== "win32" && isPosixZombie(pid, runCommand));
  const waitForExit = () => waitForExitSync(hasExited, exitWaitMs, sleepSync);
  return stopValidatedProcess(pid, { isProcessAlive, waitForExit, tree: { runCommand, platform, kill } });
}

function stopValidatedProcess(pid, { isProcessAlive, waitForExit, tree }) {
  const stopped = terminateProcessTree(pid, tree);
  if (stopped.alreadyStopped) return { status: "already-stopped" };
  if (stopped.timedOut) return { status: "unconfirmed", reason: stopped.error };
  if (!stopped.ok) {
    // The process can exit after ownership validation but before taskkill runs.
    if (!isProcessAlive(pid)) return { status: "already-stopped" };
    throw new Error(`Could not stop Electron process tree: ${stopped.error}`);
  }
  if (waitForExit()) return { status: "stopped" };
  // SIGTERM is only a request that Electron may still be honouring; taskkill /F already forces the tree.
  if (tree.platform !== "win32") {
    terminateProcessTree(pid, { ...tree, signal: "SIGKILL" });
    if (waitForExit()) return { status: "stopped" };
  }
  return { status: "unconfirmed", reason: `Electron PID ${pid} was still running after the stop request` };
}

function waitForExitSync(hasExited, timeoutMs, sleepSync) {
  const deadline = Date.now() + timeoutMs;
  while (!hasExited()) {
    if (Date.now() >= deadline) return false;
    sleepSync(EXIT_POLL_MS);
  }
  return true;
}

// Callers stop Electron synchronously, so the wait blocks the thread instead of yielding to the event loop.
function sleepSyncMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Signal 0 succeeds for a zombie. Electron becomes one when the caller that spawned it has not reaped it yet,
// which a blocked event loop cannot do.
function isPosixZombie(pid, runCommand) {
  const result = runCommand("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 2_000 });
  return result.status === 0 && result.stdout.trim().startsWith("Z");
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readCommandLine(pid, runCommand = spawnSync, platform = process.platform) {
  return platform === "win32"
    ? readWindowsCommandLine(pid, runCommand)
    : readPosixCommandLine(pid, runCommand);
}

const COMMAND_LINE_OPTIONS = { encoding: "utf8", timeout: 10_000, windowsHide: true };

function readWindowsCommandLine(pid, runCommand) {
  const result = runCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
    ],
    COMMAND_LINE_OPTIONS,
  );
  if (result.error?.code === "ETIMEDOUT") return null;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not inspect recorded Electron PID: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function readPosixCommandLine(pid, runCommand) {
  const result = runCommand("ps", ["-ww", "-p", String(pid), "-o", "command="], COMMAND_LINE_OPTIONS);
  if (result.error?.code === "ETIMEDOUT") return null;
  return result.status === 0 ? result.stdout.trim() : "";
}

/** Confirms that a live process still matches this worktree's managed Electron launch. */
export function isOwnedElectronProcess(record, root) {
  try {
    validateRecord(record, root);
    if (!isPidAlive(record.pid)) return false;
    const commandLine = readCommandLine(record.pid);
    return Boolean(commandLine) && matchesElectronCommand(record, commandLine);
  } catch {
    return false;
  }
}

function matchesElectronCommand(record, commandLine) {
  const normalizedCommand = commandLine.toLowerCase();
  const expectedExecutable = resolve(record.executablePath).toLowerCase();
  const expectedPort = `--remote-debugging-port=${record.debugPort}`;
  return normalizedCommand.includes(expectedExecutable) && normalizedCommand.includes(expectedPort);
}

function validateRecord(record, root) {
  if (
    !record ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !Number.isInteger(record.debugPort) ||
    record.debugPort <= 0 ||
    record.debugPort > 65_535 ||
    typeof record.executablePath !== "string" ||
    typeof record.repoRoot !== "string" ||
    resolve(record.repoRoot).toLowerCase() !== root.toLowerCase()
  ) {
    throw new Error("Electron session record is invalid");
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(stopElectron(), null, 2));
}
