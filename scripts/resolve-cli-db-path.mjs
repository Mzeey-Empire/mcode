/**
 * Match server startup DB resolution for CLI tooling (`state:paths`, `db:info`).
 */
import { execFileSync } from "node:child_process";
import { getMcodeDir, resolveDbPath } from "../packages/shared/src/index.ts";

/**
 * Resolves the SQLite path the server would open: env override, then linked-worktree-local,
 * then hashed branch DB, then default file under `getMcodeDir()`.
 *
 * @returns {string}
 */
export function resolveCliDbPath() {
  const fromEnv = process.env.MCODE_DB_PATH?.trim();
  if (fromEnv) return fromEnv;

  let branch = process.env.MCODE_GIT_BRANCH?.trim();
  let gitToplevel = process.env.MCODE_GIT_TOPLEVEL?.trim();

  if (process.env.NODE_ENV !== "production") {
    if (!branch) {
      try {
        const b = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          encoding: "utf-8",
          timeout: 3000,
        }).trim();
        if (b && b !== "HEAD") branch = b;
      } catch {
        /* not a git checkout */
      }
    }
    if (!gitToplevel) {
      try {
        gitToplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
          encoding: "utf-8",
          timeout: 3000,
        }).trim();
      } catch {
        /* */
      }
    }
  }

  return resolveDbPath(getMcodeDir(), { branch, gitToplevel });
}
