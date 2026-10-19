import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMigrationBackup, pruneMigrationBackups } from "../migration-backup.js";

describe("migration-backup", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-backup-test-"));
    dbPath = NodePath.join(dir, "mcode.db");
  });

  afterEach(() => {
    vi.useRealTimers();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  function writeDatabase(path: string, body: string): void {
    const database = new Database(path, { strict: true });
    try {
      database.exec("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
      database.prepare("INSERT OR REPLACE INTO records (id, body) VALUES ('row', ?)").run(body);
    } finally {
      database.close(true);
    }
  }

  function bodyIn(path: string): unknown {
    const database = new Database(path, { readonly: true, strict: true });
    try {
      return database.query("SELECT body FROM records WHERE id = 'row'").get();
    } finally {
      database.close(true);
    }
  }

  const backupFiles = (): string[] => NodeFS.readdirSync(dir).filter((name) => name.startsWith("mcode.db.bak-"));

  it("returns null for an in-memory DB and creates no files", () => {
    const result = createMigrationBackup(":memory:");
    expect(result).toBeNull();
  });

  it("returns null when the DB file does not exist (first-run install)", () => {
    const result = createMigrationBackup(dbPath);
    expect(result).toBeNull();
    expect(NodeFS.readdirSync(dir)).toHaveLength(0);
  });

  it("rejects a migration before backup creation when five generations cannot fit", () => {
    writeDatabase(dbPath, "preserved");
    const size = BigInt(NodeFS.statSync(dbPath).size);

    expect(() =>
      createMigrationBackup(dbPath, {
        availableBytes: size * 5n - 1n,
        retainedGenerations: 5,
      }),
    ).toThrow(new RegExp(`requires ${size * 5n} bytes.*${size * 5n - 1n} bytes available`));

    expect(NodeFS.readdirSync(dir)).toEqual(["mcode.db"]);
  });

  it("requires space for only one new copy when five generations exist", () => {
    writeDatabase(dbPath, "preserved");
    for (let generation = 1; generation <= 5; generation++) {
      NodeFS.writeFileSync(
        NodePath.join(dir, `mcode.db.bak-${generation}`),
        `generation ${generation}`,
      );
    }

    const backupPath = createMigrationBackup(dbPath, {
      availableBytes: BigInt(NodeFS.statSync(dbPath).size),
      retainedGenerations: 5,
    });

    expect(backupPath).not.toBeNull();
  });

  it("writes a backup that opens as a database and passes the integrity check", () => {
    writeDatabase(dbPath, "preserved");

    const backupPath = createMigrationBackup(dbPath)!;

    const backup = new Database(backupPath, { readonly: true, strict: true });
    try {
      expect(backup.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally {
      backup.close(true);
    }
    expect(bodyIn(backupPath)).toEqual({ body: "preserved" });
  });

  it("removes the partial backup when the source cannot be copied", () => {
    NodeFS.writeFileSync(dbPath, "not a sqlite database ".repeat(50));

    expect(() => createMigrationBackup(dbPath)).toThrow();
    expect(backupFiles()).toEqual([]);
  });

  it("backs up a committed WAL row that has not been checkpointed into the main file", () => {
    const database = new Database(dbPath, { strict: true });
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE records (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        INSERT INTO records (id, body) VALUES ('committed-wal-row', 'preserved');
      `);
      expect(NodeFS.existsSync(`${dbPath}-wal`)).toBe(true);

      const backupPath = createMigrationBackup(dbPath)!;
      const backup = new Database(backupPath, { readonly: true, strict: true });
      try {
        expect(backup.query("SELECT id, body FROM records").get()).toEqual({
          id: "committed-wal-row",
          body: "preserved",
        });
      } finally {
        backup.close(true);
      }
    } finally {
      database.close(true);
    }
  });

  it("leaves a write that another connection has not committed out of the backup", () => {
    const writer = new Database(dbPath, { strict: true });
    try {
      writer.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE records (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        INSERT INTO records (id, body) VALUES ('committed', 'kept');
        BEGIN;
        INSERT INTO records (id, body) VALUES ('in-flight', 'not committed');
      `);

      const backupPath = createMigrationBackup(dbPath)!;

      const backup = new Database(backupPath, { readonly: true, strict: true });
      try {
        expect(backup.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
        expect(backup.query("SELECT id FROM records ORDER BY id").all()).toEqual([{ id: "committed" }]);
      } finally {
        backup.close(true);
      }
    } finally {
      writer.close(true);
    }
  });

  it("creates distinct generations when backups share a timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    writeDatabase(dbPath, "generation one");
    const firstBackup = createMigrationBackup(dbPath)!;

    writeDatabase(dbPath, "generation two");
    const secondBackup = createMigrationBackup(dbPath)!;

    expect(secondBackup).not.toBe(firstBackup);
    expect(bodyIn(firstBackup)).toEqual({ body: "generation one" });
    expect(bodyIn(secondBackup)).toEqual({ body: "generation two" });
  });

  it("retains exactly five recent backup generations with their WALs", () => {
    NodeFS.writeFileSync(dbPath, "DB");

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
      "mcode.db.bak-6",
      "mcode.db.bak-7",
    ];
    backupNames.forEach((name, i) => {
      const path = NodePath.join(dir, name);
      NodeFS.writeFileSync(path, `db-${i}`);
      NodeFS.writeFileSync(`${path}-wal`, `wal-${i}`);
      const t = baseTime + i;
      NodeFS.utimesSync(path, t, t);
      NodeFS.utimesSync(`${path}-wal`, t, t);
    });

    pruneMigrationBackups(dbPath);

    const remaining = NodeFS.readdirSync(dir)
      .filter((f) => f.startsWith("mcode.db.bak-") && !f.endsWith("-wal"))
      .sort();
    expect(remaining).toEqual([
      "mcode.db.bak-3",
      "mcode.db.bak-4",
      "mcode.db.bak-5",
      "mcode.db.bak-6",
      "mcode.db.bak-7",
    ]);

    const dirContents = NodeFS.readdirSync(dir);
    expect(dirContents).not.toContain("mcode.db.bak-1");
    expect(dirContents).not.toContain("mcode.db.bak-1-wal");
    expect(dirContents).not.toContain("mcode.db.bak-2");
    expect(dirContents).not.toContain("mcode.db.bak-2-wal");
    expect(dirContents).toContain("mcode.db.bak-7-wal");
  });

  it("does nothing when keep is larger than the number of backups", () => {
    writeDatabase(dbPath, "preserved");
    createMigrationBackup(dbPath);

    pruneMigrationBackups(dbPath, 10);

    expect(backupFiles()).toHaveLength(1);
  });

  it("rejects negative keep values", () => {
    expect(() => pruneMigrationBackups(dbPath, -1)).toThrow();
  });
});
