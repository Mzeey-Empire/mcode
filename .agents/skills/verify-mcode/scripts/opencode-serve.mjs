/** Owns verifier-spawned `opencode serve` processes and reads upstream OpenCode versions. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Mcode talks to `opencode serve` through its own HTTP client, not `@opencode-ai/sdk`. */
export const OPENCODE_SDK_LABEL = "none (hand-written HTTP client)";
const SERVE_HOSTNAME = "127.0.0.1";
const READY_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 10_000;

/** Reads `opencode --version`. Windows resolves the npm `.cmd` shim only through a shell. */
export function readOpenCodeBinaryVersion(execute = NodeChildProcess.execFileSync, platform = process.platform) {
  const [command, args] = openCodeCommand(["--version"], platform);
  const output = execute(command, args, { encoding: "utf8", timeout: 10_000, windowsHide: true, shell: platform === "win32" });
  const version = String(output ?? "").trim().split(/\r?\n/)[0]?.slice(0, 128) ?? "";
  if (!version) throw new Error("Condition: opencode --version printed no version.");
  return version;
}

/** Accepts only the documented `/global/health` shape and returns the server version. */
export function parseOpenCodeHealth(payload) {
  if (payload?.healthy !== true || typeof payload.version !== "string" || payload.version.length === 0) {
    throw new Error("Condition: /global/health did not report healthy with a version.");
  }
  return payload.version.slice(0, 128);
}

/** GETs `/global/health` from an OpenCode serve base URL. */
export async function fetchOpenCodeHealth(baseUrl) {
  const response = await fetch(new URL("/global/health", baseUrl), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Condition: /global/health returned HTTP ${response.status}.`);
  return parseOpenCodeHealth(await response.json());
}

/** GETs the sessions an OpenCode serve routes to one directory, as any second client would. */
export async function listOpenCodeSessions(baseUrl, directory) {
  const url = new URL("/session", baseUrl);
  url.searchParams.set("directory", directory);
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Condition: /session returned HTTP ${response.status}.`);
  const sessions = await response.json();
  if (!Array.isArray(sessions)) throw new Error("Condition: /session did not return a session list.");
  return sessions;
}

/**
 * Reports whether a session list contains one upstream session and whether
 * its directory is the expected thread cwd. `sameDirectory` owns path
 * comparison so Windows case and separator rules stay with the caller.
 */
export function findOpenCodeSession(sessions, sessionId, directory, sameDirectory) {
  const session = Array.isArray(sessions) ? sessions.find((candidate) => candidate?.id === sessionId) : undefined;
  return {
    visible: Boolean(session),
    directoryMatches: Boolean(session) && typeof session.directory === "string" && sameDirectory(session.directory, directory),
  };
}

/** Resolves binary and server versions without failing the caller; blockers are recorded instead. */
export async function resolveUpstreamOpenCode({ attachedUrl = "", readBinaryVersion = readOpenCodeBinaryVersion, readServerVersion = fetchOpenCodeHealth, startServe = startOwnedOpenCodeServe, stopServe = stopOwnedOpenCodeServe } = {}) {
  const upstream = { binaryVersion: null, serverVersion: null, sdk: OPENCODE_SDK_LABEL };
  try {
    upstream.binaryVersion = readBinaryVersion();
  } catch (error) {
    return { ...upstream, auditBlocker: `opencode --version failed: ${errorMessage(error)}` };
  }
  if (attachedUrl) return withServerVersion(upstream, () => readServerVersion(attachedUrl), "attached serve");
  return withServerVersion(upstream, () => readProbeServeVersion(startServe, stopServe), "verifier-owned probe serve");
}

async function readProbeServeVersion(startServe, stopServe) {
  const serve = await startServe();
  try {
    return serve.version;
  } finally {
    await stopServe(serve).catch(() => {});
  }
}

async function withServerVersion(upstream, read, source) {
  try {
    return { ...upstream, serverVersion: await read(), serverSource: source };
  } catch (error) {
    return { ...upstream, auditBlocker: `${source} version read failed: ${errorMessage(error)}` };
  }
}

/**
 * Spawns `opencode serve` in an owned temp directory and waits for health.
 * The PID is captured at spawn so cleanup never matches processes by name.
 */
export async function startOwnedOpenCodeServe({ env = process.env } = {}) {
  const tempDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-verify-opencode-serve-"));
  const port = await findFreePort();
  const url = `http://${SERVE_HOSTNAME}:${port}`;
  const [command, args] = openCodeCommand(["serve", "--port", String(port), "--hostname", SERVE_HOSTNAME]);
  const child = NodeChildProcess.spawn(command, args, {
    cwd: tempDirectory,
    env,
    stdio: "ignore",
    windowsHide: true,
    shell: process.platform === "win32",
    // POSIX: a new process group lets stop signal the whole serve tree by PID.
    detached: process.platform !== "win32",
  });
  const exit = watchExit(child);
  const serve = { pid: child.pid ?? null, url, tempDirectory, child, exit, version: null };
  try {
    if (!Number.isInteger(serve.pid)) throw new Error("Condition: opencode serve did not report a PID at spawn.");
    serve.version = await waitForHealth(url, exit);
    return serve;
  } catch (error) {
    await stopOwnedOpenCodeServe(serve).catch(() => {});
    throw error;
  }
}

/** Stops only the captured serve process tree, then removes its temp directory. */
export async function stopOwnedOpenCodeServe(serve) {
  const result = { stopped: false, tempDirectoryRemoved: false };
  if (Number.isInteger(serve?.pid) && serve.exit.code === undefined) {
    killProcessTree(serve.pid);
    await Promise.race([serve.exit.promise, delay(STOP_TIMEOUT_MS)]);
  }
  result.stopped = serve?.exit?.code !== undefined || !Number.isInteger(serve?.pid);
  result.tempDirectoryRemoved = await removeDirectory(serve?.tempDirectory);
  return result;
}

function killProcessTree(pid) {
  if (process.platform === "win32") {
    // The shell wrapper owns the PID; /T reaches the node child behind the .cmd shim.
    NodeChildProcess.spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { /* The group may already have exited. */ }
}

function watchExit(child) {
  const exit = { code: undefined, promise: null };
  exit.promise = new Promise((resolve) => {
    child.once("exit", (code, signal) => { exit.code = code ?? signal ?? null; resolve(); });
    child.once("error", (error) => { exit.code = `error:${error.code ?? "spawn"}`; resolve(); });
  });
  return exit;
}

async function waitForHealth(url, exit) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exit.code !== undefined) throw new Error(`Condition: opencode serve exited before health (${String(exit.code)}).`);
    try {
      return await fetchOpenCodeHealth(url);
    } catch { /* Not listening yet. */ }
    await delay(250);
  }
  throw new Error(`Condition: opencode serve did not answer /global/health within ${READY_TIMEOUT_MS / 1000} seconds.`);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, SERVE_HOSTNAME, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function removeDirectory(directory) {
  if (typeof directory !== "string") return false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      NodeFS.rmSync(directory, { recursive: true, force: true });
      return !NodeFS.existsSync(directory);
    } catch (error) {
      // Windows releases the serve's cwd handle shortly after taskkill returns.
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) return false;
      await delay(250);
    }
  }
  return false;
}

/**
 * Windows resolves the npm `.cmd` shim only through a shell, and Node rejects
 * separate args with `shell: true`. Every argument here is a verifier constant
 * or an integer port, so joining them cannot inject shell syntax.
 */
function openCodeCommand(args, platform = process.platform) {
  return platform === "win32" ? [["opencode", ...args].join(" "), []] : ["opencode", args];
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function errorMessage(error) { return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z]:\\[^\s]*/g, "[path]").slice(0, 320); }
