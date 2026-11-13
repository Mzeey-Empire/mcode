import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";
import { cleanupOwnedRun, waitForProcessExit, resolveOwnedDesktopSpawnOptions, PACKAGED_DESKTOP_LAYOUTS } from
  "../../../apps/desktop/scripts/desktop-packaging/package-validation/desktop-reliability-test.mjs";
import { parseLogLines, analyzeRecord } from "./analysis.mjs";

/** Require a standard release executable path; allow builds from other checkouts. */
export function assertPackagedExecutable(path, flag) {
  const normalized = NodePath.resolve(path).replaceAll("\\", "/");
  if (!PACKAGED_DESKTOP_LAYOUTS.some((layout) => normalized.endsWith(`/release/${layout}`))) {
    throw new Error(`${flag} must be a packaged build under a release directory, not an installed app: ${path}`);
  }
}

/** Clear inherited MCODE_, ELECTRON_, VITE_, and NODE_ENV variables, then set isolated harness paths. */
export function launchEnvironment(parentEnv, { data, userData, capability }) {
  const env = { ...parentEnv };
  // Start menu launches omit NODE_ENV, and the packaged server still reads it at runtime for its single-instance default.
  for (const key of Object.keys(env)) {
    if (/^(MCODE_|ELECTRON_|VITE_)/.test(key) || key === "NODE_ENV") delete env[key];
  }
  return {
    ...env,
    MCODE_MODE: "desktop",
    MCODE_DATA_DIR: data,
    MCODE_ELECTRON_USER_DATA_DIR: userData,
    MCODE_RELIABILITY_CAPABILITY_PATH: capability,
  };
}

/** Interleave variants from warm-up index zero through measured launches, reversing build order each round. */
export function launchPlan(variants, builds, launches) {
  const plan = [];
  for (let index = 0; index <= launches; index++) {
    const orderedBuilds = index % 2 === 0 ? builds : [...builds].reverse();
    for (const variant of variants) {
      for (const build of orderedBuilds) plan.push({ index, variant, build });
    }
  }
  return plan;
}

/** Remove a harness directory, retrying while Electron's helper processes release user-data handles after exit. */
export async function removeTree(target) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      NodeFS.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isLocked(error) || Date.now() > deadline) throw error;
      await NodeTimersPromises.setTimeout(250);
    }
  }
}

function isLocked(error) {
  return error.code === "EBUSY" || error.code === "EPERM";
}

const STALE_ROOT = /^run-[0-9a-f-]{36}(\.removing)?$/;

/**
 * Delete run roots whose harness has exited, and report each one kept because a process may still use it. Processes
 * are never signalled, and a reused PID only delays removal.
 */
export function cleanupStaleRoots(parent, report = console.error,
  remove = (target) => NodeFS.rmSync(target, { recursive: true, force: true })) {
  NodeFS.mkdirSync(parent, { recursive: true });
  for (const name of NodeFS.readdirSync(parent)) {
    if (!STALE_ROOT.test(name)) continue;
    try {
      cleanupStaleRoot(NodePath.join(parent, name), report, remove);
    } catch (error) {
      // A concurrent harness can delete or claim the root between reads.
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function cleanupStaleRoot(root, report, remove) {
  if (NodeFS.lstatSync(root).isSymbolicLink()) return;
  const claimed = root.endsWith(".removing") ? root : claimStaleRoot(root, report);
  if (!claimed) return;
  try {
    remove(claimed);
  } catch (error) {
    if (!isLocked(error)) throw error;
    report(`Could not finish deleting ${claimed} (${error.code}); the next run retries`);
  }
}

function claimStaleRoot(root, report) {
  const owner = NodePath.join(root, "harness.pid");
  if (!NodeFS.existsSync(owner) || processState(readPid(owner)) !== "exited") return null;
  // An unreadable PID names no process to wait for; the rename decides.
  const held = recordedProcesses(root).find(({ state }) => state === "running");
  if (held) {
    report(`Kept stale root ${root}: ${held.file} names process ${held.pid}, which is still running`);
    return null;
  }
  const claimed = `${root}.removing`;
  // Windows blocks this rename while any process holds a file or its working directory inside the root, which catches
  // unrecorded processes such as a server that outlived Desktop before writing server.lock.
  try {
    NodeFS.renameSync(root, claimed);
  } catch (error) {
    if (!isLocked(error)) throw error;
    report(`Kept stale root ${root}: a process holds a file inside it (${error.code})`);
    return null;
  }
  return claimed;
}

function recordedProcesses(root) {
  const recorded = [];
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const desktop = NodePath.join(entry.name, "desktop.pid");
    const server = NodePath.join(entry.name, "data", "server.lock");
    if (NodeFS.existsSync(NodePath.join(root, desktop))) {
      recorded.push({ file: desktop, pid: readPid(NodePath.join(root, desktop)) });
    }
    if (NodeFS.existsSync(NodePath.join(root, server))) {
      recorded.push({ file: server, pid: readLockPid(NodePath.join(root, server)) });
    }
  }
  return recorded.map((entry) => ({ ...entry, state: processState(entry.pid) }));
}

function readPid(path) {
  return Number(NodeFS.readFileSync(path, "utf8"));
}

function readLockPid(path) {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"))?.pid;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function processState(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return "unknown";
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    // EPERM means the process exists under another user.
    return error.code === "ESRCH" ? "exited" : "running";
  }
}

/** Read launch candidates only from daily application logs. */
export function readLogs(directory) {
  const result = { records: [], invalid: 0 };
  if (!NodeFS.existsSync(directory)) return result;
  for (const name of NodeFS.readdirSync(directory).sort()) {
    if (!/^mcode\.log\.\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const parsed = parseLogLines(NodeFS.readFileSync(NodePath.join(directory, name), "utf8"));
    result.records.push(...parsed.records);
    result.invalid += parsed.invalid;
  }
  return result;
}

/** Spawn one isolated desktop, capture its record, and always clean its owned process tree. */
export async function launchOnce({ exe, fixture, root, signal, spawn = NodeChildProcess.spawn }) {
  const data = NodePath.join(root, "data");
  const userData = NodePath.join(root, "user-data");
  NodeFS.mkdirSync(data, { recursive: true });
  NodeFS.mkdirSync(userData);
  NodeFS.copyFileSync(fixture, NodePath.join(data, "mcode.db"));
  if (NodeFS.existsSync(`${fixture}.recovery`)) {
    NodeFS.cpSync(`${fixture}.recovery`, NodePath.join(data, "mcode.db.recovery"), { recursive: true });
  }
  const capability = NodePath.join(root, "capability.json");
  const token = NodeCrypto.randomBytes(32).toString("hex");
  NodeFS.writeFileSync(capability, JSON.stringify({ version: 1, token, runId: NodeCrypto.randomUUID() }), {
    mode: 0o600,
  });
  const env = launchEnvironment(process.env, { data, userData, capability });
  const desktopPid = NodePath.join(root, "desktop.pid");
  // Desktop inherits the hold handle at Windows process creation, blocking stale-root renames until Desktop exits,
  // even before desktop.pid is written.
  const hold = NodeFS.openSync(NodePath.join(root, "desktop.hold"), "w");
  let child;
  try {
    child = spawn(exe, [], {
      cwd: NodePath.dirname(exe),
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", hold],
      ...resolveOwnedDesktopSpawnOptions(),
    });
  } finally {
    NodeFS.closeSync(hold);
  }
  let tail = "";
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  const capture = (chunk) => { tail = (tail + chunk.toString()).slice(-2_000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  let launchError;
  let result;
  try {
    if (child.pid) NodeFS.writeFileSync(desktopPid, String(child.pid));
    result = await waitForRecord({ child, data, signal, spawnError: () => spawnError });
  } catch (error) {
    launchError = error;
    if (!signal.aborted) {
      console.error(`${error.message}\nDesktop output tail:\n${tail}`);
    }
    result = { failed: true, invalidRecords: 0 };
  }
  try {
    await cleanupOwnedRun(child, data, root, { waitForProcessExit, removeRunRoot: removeTree });
  } catch (cleanupError) {
    const error = launchError
      ? new AggregateError([launchError, cleanupError], "Launch and cleanup failed")
      : cleanupError;
    error.cleanupFailed = true;
    throw error;
  }
  if (launchError && signal.aborted) throw launchError;
  return result;
}

/** Return the first launch rejection reason, or null when the measurement is accepted. */
export function launchFailure(record) {
  if (record.serverMode !== "spawned") return "server reused";
  if (record.writtenBecause !== "window-ended") return `written because ${record.writtenBecause}`;
  if (record.serverTelemetry === null) return `no server window: ${record.serverTelemetryError}`;
  if (!Number.isFinite(record.renderer.usable)) return "no usable frame";
  if (record.serverTelemetry.windowEndAt < record.renderer.usable + 10_000) return "server window ended before usable + 10 s";
  if (record.serverTelemetry.rpcsDropped > 0) return `window dropped ${record.serverTelemetry.rpcsDropped} requests`;
  return null;
}

/** Return a launch analysis or failed result; throw on abort, exit, spawn failure, or timeout. */
export async function waitForRecord({ child, data, signal, spawnError = () => undefined, timeoutMs = 180_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (spawnError()) throw spawnError();
    const parsed = readLogs(NodePath.join(data, "logs"));
    if (parsed.records.length || parsed.invalid) return recordResult(parsed);
    if (hasExited(child)) throw new Error("Desktop exited before launch record");
    await NodeTimersPromises.setTimeout(100);
  }
  throw new Error(`Launch record timed out after ${timeoutMs / 1000} seconds`);
}

function recordResult(parsed) {
  if (parsed.records.length !== 1 || parsed.invalid) {
    console.error(`Expected one launch record; found ${parsed.records.length} records and ${parsed.invalid} malformed candidates`);
    return { failed: true, invalidRecords: parsed.invalid };
  }
  const record = parsed.records[0];
  const reason = launchFailure(record);
  if (reason !== null) console.error(reason);
  return {
    ...analyzeRecord(record),
    appVersion: record.appVersion,
    failed: reason !== null,
    invalidRecords: 0,
  };
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}
