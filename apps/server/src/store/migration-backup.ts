/**
 * Pre-migration safety net: copies the SQLite file (and its WAL sidecar) to a
 * timestamped backup before `migrate()` runs, so a botched migration can be
 * fully restored even if the schema mutation itself committed partial damage
 * before throwing. Old backups are pruned to a small ring so disk pressure
 * stays bounded over many app starts.
 */

import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { basename, dirname, join } from "path";

/** Sidecar files SQLite may write next to the main DB in WAL mode. */
const WAL_SUFFIX = "-wal";
const SHM_SUFFIX = "-shm";

/** Suffix used to identify migration backups belonging to a given DB file. */
function backupPrefix(dbPath: string): string {
  return `${basename(dbPath)}.bak-`;
}

/**
 * Copy `dbPath` (and its WAL sidecar, if present) to a timestamped backup.
 *
 * Returns the backup path on success or `null` when there is nothing to back
 * up (in-memory database, or the file does not exist yet because this is a
 * first-run install). The DB does not need to be closed; SQLite's WAL design
 * keeps the main file consistent with respect to its own checkpointed pages.
 */
export function createMigrationBackup(dbPath: string): string | null {
  if (dbPath === ":memory:" || !existsSync(dbPath)) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.bak-${stamp}`;
  copyFileSync(dbPath, backupPath);

  const walSrc = `${dbPath}${WAL_SUFFIX}`;
  if (existsSync(walSrc)) {
    copyFileSync(walSrc, `${backupPath}${WAL_SUFFIX}`);
  }
  return backupPath;
}

/**
 * Restore a backup created by `createMigrationBackup` over the live DB path.
 *
 * Removes any current `-wal` / `-shm` sidecars first so SQLite cannot replay
 * a journal from the failed migration over the restored file. The shared
 * memory file is regenerated automatically on next open.
 */
export function restoreMigrationBackup(backupPath: string, dbPath: string): void {
  for (const suffix of [WAL_SUFFIX, SHM_SUFFIX]) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }

  copyFileSync(backupPath, dbPath);

  const walBackup = `${backupPath}${WAL_SUFFIX}`;
  if (existsSync(walBackup)) {
    copyFileSync(walBackup, `${dbPath}${WAL_SUFFIX}`);
  }
}

/**
 * Delete all but the most recent `keep` migration backups for `dbPath`.
 * Backup pairs (`.bak-*` and matching `-wal`) are removed together so the
 * directory does not accumulate orphan WAL copies.
 */
export function pruneMigrationBackups(dbPath: string, keep: number): void {
  if (keep < 0) throw new Error("keep must be >= 0");
  if (dbPath === ":memory:") return;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) return;

  const prefix = backupPrefix(dbPath);
  const entries = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && !f.endsWith(WAL_SUFFIX))
    .map((f) => {
      const full = join(dir, f);
      return { full, mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const { full } of entries.slice(keep)) {
    try {
      unlinkSync(full);
    } catch {
      // ignore: another process may have cleaned it up first
    }
    const wal = `${full}${WAL_SUFFIX}`;
    if (existsSync(wal)) {
      try {
        unlinkSync(wal);
      } catch {
        // ignore: best-effort sidecar cleanup
      }
    }
  }
}
