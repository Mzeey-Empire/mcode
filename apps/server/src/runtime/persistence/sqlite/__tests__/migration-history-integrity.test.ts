import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { openDatabase } from "../database.js";

const journalSchema = z.object({
  entries: z.array(z.object({
    idx: z.number().int().nonnegative(),
    tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/),
    when: z.number().int().positive(),
    version: z.string(),
    breakpoints: z.boolean(),
  })).nonempty(),
}).passthrough();

const ledgerSchema = z.array(z.object({
  id: z.number().int(),
  hash: z.string(),
  created_at: z.number().int(),
}));

const sourceCatalogue = NodePath.join(process.cwd(), "drizzle");
const currentJournal = journalSchema.parse(JSON.parse(
  NodeFS.readFileSync(NodePath.join(sourceCatalogue, "meta", "_journal.json"), "utf8"),
));
const fixtureThreadId = "migration-history-thread";
const fixtureTimestamp = "2026-10-01T10:00:00.000Z";
const fixtureEnvelope = JSON.stringify({
  payload: { type: "publication.recorded", publicationId: "37" },
});

function copyCatalogue(options: {
  root: string;
  lastIndex: number;
  lineEndings: "lf" | "crlf";
}): string {
  const entries = currentJournal.entries.filter((entry) => entry.idx <= options.lastIndex);
  const directory = NodePath.join(options.root, `drizzle-${options.lastIndex}-${options.lineEndings}`);
  NodeFS.mkdirSync(NodePath.join(directory, "meta"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, "meta", "_journal.json"), JSON.stringify({
    ...currentJournal,
    entries,
  }));
  for (const entry of entries) {
    const source = NodeFS.readFileSync(NodePath.join(sourceCatalogue, `${entry.tag}.sql`), "utf8");
    const lf = source.replace(/\r\n/g, "\n");
    NodeFS.writeFileSync(
      NodePath.join(directory, `${entry.tag}.sql`),
      options.lineEndings === "lf" ? lf : lf.replace(/\n/g, "\r\n"),
    );
  }
  return directory;
}

function withDatabase<T>(options: {
  dbPath: string;
  catalogue: string;
}, inspect: (database: Database) => T): T {
  vi.stubEnv("MCODE_DRIZZLE_MIGRATIONS_DIR", options.catalogue);
  const database = openDatabase({ dbPath: options.dbPath });
  try {
    return inspect(database);
  } finally {
    database.close(true);
  }
}

function readLedger(database: Database): z.infer<typeof ledgerSchema> {
  return ledgerSchema.parse(database.prepare(
    "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at, id",
  ).all());
}

function seedFixtureData(database: Database): void {
  database.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("migration-history-workspace", "Migration fixture", "C:/migration-fixture", fixtureTimestamp, fixtureTimestamp);
  database.prepare(`
    INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at)
    VALUES (?, ?, ?, 'main', 'codex', 'active', ?, ?)
  `).run(fixtureThreadId, "migration-history-workspace", "Retained conversation", fixtureTimestamp, fixtureTimestamp);
  database.prepare(`
    INSERT INTO messages (id, thread_id, role, content, timestamp, sequence)
    VALUES (?, ?, 'assistant', ?, ?, 1)
  `).run("migration-history-message", fixtureThreadId, "Retain this response", fixtureTimestamp);
  database.prepare(`
    INSERT INTO canonical_agent_threads
      (id, workspace_id, root_thread_id, provider_id, activity_state, created_at, updated_at)
    VALUES (?, ?, ?, 'codex', 'idle', ?, ?)
  `).run(fixtureThreadId, "migration-history-workspace", fixtureThreadId, fixtureTimestamp, fixtureTimestamp);
  database.prepare(`
    INSERT INTO canonical_agent_events
      (event_id, thread_id, execution_id, accepted_sequence, durable_revision,
       envelope_json, accepted_at, persisted_at)
    VALUES (?, ?, ?, 1, 1, ?, ?, ?)
  `).run(
    "migration-history-event", fixtureThreadId, "d107cda4-a00a-4a91-933b-fa229be02b19",
    fixtureEnvelope, fixtureTimestamp, fixtureTimestamp,
  );
}

function createUpgradedFixture(options: {
  dbPath: string;
  catalogue: string;
}): z.infer<typeof ledgerSchema> {
  const database = new Database(options.dbPath, { strict: true });
  try {
    // Legacy installs use bootstrapDrizzle's integer tracker keys, unlike Drizzle's SERIAL declaration.
    database.exec(`CREATE TABLE __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )`);
  } finally {
    database.close(true);
  }
  return withDatabase(options, (upgradedDatabase) => {
    seedFixtureData(upgradedDatabase);
    return readLedger(upgradedDatabase);
  });
}

function expectFixtureData(database: Database): void {
  expect(database.prepare(
    "SELECT content, sequence FROM messages WHERE id = ?",
  ).get("migration-history-message")).toEqual({ content: "Retain this response", sequence: 1 });
  expect(database.prepare(
    "SELECT envelope_json FROM canonical_agent_events WHERE event_id = ?",
  ).get("migration-history-event")).toEqual({ envelope_json: fixtureEnvelope });
}

describe("migration history integrity", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-migration-history-"));
    databasePath = NodePath.join(directory, "mcode.db");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (NodePath.dirname(NodePath.resolve(directory)) !== NodePath.resolve(NodeOS.tmpdir())) {
      throw new Error("Migration fixture cleanup escaped its temporary parent directory");
    }
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("preserves newer migration receipts when opening with a catalogue ending at 0060", () => {
    const newer = copyCatalogue({ root: directory, lastIndex: 66, lineEndings: "lf" });
    const older = copyCatalogue({ root: directory, lastIndex: 60, lineEndings: "lf" });
    const originalLedger = createUpgradedFixture({ dbPath: databasePath, catalogue: newer });

    withDatabase({ dbPath: databasePath, catalogue: older }, (database) => {
      expect(readLedger(database)).toEqual(originalLedger);
      expectFixtureData(database);
    });
  });

  it.each([
    { initial: "lf", subsequent: "crlf" },
    { initial: "crlf", subsequent: "lf" },
  ] satisfies Array<{ initial: "lf" | "crlf"; subsequent: "lf" | "crlf" }>)(
    "preserves receipts and does not replay DDL when SQL changes from $initial to $subsequent",
    ({ initial, subsequent }) => {
      const first = copyCatalogue({ root: directory, lastIndex: 66, lineEndings: initial });
      const second = copyCatalogue({ root: directory, lastIndex: 66, lineEndings: subsequent });
      const originalLedger = createUpgradedFixture({ dbPath: databasePath, catalogue: first });

      withDatabase({ dbPath: databasePath, catalogue: second }, (database) => {
        expect(readLedger(database)).toEqual(originalLedger);
        expectFixtureData(database);
      });
    },
  );

  it("recovers missing 0061-0066 receipts before applying 0067 and keeps restart idempotent", () => {
    const previous = copyCatalogue({ root: directory, lastIndex: 66, lineEndings: "lf" });
    const originalLedger = createUpgradedFixture({ dbPath: databasePath, catalogue: previous });
    const removedEntries = currentJournal.entries.filter((entry) => entry.idx >= 61 && entry.idx <= 66);
    withDatabase({ dbPath: databasePath, catalogue: previous }, (database) => {
      const removeReceipt = database.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?");
      database.transaction(() => {
        for (const entry of removedEntries) removeReceipt.run(entry.when);
      })();
      expect(readLedger(database)).toHaveLength(originalLedger.length - 6);
    });

    const current = copyCatalogue({ root: directory, lastIndex: 67, lineEndings: "lf" });
    const upgradedLedger = withDatabase({ dbPath: databasePath, catalogue: current }, (database) => {
      expectFixtureData(database);
      const ledger = readLedger(database);
      expect(ledger.map((entry) => entry.created_at)).toEqual(
        currentJournal.entries.filter((entry) => entry.idx <= 67).map((entry) => entry.when),
      );
      expect(database.prepare(
        "SELECT last_sequence FROM canonical_writer_live_publication_heads WHERE thread_id = ?",
      ).get(fixtureThreadId)).toEqual({ last_sequence: 37 });
      expect(database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get("canonical_writer_thread_operation_receipts")).toEqual({
        name: "canonical_writer_thread_operation_receipts",
      });
      return ledger;
    });

    withDatabase({ dbPath: databasePath, catalogue: current }, (database) => {
      expect(readLedger(database)).toEqual(upgradedLedger);
      expectFixtureData(database);
      expect(database.prepare(
        "SELECT last_sequence FROM canonical_writer_live_publication_heads WHERE thread_id = ?",
      ).get(fixtureThreadId)).toEqual({ last_sequence: 37 });
    });
  });
});
