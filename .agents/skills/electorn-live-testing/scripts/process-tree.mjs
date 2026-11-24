import * as NodeChildProcess from "node:child_process";

/** Stops a detached process tree and reports whether the operating system accepted the request. */
export function terminateProcessTree(pid, runCommand = NodeChildProcess.spawnSync) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Process tree PID must be a positive integer");
  }
  return process.platform === "win32"
    ? terminateWindowsProcessTree(pid, runCommand)
    : terminatePosixProcessTree(pid);
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
  return {
    ok: stopped.status === 0,
    error: stopped.status === 0 ? null : stopped.error?.message ?? stopped.stderr.trim(),
  };
}

function terminatePosixProcessTree(pid) {
  try {
    process.kill(-pid, "SIGTERM");
    return { ok: true, error: null };
  } catch (groupError) {
    if (groupError?.code !== "ESRCH") throw groupError;
  }

  try {
    process.kill(pid, "SIGTERM");
    return { ok: true, error: null };
  } catch (processError) {
    if (processError?.code === "ESRCH") return { ok: true, error: null };
    throw processError;
  }
}
