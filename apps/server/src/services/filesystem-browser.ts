/**
 * Filesystem browser for the project-selector folder picker.
 * Resolves paths, walks up to the nearest existing ancestor, and returns
 * a capped list of directory entries for display in the UI.
 */

import { injectable } from "tsyringe";
import { stat, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

/** Maximum number of directory entries returned in a single browse response. */
const MAX_ENTRIES = 500;

/** Browses the host filesystem for the project-selector palette's folder picker. */
@injectable()
export class FilesystemBrowser {
  /**
   * List entries at the given path (or its nearest existing ancestor).
   * Expands ~ to home directory. Rejects path traversal. Returns at most 500 entries.
   * Directories sort before files; both groups are sorted alphabetically.
   */
  async browse(input: string): Promise<{
    path: string;
    parent: string | null;
    entries: { name: string; isDir: boolean }[];
  }> {
    // Reject path traversal before any resolution — callers should not be able
    // to reference arbitrary locations by sneaking ".." into input.
    if (input.includes("..")) {
      throw new Error("Path traversal not allowed");
    }

    // Expand ~ to home directory, then resolve to an absolute path.
    let target = input.replace(/^~/, homedir());
    target = resolve(target);

    // Walk up to the nearest existing path (handles ghost paths from stale state).
    let attempts = 0;
    while (target && attempts++ < 50) {
      try {
        await stat(target);
        break;
      } catch {
        const parent = dirname(target);
        if (parent === target) break; // reached filesystem root
        target = parent;
      }
    }

    const s = await stat(target);
    // When the resolved target is a file, browse its parent directory.
    const dir = s.isDirectory() ? target : dirname(target);

    const dirents = await readdir(dir, { withFileTypes: true });
    const entries = dirents
      .filter((d) => !d.name.startsWith("."))
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
      .sort((a, b) => {
        // Directories before files; ties broken alphabetically.
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, MAX_ENTRIES);

    const parentDir = dirname(dir);
    return {
      path: dir,
      parent: parentDir === dir ? null : parentDir,
      entries,
    };
  }
}
