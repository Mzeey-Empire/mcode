import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../database.js";
import { openReadOnlyDatabase } from "../read-only-database.js";
import { applySQLiteConnectionPolicy } from "../sqlite-connection-policy.js";

describe("SQLite connection policy", () => {
  let database: Database | undefined;
  let directory: string;
  const originalMigrationsDirectory = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-connection-policy-"));
    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = NodePath.join(process.cwd(), "drizzle");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database?.close(true);
    database = undefined;
    if (originalMigrationsDirectory === undefined) {
      delete process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
    } else {
      process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = originalMigrationsDirectory;
    }
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("opens a file-backed database with the durable active policy", () => {
    database = openDatabase({ dbPath: NodePath.join(directory, "mcode.db") });

    expect({
      journalMode: pragmaValue(database, "journal_mode"),
      synchronous: pragmaValue(database, "synchronous"),
      foreignKeys: pragmaValue(database, "foreign_keys"),
      busyTimeout: pragmaValue(database, "busy_timeout"),
      cacheSize: pragmaValue(database, "cache_size"),
      mmapSize: pragmaValue(database, "mmap_size"),
    }).toEqual({
      journalMode: "wal",
      synchronous: 2,
      foreignKeys: 1,
      busyTimeout: 5_000,
      cacheSize: -2_048,
      mmapSize: 0,
    });
  });

  it("runs bounded optimization when the database opens and its schema changes", () => {
    const run = vi.spyOn(Database.prototype, "run");

    database = openDatabase({ dbPath: NodePath.join(directory, "mcode.db") });

    expect(run).toHaveBeenCalledWith("PRAGMA optimize = 0x10002");
    // The unmasked form can ANALYZE every index of a large database, so only
    // the bounded mask is allowed even after schema changes.
    expect(run).not.toHaveBeenCalledWith("PRAGMA optimize");
    expect(run.mock.calls.some(([source]) => /^\s*(?:ANALYZE|VACUUM)\b/i.test(String(source))))
      .toBe(false);
  });

  it("does not repeat schema-change optimization when the schema is current", () => {
    const databasePath = NodePath.join(directory, "mcode.db");
    database = openDatabase({ dbPath: databasePath });
    database.close(true);
    database = undefined;
    const run = vi.spyOn(Database.prototype, "run");

    database = openDatabase({ dbPath: databasePath });

    expect(run).toHaveBeenCalledWith("PRAGMA optimize = 0x10002");
    expect(run).not.toHaveBeenCalledWith("PRAGMA optimize");
  });

  // The writer worker and read-only readers open while another connection can
  // hold the file lock, as the last connection does while it checkpoints on close.
  describe("opening while another connection holds the file lock", () => {
    const holdMs = 300;
    let databasePath: string;
    let released: Promise<void> | undefined;

    beforeEach(() => {
      databasePath = NodePath.join(directory, "mcode.db");
      openDatabase({ dbPath: databasePath }).close(true);
    });

    // Runs before the outer cleanup removes the directory, which the holder still has open after a failure.
    afterEach(async () => {
      await released;
      released = undefined;
    });

    it("waits for the lock before the owner policy switches to WAL", async () => {
      ({ released } = await holdExclusiveLock(databasePath, holdMs));
      const startedAt = performance.now();
      database = new Database(databasePath, { strict: true, readwrite: true });

      applySQLiteConnectionPolicy(database, true);

      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(holdMs / 2);
      expect(pragmaValue(database, "journal_mode")).toBe("wal");
    });

    it("waits for the lock before a read-only connection checks WAL", async () => {
      ({ released } = await holdExclusiveLock(databasePath, holdMs));
      const startedAt = performance.now();

      database = openReadOnlyDatabase(databasePath);

      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(holdMs / 2);
      expect(pragmaValue(database, "journal_mode")).toBe("wal");
    });
  });
});

/**
 * Hold an exclusive file lock on another thread, since a busy wait blocks the opening thread.
 * Resolves once the lock is held. The release promise is wrapped so awaiting this call does not also wait for release.
 */
async function holdExclusiveLock(
  databasePath: string,
  holdMs: number,
): Promise<{ released: Promise<void> }> {
  const source = `
    import { Database } from "bun:sqlite";
    self.onmessage = ({ data }) => {
      const db = new Database(data.databasePath);
      db.run("PRAGMA locking_mode = EXCLUSIVE");
      db.run("BEGIN EXCLUSIVE");
      db.run("COMMIT");
      postMessage("held");
      setTimeout(() => { db.close(); postMessage("released"); }, data.holdMs);
    };`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module" });
  const messages = (expected: string) => new Promise<void>((resolve, reject) => {
    worker.addEventListener("message", ({ data }) => { if (data === expected) resolve(); });
    worker.addEventListener("error", (event) => reject(new Error(event.message)));
  });
  const held = messages("held");
  const released = messages("released").finally(() => {
    worker.terminate();
    URL.revokeObjectURL(url);
  });
  worker.postMessage({ databasePath, holdMs });
  await held;
  return { released };
}

function pragmaValue(database: Database, name: string): unknown {
  const row = database.query(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return row[name === "busy_timeout" ? "timeout" : name];
}
