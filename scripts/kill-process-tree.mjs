/**
 * Platform-aware process tree termination for dev orchestration scripts.
 *
 * On Windows, child.kill() only terminates the direct subprocess (e.g. bun),
 * leaving grandchildren (e.g. the Vite server spawned by bun) as orphans that
 * continue holding their network ports across dev sessions.
 */

import { spawnSync } from "node:child_process";

/** Max wait for taskkill to propagate through a deep process tree. */
export const TASKKILL_TIMEOUT_MS = 5_000;

/**
 * Kill a child process and its entire process tree.
 *
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 */
export function killProcessTree(child) {
  if (!child?.pid) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
      stdio: "ignore",
      timeout: TASKKILL_TIMEOUT_MS,
    });
  } else {
    child.kill();
  }
}
