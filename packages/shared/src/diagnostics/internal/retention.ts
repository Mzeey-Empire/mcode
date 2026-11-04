import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const RECORDING_FOLDERS = ["t", "p"];

/** Retention walks every recording file, so a busy recorder runs it this rarely instead of per flush. */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/** A recording segment considered by retention. */
export interface RecordingFile {
  path: string;
  size: number;
  modifiedAtMs: number;
}

async function listFolder(dir: string, folder: string): Promise<RecordingFile[]> {
  const folderPath = NodePath.join(dir, folder);
  let names: string[];
  try {
    names = await NodeFS.promises.readdir(folderPath);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const files: RecordingFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = NodePath.join(folderPath, name);
    const stats = await statIfPresent(path);
    if (stats) files.push({ path, size: stats.size, modifiedAtMs: stats.mtimeMs });
  }
  return files;
}

async function statIfPresent(path: string): Promise<NodeFS.Stats | undefined> {
  try {
    return await NodeFS.promises.stat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Picks the files retention must delete: anything older than the age limit, then the oldest
 * files once the newest ones already fill the size cap.
 */
export function selectExpiredFiles(files: readonly RecordingFile[], now: number): RecordingFile[] {
  const newestFirst = [...files].sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  const expired: RecordingFile[] = [];
  let retainedBytes = 0;

  for (const file of newestFirst) {
    retainedBytes += file.size;
    const tooOld = file.modifiedAtMs < now - MAX_AGE_MS;
    const overCap = retainedBytes > MAX_TOTAL_BYTES;
    if (tooOld || overCap) expired.push(file);
  }
  return expired;
}

/** Deletes recordings past the 7 day age limit or the 256 MB total cap, oldest first. */
export async function applyRetention(dir: string, now: number): Promise<void> {
  const files: RecordingFile[] = [];
  for (const folder of RECORDING_FOLDERS) {
    files.push(...(await listFolder(dir, folder)));
  }

  for (const file of selectExpiredFiles(files, now)) {
    await NodeFS.promises.rm(file.path, { force: true });
  }
}
