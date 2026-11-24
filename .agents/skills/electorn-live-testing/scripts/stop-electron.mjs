import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { terminateProcessTree } from "./process-tree.mjs";

const { spawnSync } = NodeChildProcess;
const { existsSync, readFileSync, rmSync } = NodeFS;
const { join, resolve } = NodePath;

const SESSION_FILE_NAME = "electron-live-testing.json";

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

function stopRecordedProcess(record, { isProcessAlive = isPidAlive, runCommand = spawnSync }) {
  const { pid } = record;
  if (!isProcessAlive(pid)) return { status: "already-stopped" };

  const commandLine = readCommandLine(pid, runCommand);
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

  return stopValidatedProcess(pid, isProcessAlive, runCommand);
}

function stopValidatedProcess(pid, isProcessAlive, runCommand) {
  const stopped = terminateProcessTree(pid, runCommand);
  if (stopped.alreadyStopped) return { status: "already-stopped" };
  if (stopped.ok) return { status: "stopped" };
  if (stopped.timedOut) return { status: "unconfirmed", reason: stopped.error };
  // The process can exit after ownership validation but before taskkill runs.
  if (!isProcessAlive(pid)) return { status: "already-stopped" };
  throw new Error(`Could not stop Electron process tree: ${stopped.error}`);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readCommandLine(pid, runCommand = spawnSync) {
  const options = { encoding: "utf8", timeout: 10_000, windowsHide: true };
  if (process.platform === "win32") {
    const result = runCommand(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ],
      options,
    );
    if (result.error?.code === "ETIMEDOUT") return null;
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Could not inspect recorded Electron PID: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }

  const result = runCommand("ps", ["-ww", "-p", String(pid), "-o", "command="], options);
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
