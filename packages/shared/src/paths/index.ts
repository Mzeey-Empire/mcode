/**
 * Centralized Mcode data directory resolution.
 * Dev runtimes get their directory from the launcher through `MCODE_DATA_DIR`
 * (`<repo>/.dev`); only production builds fall back to `~/.mcode`.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Resolve the absolute path to the Mcode data directory.
 *
 * Returns `MCODE_DATA_DIR` when set, otherwise `~/.mcode` when `NODE_ENV` is
 * `production`. Any other process must be started by a launcher that provides
 * the directory, so a missing value throws instead of silently touching a
 * location shared with other checkouts.
 *
 * `NODE_ENV` is read at call time (not import time) so that callers can set it
 * before the first invocation.
 */
export function getMcodeDir(): string {
  if (process.env.MCODE_DATA_DIR) return process.env.MCODE_DATA_DIR;
  if (process.env.NODE_ENV === "production") return NodePath.join(NodeOS.homedir(), ".mcode");
  throw new Error(
    "MCODE_DATA_DIR is not set. Start Mcode with `bun run dev`, `bun run dev:desktop`, or " +
      "`bun run --shell system agent:up` so state stays under the checkout's .dev directory.",
  );
}

/**
 * Safe single path segment under `browser-capture-spill/` derived from a workspace id.
 * Falls back to a short hash when the id contains characters unsafe for directory names.
 */
export function spillWorkspaceDirSegment(workspaceId: string): string {
  const t = workspaceId.trim();
  if (t.length === 0) return "unknown";
  if (/^[a-zA-Z0-9_-]{1,80}$/.test(t)) return t;
  return NodeCrypto.createHash("sha256").update(t).digest("hex").slice(0, 24);
}
