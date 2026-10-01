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
const sqlDefinitionSchema = z.object({ sql: z.string() });
const sqlDefinitionsSchema = z.array(sqlDefinitionSchema);
const columnNamesSchema = z.array(z.object({ name: z.string().regex(/^[a-z_][a-z0-9_]*$/i) }));
const schemaSnapshotSchema = z.array(z.object({
  type: z.string(),
  name: z.string(),
  tbl_name: z.string(),
  sql: z.string().nullable(),
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

function readSchema(database: Database): z.infer<typeof schemaSnapshotSchema> {
  return schemaSnapshotSchema.parse(database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name",
  ).all());
}

function inspectSavedDatabase<T>(dbPath: string, inspect: (database: Database) => T): T {
  const database = new Database(dbPath, { readonly: true, strict: true });
  try {
    return inspect(database);
  } finally {
    database.close(true);
  }
}

function removeWindowReceipts(database: Database): void {
  const remove = database.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?");
  for (const entry of currentJournal.entries.filter((entry) => entry.idx >= 61 && entry.idx <= 66)) {
    remove.run(entry.when);
  }
}

function removeReceipt(database: Database, index: number): void {
  const entry = currentJournal.entries.find((candidate) => candidate.idx === index);
  if (!entry) throw new Error(`Missing fixture migration ${index}`);
  database.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(entry.when);
}

function rebuildEmptyFixtureTable(database: Database, options: {
  name: "canonical_writer_live_publication_heads" | "canonical_conversation_display_mappings" | "conversation_display_materialization_state";
  changeSql: (sql: string) => string;
}): void {
  const definition = sqlDefinitionSchema.parse(database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(options.name));
  const indexes = sqlDefinitionsSchema.parse(database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
  ).all(options.name));
  const changed = options.changeSql(definition.sql);
  expect(changed).not.toBe(definition.sql);
  database.exec(`DROP TABLE ${options.name}`);
  database.exec(changed);
  for (const index of indexes) database.exec(index.sql);
}

function rebuildFixtureMessages(database: Database, changeSql: (sql: string) => string): void {
  const definition = sqlDefinitionSchema.parse(database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
  ).get());
  const indexes = sqlDefinitionsSchema.parse(database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND sql IS NOT NULL",
  ).all());
  const columns = columnNamesSchema.parse(database.prepare("PRAGMA table_info(messages)").all())
    .map((column) => `"${column.name}"`).join(", ");
  const originalRows = database.prepare("SELECT * FROM messages ORDER BY id").all();
  const changed = changeSql(definition.sql);
  expect(changed).not.toBe(definition.sql);
  const replacement = changed.replace(/^CREATE TABLE\s+[`"]?messages[`"]?/i, "CREATE TABLE migration_history_rebuilt_messages");
  expect(replacement).not.toBe(changed);

  // Rebuild only this owned fixture, copying every row before replacing a table with inbound references.
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.transaction(() => {
      database.exec(replacement);
      database.exec(`INSERT INTO migration_history_rebuilt_messages (${columns}) SELECT ${columns} FROM messages`);
      database.exec("DROP TABLE messages");
      database.exec("ALTER TABLE migration_history_rebuilt_messages RENAME TO messages");
      for (const index of indexes) database.exec(index.sql);
    })();
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
  expect(database.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(originalRows);
}

function changeLegacyProvenanceDeclaration(sql: string, constraint: string): string {
  return sql.replace(
    /(?:`legacy_provenance`|"legacy_provenance"|legacy_provenance)\s+text\b/i,
    `"legacy_provenance" TEXT ${constraint}`,
  );
}

function expectCurrentUpgrade(database: Database): z.infer<typeof ledgerSchema> {
  expectFixtureData(database);
  const ledger = readLedger(database);
  expect(ledger.map((entry) => entry.created_at)).toEqual(
    currentJournal.entries.filter((entry) => entry.idx <= 67).map((entry) => entry.when).sort((a, b) => a - b),
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

function createDamagedFixture(options: Parameters<typeof createUpgradedFixture>[0], damage: (database: Database) => void) {
  createUpgradedFixture(options);
  return withDatabase(options, (database) => {
    database.transaction(() => {
      removeWindowReceipts(database);
      damage(database);
    })();
    return { ledger: readLedger(database), schema: readSchema(database) };
  });
}

function expectRejectedRecovery(options: Parameters<typeof withDatabase>[0], snapshot: {
  ledger: z.infer<typeof ledgerSchema>;
  schema: z.infer<typeof schemaSnapshotSchema>;
}, affectedObject: string): void {
  expect(() => withDatabase(options, () => {})).toThrow(
    new RegExp(`^Migration history repair refused:.*${affectedObject}`),
  );
  inspectSavedDatabase(options.dbPath, (database) => {
    expect(readLedger(database)).toEqual(snapshot.ledger);
    expect(readSchema(database)).toEqual(snapshot.schema);
    expectFixtureData(database);
  });
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

  it.each([60, 61, 62, 63, 64, 65])("upgrades a healthy database through 00%i without treating its pending suffix as damaged", (lastIndex) => {
    const previous = copyCatalogue({ root: directory, lastIndex, lineEndings: "lf" });
    const originalLedger = createUpgradedFixture({ dbPath: databasePath, catalogue: previous });
    const current = copyCatalogue({ root: directory, lastIndex: 67, lineEndings: "lf" });

    withDatabase({ dbPath: databasePath, catalogue: current }, (database) => {
      const ledger = expectCurrentUpgrade(database);
      expect(ledger.slice(0, originalLedger.length)).toEqual(originalLedger);
    });
  });

  it.each(["unrecognized historical", "future"])("preserves an %s receipt across older and current catalogues", (kind) => {
    const previous = copyCatalogue({ root: directory, lastIndex: 66, lineEndings: "lf" });
    createUpgradedFixture({ dbPath: databasePath, catalogue: previous });
    const ledger = withDatabase({ dbPath: databasePath, catalogue: previous }, (database) => {
      const entry = currentJournal.entries.find((candidate) => candidate.idx === (kind === "future" ? 67 : 59));
      if (!entry) throw new Error("Missing fixture migration timestamp");
      database.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
        .run(`unrecognized-${kind}-receipt`, entry.when + 1);
      return readLedger(database);
    });
    const older = copyCatalogue({ root: directory, lastIndex: 60, lineEndings: "lf" });

    for (const catalogue of [older, previous]) {
      withDatabase({ dbPath: databasePath, catalogue }, (database) => {
        expect(readLedger(database)).toEqual(ledger);
        expectFixtureData(database);
      });
    }
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
    withDatabase({ dbPath: databasePath, catalogue: previous }, (database) => {
      database.transaction(() => removeWindowReceipts(database))();
      expect(readLedger(database)).toHaveLength(originalLedger.length - 6);
    });

    const current = copyCatalogue({ root: directory, lastIndex: 67, lineEndings: "lf" });
    const upgradedLedger = withDatabase({ dbPath: databasePath, catalogue: current }, expectCurrentUpgrade);

    withDatabase({ dbPath: databasePath, catalogue: current }, (database) => {
      expect(readLedger(database)).toEqual(upgradedLedger);
      expectCurrentUpgrade(database);
    });
  });

  it("repairs a missing 0062 receipt below the latest recorded migration only when the complete schema exists", () => {
    const previous = copyCatalogue({ root: directory, lastIndex: 66, lineEndings: "lf" });
    const originalLedger = createUpgradedFixture({ dbPath: databasePath, catalogue: previous });
    const retainedLedger = withDatabase({ dbPath: databasePath, catalogue: previous }, (database) => {
      removeReceipt(database, 62);
      return readLedger(database);
    });
    const current = copyCatalogue({ root: directory, lastIndex: 67, lineEndings: "lf" });

    withDatabase({ dbPath: databasePath, catalogue: current }, (database) => {
      const ledger = expectCurrentUpgrade(database);
      expect(ledger).toEqual(expect.arrayContaining(retainedLedger));
      expect(ledger).toHaveLength(originalLedger.length + 1);
    });
  });

  it("rejects a ledger hole whose 0062 column is absent rather than silently skipping it", () => {
    const previous = copyCatalogue({ root: directory, lastIndex: 66, lineEndings: "lf" });
    createUpgradedFixture({ dbPath: databasePath, catalogue: previous });
    const snapshot = withDatabase({ dbPath: databasePath, catalogue: previous }, (database) => {
      removeReceipt(database, 62);
      database.exec("ALTER TABLE messages DROP COLUMN legacy_provenance");
      return { ledger: readLedger(database), schema: readSchema(database) };
    });
    const current = copyCatalogue({ root: directory, lastIndex: 67, lineEndings: "lf" });

    expectRejectedRecovery({ dbPath: databasePath, catalogue: current }, snapshot, "messages");
  });

  it.each([
    {
      label: "inline CHECK",
      damage: (database: Database) => rebuildFixtureMessages(database, (sql) => changeLegacyProvenanceDeclaration(
        sql, "CHECK(length(legacy_provenance) <= 1)",
      )),
    },
    {
      label: "COLLATE",
      damage: (database: Database) => rebuildFixtureMessages(database, (sql) => changeLegacyProvenanceDeclaration(
        sql, "COLLATE NOCASE",
      )),
    },
    {
      label: "inline REFERENCES",
      damage: (database: Database) => rebuildFixtureMessages(database, (sql) => changeLegacyProvenanceDeclaration(
        sql, "REFERENCES workspaces(id)",
      )),
    },
    {
      label: "table CHECK",
      damage: (database: Database) => rebuildFixtureMessages(database, (sql) => sql.replace(
        /\)\s*$/, ", CHECK(length(legacy_provenance) <= 1))",
      )),
    },
    {
      label: "table foreign key",
      damage: (database: Database) => rebuildFixtureMessages(database, (sql) => sql.replace(
        /\)\s*$/, ", FOREIGN KEY(legacy_provenance) REFERENCES workspaces(id))",
      )),
    },
    {
      label: "table UNIQUE",
      damage: (database: Database) => rebuildFixtureMessages(database, (sql) => sql.replace(
        /\)\s*$/, ", UNIQUE(legacy_provenance))",
      )),
    },
    {
      label: "external UNIQUE index",
      damage: (database: Database) => database.exec(
        "CREATE UNIQUE INDEX fixture_legacy_provenance_unique ON messages(legacy_provenance)",
      ),
    },
    {
      label: "UNIQUE expression index",
      damage: (database: Database) => database.exec(
        "CREATE UNIQUE INDEX fixture_legacy_expression_unique ON messages(lower(legacy_provenance))",
      ),
    },
    {
      label: "UNIQUE index with owned column predicate",
      damage: (database: Database) => database.exec(
        "CREATE UNIQUE INDEX fixture_legacy_predicate_unique ON messages(content) WHERE legacy_provenance IS NOT NULL",
      ),
    },
  ])("rejects an added 0062 column with $label rather than certifying only table_xinfo", ({ damage }) => {
    const previous = copyCatalogue({ root: directory, lastIndex: 66, lineEndings: "lf" });
    createUpgradedFixture({ dbPath: databasePath, catalogue: previous });
    const snapshot = withDatabase({ dbPath: databasePath, catalogue: previous }, (database) => {
      damage(database);
      removeReceipt(database, 62);
      return { ledger: readLedger(database), schema: readSchema(database) };
    });
    const current = copyCatalogue({ root: directory, lastIndex: 67, lineEndings: "lf" });

    expectRejectedRecovery({ dbPath: databasePath, catalogue: current }, snapshot, "legacy_provenance");
  });

  it("repairs owned column history while preserving unrelated legacy CHECK and UNIQUE definitions", () => {
    const previous = copyCatalogue({ root: directory, lastIndex: 66, lineEndings: "lf" });
    createUpgradedFixture({ dbPath: databasePath, catalogue: previous });
    const retainedLedger = withDatabase({ dbPath: databasePath, catalogue: previous }, (database) => {
      rebuildFixtureMessages(database, (sql) => sql.replace(/\)\s*$/, ", CHECK(length(content) < 100000))"));
      database.exec("CREATE UNIQUE INDEX fixture_content_unique ON messages(content)");
      removeReceipt(database, 62);
      return readLedger(database);
    });
    const current = copyCatalogue({ root: directory, lastIndex: 67, lineEndings: "lf" });

    withDatabase({ dbPath: databasePath, catalogue: current }, (database) => {
      const ledger = expectCurrentUpgrade(database);
      expect(ledger).toEqual(expect.arrayContaining(retainedLedger));
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'fixture_content_unique'").get())
        .toEqual({ name: "fixture_content_unique" });
      expect(() => database.prepare(
        "UPDATE messages SET content = ? WHERE id = ?",
      ).run("x".repeat(100000), "migration-history-message")).toThrow(/CHECK/);
      expectFixtureData(database);
    });
  });

  it.each([
    {
      label: "incorrect foreign key target",
      object: "canonical_writer_live_publication_heads",
      damage: (database: Database) => rebuildEmptyFixtureTable(database, {
        name: "canonical_writer_live_publication_heads",
        changeSql: (sql) => sql.replace("REFERENCES `threads`(`id`)", "REFERENCES `workspaces`(`id`)"),
      }),
    },
    {
      label: "changed column default",
      object: "conversation_display_materialization_state",
      damage: (database: Database) => rebuildEmptyFixtureTable(database, {
        name: "conversation_display_materialization_state",
        changeSql: (sql) => sql.replace("DEFAULT 0", "DEFAULT 1"),
      }),
    },
    {
      label: "extra CHECK constraint",
      object: "canonical_conversation_display_mappings",
      damage: (database: Database) => rebuildEmptyFixtureTable(database, {
        name: "canonical_conversation_display_mappings",
        changeSql: (sql) => sql.replace(/\)\s*$/, ", CHECK (length(source_item_id) > 0))"),
      }),
    },
    {
      label: "STRICT table flag",
      object: "canonical_conversation_display_mappings",
      damage: (database: Database) => rebuildEmptyFixtureTable(database, {
        name: "canonical_conversation_display_mappings",
        changeSql: (sql) => `${sql} STRICT`,
      }),
    },
    {
      label: "WITHOUT ROWID table flag",
      object: "canonical_conversation_display_mappings",
      damage: (database: Database) => rebuildEmptyFixtureTable(database, {
        name: "canonical_conversation_display_mappings",
        changeSql: (sql) => `${sql} WITHOUT ROWID`,
      }),
    },
    {
      label: "missing required index",
      object: "idx_messages_thread_sequence_id",
      damage: (database: Database) => database.exec("DROP INDEX idx_messages_thread_sequence_id"),
    },
    {
      label: "reversed index key order",
      object: "idx_messages_thread_sequence_id",
      damage: (database: Database) => database.exec(`
        DROP INDEX idx_messages_thread_sequence_id;
        CREATE INDEX idx_messages_thread_sequence_id ON messages(sequence, thread_id, id);
      `),
    },
    {
      label: "descending index key",
      object: "idx_messages_thread_sequence_id",
      damage: (database: Database) => database.exec(`
        DROP INDEX idx_messages_thread_sequence_id;
        CREATE INDEX idx_messages_thread_sequence_id ON messages(thread_id, sequence DESC, id);
      `),
    },
    {
      label: "incorrect partial index predicate",
      object: "idx_thought_segments_final_message_sort_order_id",
      damage: (database: Database) => database.exec(`
        DROP INDEX idx_thought_segments_final_message_sort_order_id;
        CREATE INDEX idx_thought_segments_final_message_sort_order_id
          ON thought_segments(message_id, sort_order, id) WHERE is_final_response <> 1;
      `),
    },
  ])("rejects orphaned receipts with $label and restores the original database", ({ object, damage }) => {
    const previous = copyCatalogue({ root: directory, lastIndex: 66, lineEndings: "lf" });
    const snapshot = createDamagedFixture({ dbPath: databasePath, catalogue: previous }, damage);
    const current = copyCatalogue({ root: directory, lastIndex: 67, lineEndings: "lf" });

    expectRejectedRecovery({ dbPath: databasePath, catalogue: current }, snapshot, object);
  });

  it("rejects changed reviewed migration SQL instead of manufacturing a receipt for it", () => {
    const previous = copyCatalogue({ root: directory, lastIndex: 66, lineEndings: "lf" });
    const snapshot = createDamagedFixture({ dbPath: databasePath, catalogue: previous }, () => {});
    const current = copyCatalogue({ root: directory, lastIndex: 67, lineEndings: "lf" });
    NodeFS.appendFileSync(NodePath.join(current, "0061_hard_human_cannonball.sql"), "\n-- Different reviewed migration\n");

    expectRejectedRecovery({ dbPath: databasePath, catalogue: current }, snapshot, "0061_hard_human_cannonball");
  });

  it("restores the entire old ledger and schema when 0067 fails after receipt recovery", () => {
    const previous = copyCatalogue({ root: directory, lastIndex: 66, lineEndings: "lf" });
    const snapshot = createDamagedFixture({ dbPath: databasePath, catalogue: previous }, () => {});
    const current = copyCatalogue({ root: directory, lastIndex: 67, lineEndings: "lf" });
    NodeFS.appendFileSync(
      NodePath.join(current, "0067_cooing_tomorrow_man.sql"),
      "\n--> statement-breakpoint\nINSERT INTO missing_migration_fixture_table (value) VALUES (1);\n",
    );

    expect(() => withDatabase({ dbPath: databasePath, catalogue: current }, () => {}))
      .toThrow(/missing_migration_fixture_table/);
    inspectSavedDatabase(databasePath, (database) => {
      expect(readLedger(database)).toEqual(snapshot.ledger);
      expect(readSchema(database)).toEqual(snapshot.schema);
      expectFixtureData(database);
      expect(database.prepare(
        "SELECT last_sequence FROM canonical_writer_live_publication_heads WHERE thread_id = ?",
      ).get(fixtureThreadId)).toBeNull();
      expect(database.prepare(
        "SELECT name FROM sqlite_master WHERE name = 'canonical_writer_thread_operation_receipts'",
      ).get()).toBeNull();
    });
  });
});
