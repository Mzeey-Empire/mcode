import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMigrationBackup,
  pruneMigrationBackups,
  restoreMigrationBackup,
} from "../store/migration-backup.js";

describe("migration-backup", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcode-backup-test-"));
    dbPath = join(dir, "mcode.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for an in-memory DB and creates no files", () => {
    const result = createMigrationBackup(":memory:");
    expect(result).toBeNull();
  });

  it("returns null when the DB file does not exist (first-run install)", () => {
    const result = createMigrationBackup(dbPath);
    expect(result).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("copies the DB file and a present WAL sidecar", () => {
    writeFileSync(dbPath, "DBCONTENT");
    writeFileSync(`${dbPath}-wal`, "WALCONTENT");

    const backupPath = createMigrationBackup(dbPath);
    expect(backupPath).not.toBeNull();
    expect(readFileSync(backupPath!, "utf-8")).toBe("DBCONTENT");
    expect(readFileSync(`${backupPath}-wal`, "utf-8")).toBe("WALCONTENT");
  });

  it("restores DB content and WAL while clearing stale sidecars", () => {
    writeFileSync(dbPath, "ORIGINAL");
    writeFileSync(`${dbPath}-wal`, "ORIG_WAL");
    const backupPath = createMigrationBackup(dbPath)!;

    // Simulate a failed migration: main file mutated, sidecars dirty.
    writeFileSync(dbPath, "PARTIALLY_MUTATED");
    writeFileSync(`${dbPath}-wal`, "STALE_WAL");
    writeFileSync(`${dbPath}-shm`, "STALE_SHM");

    restoreMigrationBackup(backupPath, dbPath);

    expect(readFileSync(dbPath, "utf-8")).toBe("ORIGINAL");
    expect(readFileSync(`${dbPath}-wal`, "utf-8")).toBe("ORIG_WAL");
    // SHM is regenerable; restore must not leave a stale one in place.
    expect(readdirSync(dir).filter((f) => f.endsWith("-shm"))).toEqual([]);
  });

  it("prunes old backups but keeps the N most recent (with their WALs)", () => {
    writeFileSync(dbPath, "DB");

    // Author 5 backup pairs with explicit filenames AND explicit, ordered
    // mtimes so the test is robust to filesystem timestamp resolution and
    // does not rely on millisecond-uniqueness inside `createMigrationBackup`.
    const baseTime = Math.floor(Date.now() / 1000);
    const backupNames = [
      "mcode.db.bak-1",
      "mcode.db.bak-2",
      "mcode.db.bak-3",
      "mcode.db.bak-4",
      "mcode.db.bak-5",
    ];
    backupNames.forEach((name, i) => {
      const path = join(dir, name);
      writeFileSync(path, `db-${i}`);
      writeFileSync(`${path}-wal`, `wal-${i}`);
      const t = baseTime + i;
      utimesSync(path, t, t);
      utimesSync(`${path}-wal`, t, t);
    });

    pruneMigrationBackups(dbPath, 3);

    const remaining = readdirSync(dir)
      .filter((f) => f.startsWith("mcode.db.bak-") && !f.endsWith("-wal"))
      .sort();
    expect(remaining).toEqual(["mcode.db.bak-3", "mcode.db.bak-4", "mcode.db.bak-5"]);

    const dirContents = readdirSync(dir);
    expect(dirContents).not.toContain("mcode.db.bak-1");
    expect(dirContents).not.toContain("mcode.db.bak-1-wal");
    expect(dirContents).not.toContain("mcode.db.bak-2");
    expect(dirContents).not.toContain("mcode.db.bak-2-wal");
    expect(dirContents).toContain("mcode.db.bak-5-wal");
  });

  it("does nothing when keep is larger than the number of backups", () => {
    writeFileSync(dbPath, "DB");
    createMigrationBackup(dbPath);

    pruneMigrationBackups(dbPath, 10);

    const remaining = readdirSync(dir).filter((f) => f.startsWith("mcode.db.bak-"));
    expect(remaining).toHaveLength(1);
  });

  it("rejects negative keep values", () => {
    expect(() => pruneMigrationBackups(dbPath, -1)).toThrow();
  });
});
