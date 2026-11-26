import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import type { CrashReporterStartOptions } from "electron";

/**
 * Development builds always save local dumps. Installed builds save them only
 * when the user opts in because dumps can hold process memory, including
 * conversation text and tokens.
 */
export function crashDumpOptions(
  isPackaged: boolean,
  savedCrashDumps: boolean | null,
): CrashReporterStartOptions | null {
  if (isPackaged && savedCrashDumps !== true) {
    return null;
  }

  // Electron's Crashpad handler manages retention. It prunes reports past
  // 128 MB total or older than 365 days, first after 10 minutes, then every
  // 24 hours (client/prune_crash_reports.cc and handler/prune_crash_reports_thread.cc).
  return { uploadToServer: false };
}

/** Sum the bytes occupied by local minidumps in the Crashpad database. */
export async function crashDumpsTotalBytes(directory: string): Promise<number> {
  let totalBytes = 0;
  for await (const { size } of walkCrashDumps(directory)) {
    totalBytes += size;
  }
  return totalBytes;
}

/** Delete local minidumps while preserving Crashpad's database files. */
export async function deleteCrashDumps(directory: string): Promise<void> {
  for await (const { path } of walkCrashDumps(directory)) {
    await NodeFSPromises.unlink(path);
  }
}

async function* walkCrashDumps(
  directory: string,
): AsyncGenerator<{ path: string; size: number }> {
  for (const entry of await readCrashDumpDirectory(directory)) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkCrashDumps(path);
    } else if (entry.isFile() && entry.name.endsWith(".dmp")) {
      yield { path, size: (await NodeFSPromises.lstat(path)).size };
    }
  }
}

async function readCrashDumpDirectory(directory: string) {
  try {
    return await NodeFSPromises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
