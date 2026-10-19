import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../database.js";
import { DatabaseStartupRefusal } from "../startup-refusal.js";

describe("database migration recovery", () => {
  let directory: string;
  let databasePath: string;
  let migrationsDirectory: string;
  const originalMigrationsDirectory = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-migration-recovery-"));
    databasePath = NodePath.join(directory, "mcode.db");
    migrationsDirectory = NodePath.join(directory, "drizzle");
    NodeFS.mkdirSync(NodePath.join(migrationsDirectory, "meta"), { recursive: true });
  });

  afterEach(() => {
    if (originalMigrationsDirectory === undefined) {
      delete process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
    } else {
      process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = originalMigrationsDirectory;
    }
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  function writeMigrations(entries: Array<{ tag: string; when: number; sql: string }>): void {
    NodeFS.writeFileSync(
      NodePath.join(migrationsDirectory, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: entries.map((entry, idx) => ({ idx, version: "6", when: entry.when, tag: entry.tag, breakpoints: true })),
      }),
    );
    for (const entry of entries) NodeFS.writeFileSync(NodePath.join(migrationsDirectory, `${entry.tag}.sql`), entry.sql);
  }

  it("leaves a usable WAL database at its pre-failure ledger and keeps a readable backup", () => {
    const earlier = {
      tag: "0000_records",
      when: 1,
      sql: [
        "CREATE TABLE records (id TEXT PRIMARY KEY, body TEXT NOT NULL);",
        "--> statement-breakpoint",
        "INSERT INTO records (id, body) VALUES ('thread-public-id', 'preserved body');",
      ].join("\n"),
    };
    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = migrationsDirectory;
    writeMigrations([earlier]);
    openDatabase({ dbPath: databasePath }).close(true);
    expect(NodeFS.readdirSync(directory).some((name) => name.startsWith("mcode.db.bak-"))).toBe(false);

    writeMigrations([
      earlier,
      {
        tag: "0001_broken",
        when: 2,
        sql: ["CREATE TABLE partially_migrated (id INTEGER);", "--> statement-breakpoint", "SELECT FROM;"].join("\n"),
      },
    ]);

    let failure: unknown;
    try {
      openDatabase({ dbPath: databasePath });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DatabaseStartupRefusal);
    expect(failure).toMatchObject({ refusal: { kind: "migration-failed", databasePath, backupPath: expect.any(String) } });
    expect(failure).not.toHaveProperty("refusal.restored");
    expect(NodeFS.existsSync(`${databasePath}-shm`)).toBe(false);

    const survivor = new Database(databasePath, { readonly: true, strict: true });
    expect(survivor.query("SELECT id, body FROM records").get()).toEqual({
      id: "thread-public-id",
      body: "preserved body",
    });
    expect(survivor.query("SELECT name FROM sqlite_master WHERE name = 'partially_migrated'").get()).toBeNull();
    survivor.close(true);
    const backupPath = (failure as DatabaseStartupRefusal).refusal;
    if (backupPath.kind !== "migration-failed" || backupPath.backupPath === null) throw new Error("expected a backup path");
    const backup = new Database(backupPath.backupPath, { readonly: true, strict: true });
    expect(backup.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(backup.query("SELECT body FROM records").get()).toEqual({ body: "preserved body" });
    backup.close(true);
  });
});
