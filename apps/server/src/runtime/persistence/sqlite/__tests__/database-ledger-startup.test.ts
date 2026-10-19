import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { logger } from "@mcode/shared";
import { openDatabase, type OpenDatabaseOptions } from "../database.js";
import { assertLedgerUsable, classifyLedger, inspectDatabase } from "../ledger-guard.js";
import { getMigrationCatalogue, loadMigrationCatalogue, migrationsFolderForDrizzle } from "../migration-catalogue.js";
import { floorUpsertStatement } from "../migration-contract-steps.js";
import { DatabaseStartupRefusal } from "../startup-refusal.js";

const sourceCatalogue = NodePath.join(process.cwd(), "drizzle");
const catalogue = loadMigrationCatalogue(sourceCatalogue);
const journalSchema = z.object({ entries: z.array(z.object({ idx: z.number(), tag: z.string(), when: z.number() }).passthrough()) }).passthrough();
const NEWER_TAG = "0093_newer_build_probe";
const NEWER_TABLE_SQL = "CREATE TABLE `newer_build_probe` (`id` integer PRIMARY KEY NOT NULL);";
const SHORT_WRITE_LOCK_WAIT_MS = 50;

function tagWhen(tag: string): number {
  const entry = catalogue.entries.find((candidate) => candidate.tag === tag);
  if (!entry) throw new Error(`No catalogue entry ${tag}`);
  return entry.when;
}

function backupsOf(directory: string): string[] {
  return NodeFS.readdirSync(directory).filter((name) => name.includes(".bak-") && !name.endsWith("-wal"));
}

function damage(dbPath: string, sql: string, ...params: Array<string | number>): void {
  const db = new Database(dbPath, { strict: true });
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close(true);
  }
}

function removeReceipts(dbPath: string, ...tags: string[]): void {
  for (const tag of tags) damage(dbPath, "DELETE FROM __drizzle_migrations WHERE created_at = ?", tagWhen(tag));
}

function ledgerOf(dbPath: string): unknown[] {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    return db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all();
  } finally {
    db.close(true);
  }
}

function writeCatalogue(root: string, name: string, options: { before?: string; extra?: { tag: string; sql: string } }): string {
  const directory = NodePath.join(root, name);
  NodeFS.mkdirSync(NodePath.join(directory, "meta"), { recursive: true });
  const journal = journalSchema.parse(JSON.parse(NodeFS.readFileSync(NodePath.join(sourceCatalogue, "meta", "_journal.json"), "utf8")));
  const stop = options.before === undefined ? journal.entries.length : journal.entries.findIndex((entry) => entry.tag === options.before);
  if (stop < 0) throw new Error(`No journal entry ${options.before}`);
  const kept = journal.entries.slice(0, stop);
  for (const entry of kept) NodeFS.copyFileSync(NodePath.join(sourceCatalogue, `${entry.tag}.sql`), NodePath.join(directory, `${entry.tag}.sql`));
  if (options.extra) {
    NodeFS.writeFileSync(NodePath.join(directory, `${options.extra.tag}.sql`), options.extra.sql);
    kept.push({ idx: kept.length, tag: options.extra.tag, when: catalogue.newestWhen + 1, version: "6", breakpoints: true });
  }
  NodeFS.writeFileSync(NodePath.join(directory, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  return directory;
}

describe("openDatabase ledger guard", () => {
  let root: string;
  let templatePath: string;
  let directory: string;
  let dbPath: string;

  beforeAll(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-ledger-guard-"));
    templatePath = NodePath.join(root, "template.db");
    openDatabase({ dbPath: templatePath }).close(true);
  });

  afterAll(() => {
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(root, "case-"));
    dbPath = NodePath.join(directory, "mcode.db");
    NodeFS.copyFileSync(templatePath, dbPath);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function refusalOf(path: string, options: Omit<OpenDatabaseOptions, "dbPath"> = {}): DatabaseStartupRefusal {
    try {
      openDatabase({ dbPath: path, ...options }).close(true);
    } catch (error) {
      if (error instanceof DatabaseStartupRefusal) return error;
      throw error;
    }
    throw new Error("Expected openDatabase to refuse the database");
  }

  function expectUntouched(before: Buffer): void {
    expect(NodeFS.readFileSync(dbPath).equals(before)).toBe(true);
    expect(backupsOf(directory)).toEqual([]);
  }

  function useDatabaseFromNewerBuild(extraSql: string): void {
    const newer = writeCatalogue(directory, "newer-build", { extra: { tag: NEWER_TAG, sql: extraSql } });
    NodeFS.rmSync(dbPath);
    vi.stubEnv("MCODE_DRIZZLE_MIGRATIONS_DIR", newer);
    openDatabase({ dbPath }).close(true);
    vi.stubEnv("MCODE_DRIZZLE_MIGRATIONS_DIR", sourceCatalogue);
  }

  function databaseBehindCatalogue(): string {
    const older = writeCatalogue(root, "older", { before: "0060_modern_tiger_shark" });
    const oldPath = NodePath.join(directory, "old.db");
    vi.stubEnv("MCODE_DRIZZLE_MIGRATIONS_DIR", older);
    openDatabase({ dbPath: oldPath }).close(true);
    vi.stubEnv("MCODE_DRIZZLE_MIGRATIONS_DIR", sourceCatalogue);
    return oldPath;
  }

  it("refuses the incident, a ledger that lost its newest receipts while their schema exists, before any write", () => {
    removeReceipts(dbPath, "0090_superb_frog_thor", "0091_happy_baron_strucker");
    const before = NodeFS.readFileSync(dbPath);

    const refusal = refusalOf(dbPath);

    expect(refusal.refusal).toEqual({
      kind: "ledger-damaged",
      databasePath: dbPath,
      tags: ["0090_superb_frog_thor", "0091_happy_baron_strucker"],
    });
    expect(refusal.message).toContain(dbPath);
    expectUntouched(before);
  });

  it("opens a database a newer build changed only additively, without a backup or a ledger change", () => {
    useDatabaseFromNewerBuild(NEWER_TABLE_SQL);
    const ledgerBefore = ledgerOf(dbPath);
    expect(ledgerBefore).toHaveLength(catalogue.entries.length + 1);

    const db = openDatabase({ dbPath });
    try {
      expect(db.query("SELECT count(*) AS count FROM newer_build_probe").get()).toEqual({ count: 0 });
    } finally {
      db.close(true);
    }

    expect(ledgerOf(dbPath)).toEqual(ledgerBefore);
    expect(backupsOf(directory)).toEqual([]);
  });

  it("refuses to open a database whose newer build raised the compatibility floor, naming the migration", () => {
    useDatabaseFromNewerBuild(`${NEWER_TABLE_SQL}\n--> statement-breakpoint\n${floorUpsertStatement(catalogue.newestWhen + 1, NEWER_TAG)}`);
    const before = NodeFS.readFileSync(dbPath);

    expect(refusalOf(dbPath).refusal).toEqual({ kind: "database-newer", databasePath: dbPath, raisedBy: NEWER_TAG });
    expectUntouched(before);
  });

  it("refuses a database with newer receipts and no compatibility floor", () => {
    damage(dbPath, "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", "from-the-future", catalogue.newestWhen + 1_000);
    damage(dbPath, "DELETE FROM mcode_schema_compatibility");
    const before = NodeFS.readFileSync(dbPath);

    expect(refusalOf(dbPath).refusal).toEqual({ kind: "database-newer", databasePath: dbPath, raisedBy: null });
    expectUntouched(before);
  });

  it("reports damage to a migration it knows rather than calling the database newer", () => {
    const tag = "0050_brown_meteorite";
    damage(dbPath, "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", "from-the-future", catalogue.newestWhen + 1_000);
    damage(dbPath, "UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?", "edited-after-shipping", tagWhen(tag));
    const before = NodeFS.readFileSync(dbPath);

    expect(refusalOf(dbPath).refusal).toEqual({ kind: "migration-mismatch", databasePath: dbPath, tag });
    expectUntouched(before);
  });

  it("refuses a migration recorded from different SQL", () => {
    const tag = "0050_brown_meteorite";
    damage(dbPath, "UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?", "edited-after-shipping", tagWhen(tag));
    const before = NodeFS.readFileSync(dbPath);

    expect(refusalOf(dbPath).refusal).toEqual({ kind: "migration-mismatch", databasePath: dbPath, tag });
    expectUntouched(before);
  });

  it("refuses an interior migration that has no receipt", () => {
    const tag = "0055_codex_child_orphan_repair";
    removeReceipts(dbPath, tag);
    const before = NodeFS.readFileSync(dbPath);

    expect(refusalOf(dbPath).refusal).toEqual({ kind: "ledger-damaged", databasePath: dbPath, tags: [tag] });
    expectUntouched(before);
  });

  it("refuses an empty ledger over tables from later migrations instead of replaying them", () => {
    damage(dbPath, "DELETE FROM __drizzle_migrations");
    const before = NodeFS.readFileSync(dbPath);

    expect(refusalOf(dbPath).refusal).toMatchObject({ kind: "database-unknown-history", databasePath: dbPath });
    expectUntouched(before);
  });

  it("refuses a file that is not a SQLite database without touching it", () => {
    NodeFS.writeFileSync(dbPath, Buffer.from("this is not a sqlite database ".repeat(40)));
    const before = NodeFS.readFileSync(dbPath);

    expect(refusalOf(dbPath).refusal).toMatchObject({ kind: "database-unreadable", databasePath: dbPath });
    expectUntouched(before);
  });

  it("opens a current database again without taking a backup", () => {
    openDatabase({ dbPath }).close(true);
    openDatabase({ dbPath }).close(true);

    expect(backupsOf(directory)).toEqual([]);
  });

  it("records both 0009 migrations on a fresh database and classifies it current", () => {
    const verdict = classifyLedger(inspectDatabase(templatePath), catalogue);
    const receipts = inspectDatabase(templatePath);
    const recordedWhens = receipts.kind === "present" ? receipts.receipts.map((receipt) => receipt.createdAt) : [];

    expect(verdict).toEqual({ kind: "current" });
    expect(recordedWhens).toContain(tagWhen("0009_fancy_ben_urich"));
    expect(recordedWhens).toContain(tagWhen("0009_plain_loki"));
  });

  it("migrates a database behind the catalogue, backing it up first, and ends current", () => {
    const oldPath = databaseBehindCatalogue();
    expect(backupsOf(directory)).toEqual([]);

    const db = openDatabase({ dbPath: oldPath });
    try {
      expect(() => assertLedgerUsable(db, getMigrationCatalogue(), oldPath)).not.toThrow();
      expect(db.query("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: catalogue.entries.length });
    } finally {
      db.close(true);
    }
    expect(backupsOf(directory)).toHaveLength(1);
  });

  it("restores the 0042 receipt the previous release left out, then migrates on", () => {
    const before0042 = writeCatalogue(root, "before-0042", { before: "0042_supreme_terrax" });
    const legacyPath = NodePath.join(directory, "legacy.db");
    vi.stubEnv("MCODE_DRIZZLE_MIGRATIONS_DIR", before0042);
    openDatabase({ dbPath: legacyPath }).close(true);
    expect(classifyLedger(inspectDatabase(legacyPath), catalogue)).toEqual({
      kind: "schema-ahead-of-ledger",
      tags: ["0042_supreme_terrax"],
    });

    vi.stubEnv("MCODE_DRIZZLE_MIGRATIONS_DIR", sourceCatalogue);
    const db = openDatabase({ dbPath: legacyPath });
    try {
      expect(classifyLedger(inspectDatabase(db), catalogue)).toEqual({ kind: "current" });
    } finally {
      db.close(true);
    }
  });

  it("leaves the database at its pre-failure ledger and keeps a readable backup when the final migration fails", () => {
    const failing = writeCatalogue(root, "failing", {
      extra: { tag: "0093_broken_final", sql: "INSERT INTO no_such_table (id) VALUES (1);" },
    });
    const ledgerBefore = ledgerOf(dbPath);
    vi.stubEnv("MCODE_DRIZZLE_MIGRATIONS_DIR", failing);

    const refusal = refusalOf(dbPath);

    const failed = refusal.refusal;
    if (failed.kind !== "migration-failed" || failed.backupPath === null) throw new Error("Expected migration-failed with a backup");
    expect(failed).toMatchObject({ databasePath: dbPath, sqliteMessage: expect.stringContaining("no such table") });
    expect(refusal.message).toContain("no such table");
    expect(refusal.cause).toBeInstanceOf(Error);
    expect(ledgerOf(dbPath)).toEqual(ledgerBefore);
    expect(backupsOf(directory)).toEqual([NodePath.basename(failed.backupPath)]);
    const backup = new Database(failed.backupPath, { readonly: true, strict: true });
    try {
      expect(backup.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(backup.query("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: ledgerBefore.length });
    } finally {
      backup.close(true);
    }
    vi.stubEnv("MCODE_DRIZZLE_MIGRATIONS_DIR", sourceCatalogue);
    openDatabase({ dbPath }).close(true);
  });

  it("refuses a database whose floor is above this build even when it holds no newer receipts", () => {
    damage(dbPath, "UPDATE mcode_schema_compatibility SET floor_when = ?, raised_by = ?", catalogue.newestWhen + 1, NEWER_TAG);
    const before = NodeFS.readFileSync(dbPath);

    expect(refusalOf(dbPath).refusal).toEqual({ kind: "database-newer", databasePath: dbPath, raisedBy: NEWER_TAG });
    expectUntouched(before);
  });

  it("records the same ledger rows as Drizzle's own migrator", () => {
    const referencePath = NodePath.join(directory, "reference.db");
    const reference = new Database(referencePath, { strict: true });
    try {
      migrate(drizzle(reference), { migrationsFolder: migrationsFolderForDrizzle(sourceCatalogue) });
    } finally {
      reference.close(true);
    }
    const ours = NodePath.join(directory, "ours.db");
    openDatabase({ dbPath: ours }).close(true);

    expect(ledgerOf(ours)).toEqual(ledgerOf(referencePath));
  });

  describe("write lock", () => {
    it("backs up the database as it was before the migration, taken while the migration holds the write lock", () => {
      const oldPath = databaseBehindCatalogue();
      const ledgerBefore = ledgerOf(oldPath);

      openDatabase({ dbPath: oldPath }).close(true);

      const [backup] = backupsOf(directory);
      expect(backupsOf(directory)).toHaveLength(1);
      expect(ledgerOf(NodePath.join(directory, backup ?? ""))).toEqual(ledgerBefore);
      expect(ledgerOf(oldPath)).toHaveLength(catalogue.entries.length);
      expect(ledgerBefore.length).toBeLessThan(catalogue.entries.length);
    });

    it("refuses as busy, changing nothing, while another connection holds a write transaction", () => {
      const oldPath = databaseBehindCatalogue();
      const ledgerBefore = ledgerOf(oldPath);
      const writer = new Database(oldPath, { strict: true });
      let refusal: DatabaseStartupRefusal;
      try {
        writer.run("BEGIN IMMEDIATE");
        refusal = refusalOf(oldPath, { writeLockWaitMs: SHORT_WRITE_LOCK_WAIT_MS });
      } finally {
        writer.close(true);
      }

      expect(refusal.refusal).toEqual({ kind: "database-busy", databasePath: oldPath });
      expect(ledgerOf(oldPath)).toEqual(ledgerBefore);
      expect(backupsOf(directory)).toEqual([]);
    });

    it("migrates nothing and backs up nothing when another process brought the database current after the inspection", () => {
      const oldPath = databaseBehindCatalogue();
      let ledgerAfterOtherProcess: unknown[] = [];

      openDatabase({
        dbPath: oldPath,
        afterInspection: () => {
          openDatabase({ dbPath: oldPath }).close(true);
          ledgerAfterOtherProcess = ledgerOf(oldPath);
        },
      }).close(true);

      expect(ledgerAfterOtherProcess).toHaveLength(catalogue.entries.length);
      expect(ledgerOf(oldPath)).toEqual(ledgerAfterOtherProcess);
      expect(backupsOf(directory)).toHaveLength(1);
    });

    it("refuses a database that needed no migration when another process made it newer after the inspection", () => {
      const ledgerBefore = ledgerOf(dbPath);
      const newerBuildMigrates = (): void => {
        damage(dbPath, "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", "from-the-future", catalogue.newestWhen + 1_000);
        damage(dbPath, "UPDATE mcode_schema_compatibility SET floor_when = ?, raised_by = ?", catalogue.newestWhen + 1_000, NEWER_TAG);
      };

      const refusal = refusalOf(dbPath, { afterInspection: newerBuildMigrates });

      expect(refusal.refusal).toEqual({ kind: "database-newer", databasePath: dbPath, raisedBy: NEWER_TAG });
      expect(ledgerOf(dbPath)).toHaveLength(ledgerBefore.length + 1);
      expect(backupsOf(directory)).toEqual([]);
    });
  });

  describe("after the migration has committed", () => {
    function seedBackupsWithOneThatCannotBeRemoved(oldPath: string): void {
      const stale = `${oldPath}.bak-0-stale`;
      NodeFS.mkdirSync(stale);
      NodeFS.writeFileSync(NodePath.join(stale, "keep"), "x");
      const hour = 3_600;
      const now = Date.now() / 1_000;
      NodeFS.utimesSync(stale, now - 3 * hour, now - 3 * hour);
      for (let index = 1; index <= 4; index += 1) {
        const recent = `${oldPath}.bak-${index}`;
        NodeFS.writeFileSync(recent, "x");
        NodeFS.utimesSync(recent, now - hour, now - hour);
      }
    }

    it("opens the migrated database and logs when old backups cannot be removed", () => {
      const oldPath = databaseBehindCatalogue();
      seedBackupsWithOneThatCannotBeRemoved(oldPath);
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      try {
        const db = openDatabase({ dbPath: oldPath });
        try {
          expect(() => assertLedgerUsable(db, getMigrationCatalogue(), oldPath)).not.toThrow();
        } finally {
          db.close(true);
        }
        expect(warn).toHaveBeenCalledWith("Could not remove old migration backups", expect.objectContaining({ databasePath: oldPath }));
      } finally {
        warn.mockRestore();
      }
    });
  });
});
