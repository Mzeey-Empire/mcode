import * as NodeAssertStrict from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { stopElectron } from "./stop-electron.mjs";

NodeTest.test("cleans a stale owned Electron session record without terminating another process", () => {
  const { repoRoot, sessionFile } = writeSessionRecord(2_147_483_647);
  try {
    NodeAssertStrict.deepEqual(stopElectron(repoRoot), {
      pid: 2_147_483_647,
      status: "already-stopped",
    });
    NodeAssertStrict.equal(NodeFS.existsSync(sessionFile), false);
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});

NodeTest.test("skips command-line inspection and tree termination when the recorded PID has exited", () => {
  const { repoRoot, sessionFile } = writeSessionRecord(12345);
  try {
    const result = stopElectron(repoRoot, {
      isProcessAlive: () => false,
      runCommand: () => NodeAssertStrict.fail("An exited PID must not launch a command"),
    });
    NodeAssertStrict.deepEqual(result, { pid: 12345, status: "already-stopped" });
    NodeAssertStrict.equal(NodeFS.existsSync(sessionFile), false);
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});

NodeTest.test("keeps the Electron session record when command-line inspection times out", () => {
  const { repoRoot, sessionFile } = writeSessionRecord(12345);
  try {
    const result = stopElectron(repoRoot, {
      isProcessAlive: () => true,
      runCommand: () => ({ error: Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" }) }),
    });
    NodeAssertStrict.equal(result.status, "unconfirmed");
    NodeAssertStrict.equal(result.pid, 12345);
    NodeAssertStrict.match(result.reason, /command line.*timed out/i);
    NodeAssertStrict.equal(NodeFS.existsSync(sessionFile), true);
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});

NodeTest.test("removes the Electron session when taskkill reports no running instance", () => {
  const { repoRoot, sessionFile } = writeSessionRecord(12345);
  try {
    const result = stopElectron(repoRoot, {
      platform: "win32",
      isProcessAlive: () => true,
      runCommand: (command) => command === "taskkill.exe"
        ? { status: 128, stderr: "There is no running instance of the task" }
        : { status: 0, stdout: `"${process.execPath}" --remote-debugging-port=9222` },
    });
    NodeAssertStrict.deepEqual(result, { pid: 12345, status: "already-stopped" });
    NodeAssertStrict.equal(NodeFS.existsSync(sessionFile), false);
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "waits for Electron to exit after SIGTERM", diesOn: "SIGTERM", signals: ["SIGTERM"], status: "stopped" },
  { name: "force-stops Electron that ignores SIGTERM", diesOn: "SIGKILL", signals: ["SIGTERM", "SIGKILL"], status: "stopped" },
  { name: "reports Electron that survives SIGKILL as unconfirmed", diesOn: null, signals: ["SIGTERM", "SIGKILL"], status: "unconfirmed" },
  { name: "treats an unreaped zombie as exited", diesOn: null, zombieAfter: "SIGTERM", signals: ["SIGTERM"], status: "stopped" },
]) {
  NodeTest.test(`on POSIX, ${scenario.name}`, () => {
    const { repoRoot, sessionFile } = writeSessionRecord(12345);
    const sent = [];
    const received = (signal) => sent.some((entry) => entry.signal === signal);
    try {
      const result = stopElectron(repoRoot, {
        platform: "linux",
        exitWaitMs: 0,
        sleepSync: () => {},
        kill: (pid, signal) => sent.push({ pid, signal }),
        isProcessAlive: () => !(scenario.diesOn && received(scenario.diesOn)),
        runCommand: (command, args) => {
          NodeAssertStrict.equal(command, "ps");
          if (args.includes("stat=")) {
            return { status: 0, stdout: scenario.zombieAfter && received(scenario.zombieAfter) ? "Z\n" : "S\n" };
          }
          return { status: 0, stdout: `${process.execPath} --remote-debugging-port=9222\n` };
        },
      });
      NodeAssertStrict.equal(result.status, scenario.status);
      NodeAssertStrict.deepEqual(sent, scenario.signals.map((signal) => ({ pid: -12345, signal })));
      NodeAssertStrict.equal(NodeFS.existsSync(sessionFile), scenario.status === "unconfirmed");
    } finally {
      NodeFS.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
}

NodeTest.test("on Windows, reports Electron still running after taskkill as unconfirmed", () => {
  const { repoRoot, sessionFile } = writeSessionRecord(12345);
  try {
    const result = stopElectron(repoRoot, {
      platform: "win32",
      exitWaitMs: 0,
      sleepSync: () => {},
      isProcessAlive: () => true,
      runCommand: (command) => command === "taskkill.exe"
        ? { status: 0, stdout: "SUCCESS", stderr: "" }
        : { status: 0, stdout: `"${process.execPath}" --remote-debugging-port=9222` },
    });
    NodeAssertStrict.equal(result.status, "unconfirmed");
    NodeAssertStrict.match(result.reason, /still running/);
    NodeAssertStrict.equal(NodeFS.existsSync(sessionFile), true);
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});

function writeSessionRecord(pid) {
  const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-stop-electron-"));
  const sessionFile = NodePath.join(repoRoot, ".dev", "electron-live-testing.json");
  NodeFS.mkdirSync(NodePath.dirname(sessionFile), { recursive: true });
  NodeFS.writeFileSync(sessionFile, JSON.stringify({
    pid,
    debugPort: 9_222,
    executablePath: process.execPath,
    repoRoot,
  }));
  return { repoRoot, sessionFile };
}
