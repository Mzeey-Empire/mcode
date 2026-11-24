import * as NodeChildProcess from "node:child_process";

/**
 * Asks the operating system to stop a detached process tree and reports whether it accepted the request.
 * Acceptance does not mean the tree has exited; callers that need that must wait for the PID.
 *
 * @param {number} pid
 * @param {{ runCommand?: typeof NodeChildProcess.spawnSync, platform?: NodeJS.Platform, kill?: (pid: number, signal: NodeJS.Signals) => void, signal?: "SIGTERM" | "SIGKILL" }} [options]
 */
export function terminateProcessTree(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Process tree PID must be a positive integer");
  }
  const { runCommand, platform, kill, signal } = {
    runCommand: NodeChildProcess.spawnSync,
    platform: process.platform,
    kill: (target, killSignal) => process.kill(target, killSignal),
    signal: "SIGTERM",
    ...options,
  };
  return platform === "win32"
    ? terminateWindowsProcessTree(pid, runCommand)
    : terminatePosixProcessTree(pid, kill, signal);
}

function terminateWindowsProcessTree(pid, runCommand) {
  const stopped = runCommand(
    "taskkill.exe",
    ["/PID", String(pid), "/T", "/F"],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  if (stopped.error?.code === "ETIMEDOUT") {
    return { ok: false, timedOut: true, error: "taskkill timed out while stopping the Electron process tree" };
  }
  if (stopped.status === 128 || /not found|no running instance/i.test(`${stopped.stdout}\n${stopped.stderr}`)) {
    return { ok: true, alreadyStopped: true, error: null };
  }
  return {
    ok: stopped.status === 0,
    error: stopped.status === 0 ? null : stopped.error?.message ?? stopped.stderr.trim(),
  };
}

function terminatePosixProcessTree(pid, kill, signal) {
  try {
    kill(-pid, signal);
    return { ok: true, error: null };
  } catch (groupError) {
    if (groupError?.code !== "ESRCH") throw groupError;
  }

  try {
    kill(pid, signal);
    return { ok: true, error: null };
  } catch (processError) {
    if (processError?.code === "ESRCH") return { ok: true, alreadyStopped: true, error: null };
    throw processError;
  }
}
