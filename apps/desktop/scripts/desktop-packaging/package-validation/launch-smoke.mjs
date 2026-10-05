#!/usr/bin/env bun
/**
 * Launches the built desktop app through `prod-electron.mjs` and passes once
 * its server publishes a lock and answers `/health`.
 *
 * CI runs this with ELECTRON_RUN_AS_NODE=1 on purpose: terminals inside
 * Electron-based apps inherit it, and the launcher must strip it or main
 * crashes before the server starts. Extra CLI args are forwarded to Electron.
 *
 * All state lives in a temp run directory. Cleanup only targets the launcher
 * PID spawned here and the server whose lock carries this run's auth token.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { killProcessTree } from "../../../../../scripts/kill-process-tree.mjs";
import {
  cleanupOwnedRun,
  resolveOwnedDesktopSpawnOptions,
  waitForHealth,
  waitForServerLock,
} from "./desktop-reliability-test.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const launcherPath = NodePath.resolve(__dirname, "..", "..", "prod-electron.mjs");
const STARTUP_TIMEOUT_MS = 45_000;
const RUN_ROOT_REMOVAL_TIMEOUT_MS = 15_000;
const HARD_TIMEOUT_MS = 60_000;

/**
 * Launch the desktop app, wait for a healthy server, then stop the owned tree.
 *
 * @param {string[]} [electronArgs] Forwarded to Electron by the launcher.
 * @param {{ onLaunch?: (child: import("node:child_process").ChildProcess) => void }} [hooks]
 */
export async function runLaunchSmoke(electronArgs = [], { onLaunch } = {}) {
  const run = createLaunchRun();
  const startedAt = Date.now();
  const desktop = startDesktop(run, electronArgs);
  onLaunch?.(desktop.child);
  let ownedServerAuthToken = null;
  try {
    const lock = await Promise.race([waitForHealthyServer(run.dataDir), desktop.exited]);
    ownedServerAuthToken = lock.authToken;
    return { port: lock.port, serverPid: lock.pid, launcherPid: desktop.child.pid, startupMs: Date.now() - startedAt };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\nDesktop output:\n${desktop.output().slice(-4_000)}`);
  } finally {
    await cleanupOwnedRun(desktop.child, run.dataDir, run.runRoot, {
      expectedServerAuthToken: ownedServerAuthToken,
      removeRunRoot: removeRunRootWithRetry,
    });
  }
}

function createLaunchRun() {
  const runRoot = NodePath.resolve(NodeOS.tmpdir(), `mcode-launch-smoke-${NodeCrypto.randomUUID()}`);
  const run = {
    runRoot,
    dataDir: NodePath.join(runRoot, "data"),
    userDataDir: NodePath.join(runRoot, "user-data"),
    fixtureRepo: NodePath.join(runRoot, "fixture-repo"),
  };
  for (const dir of [run.dataDir, run.userDataDir, run.fixtureRepo]) NodeFS.mkdirSync(dir, { recursive: true });
  return run;
}

function startDesktop(run, electronArgs) {
  const child = NodeChildProcess.spawn(process.execPath, [launcherPath, ...electronArgs], {
    env: {
      ...process.env,
      MCODE_DATA_DIR: run.dataDir,
      // An unpackaged build only honors MCODE_ELECTRON_USER_DATA_DIR under the
      // agent runtime contract, which in turn requires a fixture workspace.
      MCODE_AGENT_RUNTIME: "1",
      MCODE_ELECTRON_USER_DATA_DIR: run.userDataDir,
      MCODE_AGENT_FIXTURE_REPO: run.fixtureRepo,
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...resolveOwnedDesktopSpawnOptions(),
  });
  let capturedOutput = "";
  const capture = (chunk) => {
    capturedOutput = `${capturedOutput}${chunk.toString()}`.slice(-12_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  // Rejects so an early crash fails fast instead of waiting out the startup timeout.
  const exited = new Promise((_resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`Desktop exited before the server became healthy (code ${code}, signal ${signal})`)));
  });
  exited.catch(() => undefined);
  return { child, exited, output: () => capturedOutput };
}

/**
 * On Windows the run root can stay locked for several seconds after every
 * owned process has exited (observed ~11s locally), so retry within a bound.
 */
async function removeRunRootWithRetry(target) {
  const deadline = Date.now() + RUN_ROOT_REMOVAL_TIMEOUT_MS;
  for (;;) {
    try {
      NodeFS.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      if (Date.now() > deadline) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
}

async function waitForHealthyServer(dataDir) {
  const lock = await waitForServerLock(dataDir, STARTUP_TIMEOUT_MS);
  await waitForHealth(lock.port, STARTUP_TIMEOUT_MS);
  return lock;
}

function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const causes = error instanceof AggregateError ? error.errors.map((cause) => `
  - ${describeError(cause)}`) : [];
  return `${message}${causes.join("")}`;
}

if (import.meta.main) {
  let launcher = null;
  // Backstop for a hung cleanup: the run must never outlive the CI step budget.
  const hardTimeout = setTimeout(() => {
    console.error(`[launch-smoke] FAIL hard timeout after ${HARD_TIMEOUT_MS}ms`);
    void Promise.resolve(killProcessTree(launcher, { useProcessGroup: process.platform !== "win32" })).finally(() => process.exit(1));
  }, HARD_TIMEOUT_MS);
  try {
    const evidence = await runLaunchSmoke(process.argv.slice(2), { onLaunch: (child) => (launcher = child) });
    console.log(`[launch-smoke] PASS ${JSON.stringify(evidence)}`);
    process.exitCode = 0;
  } catch (error) {
    console.error(`[launch-smoke] FAIL ${describeError(error)}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(hardTimeout);
  }
}
