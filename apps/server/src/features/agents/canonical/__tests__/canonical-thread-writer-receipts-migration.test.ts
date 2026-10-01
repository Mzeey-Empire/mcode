import { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { expect, it } from "vitest";
import { z } from "zod";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { syntheticThreadExecutionId } from "../canonical-thread-execution.js";

const NOW = "2026-10-01T12:00:00.000Z";
const HISTORICAL_EXECUTION_ID = "00000000-0000-4000-8000-000000000000";
const journalSchema = z.object({ entries: z.array(z.object({
  idx: z.number(), tag: z.string(), when: z.number(), version: z.string(), breakpoints: z.boolean(),
})) }).passthrough();

function seedHistoricalPublication(db: Database, threadId: string, publicationId: unknown, sequence: number): void {
  const eventId = `historical:${sequence}`;
  const envelopeJson = JSON.stringify({
    eventId, routing: { threadId, executionId: HISTORICAL_EXECUTION_ID },
    sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: sequence,
    durableRevision: sequence, serverTimestamps: { acceptedAt: NOW, persistedAt: NOW },
    payload: { type: "publication.recorded", publicationId,
      event: { type: "compacting", threadId, active: false } },
  });
  db.prepare(`INSERT INTO canonical_agent_events
    (event_id, thread_id, execution_id, accepted_sequence, durable_revision, envelope_json, accepted_at, persisted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventId, threadId, HISTORICAL_EXECUTION_ID, sequence, sequence, envelopeJson, NOW, NOW);
}

function seedHistoricalThreads(db: Database): void {
  for (const threadId of ["upgrade-stale", "upgrade-higher", "upgrade-invalid", "upgrade-safe-limit"]) {
    db.prepare(`INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at)
      VALUES (?, 'upgrade-workspace', 'Historical', 'main', 'codex', ?, ?)`).run(threadId, NOW, NOW);
    db.prepare(`INSERT INTO canonical_agent_threads
      (id, workspace_id, root_thread_id, provider_id, activity_state, created_at, updated_at)
      VALUES (?, 'upgrade-workspace', ?, 'codex', 'Idle', ?, ?)`).run(threadId, threadId, NOW, NOW);
  }
  const publications: ReadonlyArray<readonly [string, unknown]> = [
    ["upgrade-thread", "37"], ["upgrade-thread", "42"],
    ["upgrade-stale", "11"], ["upgrade-stale", "17"], ["upgrade-stale", "999suffix"],
    ["upgrade-higher", "44"], ["upgrade-higher", 1000],
    ["upgrade-safe-limit", "9007199254740990"], ["upgrade-safe-limit", "9007199254740991"],
    ...["0", "00123", "35.5", "1e4", "9007199254740992", "999999999999999999999", "123suffix", 42]
      .map((id): readonly [string, unknown] => ["upgrade-invalid", id]),
  ];
  for (const [index, [threadId, publicationId]] of publications.entries()) {
    seedHistoricalPublication(db, threadId, publicationId, index + 1);
  }
  db.prepare(`INSERT INTO canonical_agent_events
    (event_id, thread_id, execution_id, accepted_sequence, durable_revision, envelope_json, accepted_at, persisted_at)
    VALUES ('historical:malformed', 'upgrade-invalid', ?, ?, ?, '{malformed', ?, ?)`)
    .run(HISTORICAL_EXECUTION_ID, publications.length + 1, publications.length + 1, NOW, NOW);
  db.run(`INSERT INTO canonical_writer_live_publication_heads (thread_id, last_sequence)
    VALUES ('upgrade-stale', 3), ('upgrade-higher', 100)`);
}

it("upgrades retained receipts and restores historical publication heads without changing saved records", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-thread-receipt-upgrade-"));
  const previousMigrations = NodePath.join(directory, "previous-migrations");
  const databasePath = NodePath.join(directory, "app.sqlite");
  const currentMigrations = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
  if (!currentMigrations) throw new Error("Migration directory was not provided by the server test configuration");
  const journal = journalSchema.parse(JSON.parse(NodeFS.readFileSync(NodePath.join(currentMigrations, "meta", "_journal.json"), "utf8")));
  const previousEntry = journal.entries.find((entry) => entry.tag === "0066_fat_amazoness");
  if (!previousEntry) throw new Error("Previous canonical receipt migration was not found");
  const entries = journal.entries.filter((entry) => entry.idx <= previousEntry.idx);
  NodeFS.mkdirSync(NodePath.join(previousMigrations, "meta"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(previousMigrations, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) NodeFS.copyFileSync(NodePath.join(currentMigrations, `${entry.tag}.sql`), NodePath.join(previousMigrations, `${entry.tag}.sql`));
  let db = new Database(databasePath, { strict: true });
  try {
    db.run("PRAGMA foreign_keys = ON");
    migrate(drizzle(db), { migrationsFolder: previousMigrations.replace(/\\/g, "/") });
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("upgrade-workspace", "Upgrade", directory, NOW, NOW);
    db.prepare(`INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at)
      VALUES ('upgrade-thread', 'upgrade-workspace', 'Upgrade', 'main', 'codex', ?, ?)`).run(NOW, NOW);
    db.prepare(`INSERT INTO canonical_agent_threads
      (id, workspace_id, root_thread_id, provider_id, activity_state, created_at, updated_at)
      VALUES (?, ?, ?, 'codex', 'Active', ?, ?)`)
      .run("upgrade-thread", "upgrade-workspace", "upgrade-thread", NOW, NOW);
    const executionId = "00000000-0000-4000-8000-000000000178";
    db.prepare(`INSERT INTO canonical_agent_turns
      (id, thread_id, execution_id, status, trigger_json, permission_mode, created_at, updated_at)
      VALUES ('upgrade-turn', 'upgrade-thread', ?, 'Running', '{"kind":"user"}', 'supervised', ?, ?)`)
      .run(executionId, NOW, NOW);
    const receiptJson = '{"kind":"parent-narrative-recovery-recorded","receipt":{"recorded":true}}';
    db.prepare(`INSERT INTO canonical_writer_operation_receipts
      (execution_id, operation_id, kind, input_hash, receipt_json, created_at)
      VALUES (?, 'unacknowledged-recovery', 'record-parent-narrative-recovery', ?, ?, ?)`)
      .run(executionId, "a".repeat(64), receiptJson, NOW);
    seedHistoricalThreads(db);
    const before = db.query("SELECT * FROM canonical_writer_operation_receipts").all();
    const historicalEvents = db.query("SELECT * FROM canonical_agent_events ORDER BY event_id").all();
    const expectedHeads = [
      { thread_id: "upgrade-higher", last_sequence: 100 },
      { thread_id: "upgrade-safe-limit", last_sequence: Number.MAX_SAFE_INTEGER },
      { thread_id: "upgrade-stale", last_sequence: 17 },
      { thread_id: "upgrade-thread", last_sequence: 42 },
    ];
    db.close(true);
    db = openDatabase({ dbPath: databasePath });
    expect(db.query("SELECT * FROM canonical_writer_operation_receipts").all()).toEqual(before);
    expect(db.query("SELECT * FROM canonical_agent_events ORDER BY event_id").all()).toEqual(historicalEvents);
    expect(db.query("SELECT thread_id, last_sequence FROM canonical_writer_live_publication_heads ORDER BY thread_id").all())
      .toEqual(expectedHeads);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const threadExecutionId = syntheticThreadExecutionId("upgrade-thread");
    expect(() => db.prepare(`INSERT INTO canonical_writer_operation_receipts
      (execution_id, operation_id, kind, input_hash, receipt_json)
      VALUES (?, 'fake-turn-receipt', 'append-accepted', 'seed', '{}')`).run(threadExecutionId))
      .toThrow("FOREIGN KEY constraint failed");
    db.prepare(`INSERT INTO canonical_writer_thread_operation_receipts
      (execution_id, thread_id, operation_id, kind, input_hash, receipt_json)
      VALUES (?, 'upgrade-thread', 'thread-append', 'append-accepted', 'seed', '{}')`).run(threadExecutionId);
    db.close(true);
    db = openDatabase({ dbPath: databasePath });
    expect(db.query("SELECT * FROM canonical_writer_operation_receipts").all()).toEqual(before);
    expect(db.query("SELECT * FROM canonical_agent_events ORDER BY event_id").all()).toEqual(historicalEvents);
    expect(db.query("SELECT thread_id, last_sequence FROM canonical_writer_live_publication_heads ORDER BY thread_id").all())
      .toEqual(expectedHeads);
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_thread_operation_receipts").get()).toEqual({ count: 1 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.prepare("DELETE FROM canonical_agent_threads WHERE id = 'upgrade-thread'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_thread_operation_receipts").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 0 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
