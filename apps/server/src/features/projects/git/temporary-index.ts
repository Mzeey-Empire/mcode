import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { logger } from "@mcode/shared";
import type { GitExecutor } from "./execution/index.js";

/** Isolate writes to a private index without changing inherited Git config pairs. */
export function temporaryIndexEnv(indexFile: string): NodeJS.ProcessEnv {
  const count = Number(process.env.GIT_CONFIG_COUNT);
  const n = Number.isSafeInteger(count) && count >= 0 ? count : 0;
  // Split indexes can write and expire sharedindex files in the user's Git directory.
  // Optional locks off prevents Git from refreshing the user's real index.
  return {
    GIT_INDEX_FILE: indexFile,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: "core.splitIndex",
    [`GIT_CONFIG_VALUE_${n}`]: "false",
  };
}

/** Run Git work against a timestamp-preserving private copy of the checkout's index. */
export async function withIndexCopy<T>(
  gitExecutor: GitExecutor,
  cwd: string,
  name: string,
  whenIndexMissing: (env: NodeJS.ProcessEnv) => Promise<void>,
  work: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const index = await gitExecutor.exec(["-C", cwd, "rev-parse", "--git-path", "index"]);
  const source = NodePath.resolve(cwd, index.stdout.trim());
  const temporary = NodePath.join(NodePath.dirname(source), `${name}-${NodeCrypto.randomUUID()}`);
  const env = temporaryIndexEnv(temporary);
  try {
    await copyIndex(source, temporary, () => whenIndexMissing(env));
    return await work(env);
  } finally {
    for (const path of [temporary, `${temporary}.lock`]) await NodeFSPromises.unlink(path).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT")) {
        logger.warn("[withIndexCopy] Failed to remove temporary index", { path, err: error });
      }
    });
  }
}

async function copyIndex(source: string, temporary: string, whenMissing: () => Promise<void>): Promise<void> {
  try {
    const { atime, mtime } = await NodeFSPromises.stat(source);
    await NodeFSPromises.copyFile(source, temporary);
    // A newer index timestamp makes Git trust stat data for racily clean files.
    await NodeFSPromises.utimes(temporary, atime, mtime);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    // ENOENT can also name the destination directory. Only an absent source permits an empty index.
    const absent = await NodeFSPromises.lstat(source).then(() => false, (failure: unknown) => {
      if (hasErrorCode(failure, "ENOENT")) return true;
      throw failure;
    });
    if (!absent) throw error;
    await whenMissing();
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
