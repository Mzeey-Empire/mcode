import * as NodeFSPromises from "node:fs/promises";

/**
 * Whether a folder holds at least one entry. It reads a single directory entry and never returns
 * names, so callers can say that files exist without learning what they are. A missing folder, or a
 * path that is not a folder, holds none.
 */
export async function folderHasFiles(path: string): Promise<boolean> {
  try {
    const dir = await NodeFSPromises.opendir(path);
    try {
      return await dir.read() !== null;
    } finally {
      await dir.close();
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}
