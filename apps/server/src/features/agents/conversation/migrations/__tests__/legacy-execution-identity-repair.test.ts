import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { Database } from "bun:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lazySchema, SetThreadSubscriptionsResultSchema } from "@mcode/contracts";
import { openDatabase, openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { openReadOnlyDatabase } from "../../../../../runtime/persistence/sqlite/read-only-database.js";
import { ApplicationDatabaseWriter } from "../../../../../runtime/persistence/sqlite/application-database-writer.js";
import { CanonicalAgentBoundary } from "../../../canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../../canonical/canonical-agent-writer-client.js";
import { routePushSubscriptionRpc } from "../../../../../application/transport/push-subscription-rpc.js";
import { addClient, removeClient } from "../../../../../application/transport/push.js";
import { ConversationDisplayMaterializationStore } from "../conversation-display-materialization-store.js";
import { LegacyConversationMigration } from "../legacy-conversation-migration.js";
import { LegacyConversationMigrationStore } from "../legacy-conversation-migration-store.js";

const fixturePath = NodeURL.fileURLToPath(new URL("./fixtures/legacy-conversations/v1-parent-pair.sql", import.meta.url));
const fixture = NodeFS.readFileSync(fixturePath, "utf8");
const ExecutionRowSchema = lazySchema(() => z.object({ execution_id: z.string() }));

describe("converted legacy execution identity repair", () => {
  let db: Database;
  beforeEach(() => { db = openMemoryDatabase(); });
  afterEach(() => { db.close(true); });

  it("repairs completed conversion with the current import identity and preserves materialized content and counters", async () => {
    const expected = await seedConverted(db);
    const materializer = new ConversationDisplayMaterializationStore(db);
    let materialized = false;
    while (!materialized) materialized = materializer.runBatch();
    downgrade(db);
    const content = preservedRows(db);
    const migration = new LegacyConversationMigrationStore(db);
    expect(migration.runBatch()).toMatchObject({ processedMessages: 0, migratedMessages: 2, completed: false });
    expect(execution(db)).toBe(expected);
    expect(db.query("SELECT execution_id FROM canonical_agent_ingest_checkpoints").all())
      .toEqual([{ execution_id: expected }]);
    await migration.runToCompletion();
    expect(preservedRows(db)).toEqual(content);
    await migration.runToCompletion();
    expect(preservedRows(db)).toEqual(content);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("repairs one turn per batch including soft-deleted history", async () => {
    const first = await seedConverted(db);
    const second = await seedConverted(db, "v2");
    downgrade(db);
    downgrade(db, "v2");
    db.query("UPDATE threads SET deleted_at = '2026-02-01T00:00:00.000Z' WHERE id = 'thread-v2'").run();
    const migration = new LegacyConversationMigrationStore(db);
    expect(migration.runBatch().completed).toBe(false);
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_turns WHERE execution_id LIKE 'legacy-execution:%'").get())
      .toEqual({ count: 1 });
    expect(migration.runBatch().completed).toBe(false);
    expect(execution(db)).toBe(first);
    expect(execution(db, "v2")).toBe(second);
    expect(migration.runBatch()).toMatchObject({ migratedMessages: 4, ambiguousMessages: 0, completed: true });
  });

  it("preserves child lineage and opaque legacy-key text while repairing every converted child turn", async () => {
    const childFixture = NodeFS.readFileSync(new URL("./fixtures/legacy-conversations/v1-child-pair.sql", import.meta.url), "utf8");
    db.exec(childFixture);
    const quotedKey = "legacy-execution:child-user-v1";
    db.query("UPDATE messages SET content = ? WHERE id = 'child-user-v1'").run(quotedKey);
    db.query("UPDATE tool_call_records SET output_summary = ?").run(quotedKey);
    db.query("UPDATE threads SET sdk_session_id = ? WHERE id = 'thread-child-v1'").run(quotedKey);
    const migration = new LegacyConversationMigrationStore(db);
    await migration.runToCompletion();
    const identities = db.query<{ id: string; execution_id: string }, []>(
      "SELECT id, execution_id FROM canonical_agent_turns ORDER BY id").all();
    for (const turn of identities) {
      const old = `legacy-execution:${turn.id.slice("legacy-turn:".length)}`;
      db.query("UPDATE canonical_agent_turns SET execution_id = ? WHERE id = ?").run(old, turn.id);
      db.query("UPDATE canonical_agent_ingest_checkpoints SET execution_id = ? WHERE turn_id = ?").run(old, turn.id);
    }
    const content = preservedRows(db);
    const threads = db.query("SELECT * FROM canonical_agent_threads ORDER BY id").all();
    expect(await migration.runToCompletion()).toMatchObject({ migratedMessages: 6, ambiguousMessages: 0, completed: true });
    expect(db.query("SELECT id, execution_id FROM canonical_agent_turns ORDER BY id").all()).toEqual(identities);
    expect(db.query("SELECT * FROM canonical_agent_threads ORDER BY id").all()).toEqual(threads);
    expect(preservedRows(db)).toEqual(content);
  });

  it("repairs frozen converter ownership after the source message and provenance moved to a newer native turn", async () => {
    const expected = await seedConverted(db);
    downgrade(db);
    const nativeExecution = "00000000-0000-4000-8000-000000000099";
    db.query(`INSERT INTO canonical_agent_turns
      (id, thread_id, execution_id, status, trigger_json, permission_mode, started_at, ended_at, created_at, updated_at)
      SELECT 'modern-turn', thread_id, ?, status, trigger_json, permission_mode, started_at, ended_at, created_at, updated_at
      FROM canonical_agent_turns WHERE id = 'legacy-turn:user-v1'`).run(nativeExecution);
    db.exec(`UPDATE canonical_agent_items SET turn_id = 'modern-turn' WHERE id = 'message:user-v1';
      UPDATE canonical_legacy_message_provenance SET canonical_turn_id = 'modern-turn' WHERE message_id = 'user-v1';
      UPDATE canonical_agent_items SET payload_json = json_remove(payload_json, '$.legacyProvenance', '$.message.legacyProvenance')
      WHERE kind = 'message'`);
    const content = preservedRows(db);
    const nativeTurn = db.query("SELECT * FROM canonical_agent_turns WHERE id = 'modern-turn'").get();
    expect(await new LegacyConversationMigrationStore(db).runToCompletion())
      .toMatchObject({ migratedMessages: 2, ambiguousMessages: 0, completed: true });
    expect(execution(db)).toBe(expected);
    expect(db.query("SELECT * FROM canonical_agent_turns WHERE id = 'modern-turn'").get()).toEqual(nativeTurn);
    expect(preservedRows(db)).toEqual(content);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls back a rejected checkpoint and resumes after a lost post-commit result", async () => {
    const expected = await seedConverted(db);
    downgrade(db);
    const migration = new LegacyConversationMigrationStore(db);
    expect(() => migration.runBatch({ beforeCheckpoint: () => { throw new Error("repair before commit"); } }))
      .toThrow("repair before commit");
    expect(execution(db)).toBe("legacy-execution:user-v1");
    expect(db.query("SELECT execution_id FROM canonical_agent_ingest_checkpoints").all())
      .toEqual([{ execution_id: "legacy-execution:user-v1" }]);
    expect(() => migration.runBatch({ afterCheckpoint: () => { throw new Error("repair reply lost"); } }))
      .toThrow("repair reply lost");
    expect(execution(db)).toBe(expected);
    await migration.runToCompletion();
    expect(execution(db)).toBe(expected);
  });

  it("rolls back the first key update when the second key write fails", async () => {
    const expected = await seedConverted(db);
    downgrade(db);
    db.exec(`CREATE TRIGGER reject_repaired_checkpoint BEFORE UPDATE OF execution_id ON canonical_agent_ingest_checkpoints
      BEGIN SELECT RAISE(ABORT, 'checkpoint repair write failed'); END`);
    expect(() => new LegacyConversationMigrationStore(db).runBatch()).toThrow("checkpoint repair write failed");
    expect(execution(db)).toBe("legacy-execution:user-v1");
    expect(db.query("SELECT execution_id FROM canonical_agent_ingest_checkpoints").all())
      .toEqual([{ execution_id: "legacy-execution:user-v1" }]);
    db.exec("DROP TRIGGER reject_repaired_checkpoint");
    await new LegacyConversationMigrationStore(db).runToCompletion();
    expect(execution(db)).toBe(expected);
  });

  it("retains a committed unit when the next unit fails and resumes from the remaining key", async () => {
    const first = await seedConverted(db);
    const second = await seedConverted(db, "v2");
    downgrade(db);
    downgrade(db, "v2");
    db.exec("UPDATE canonical_agent_ingest_checkpoints SET phase = 'running' WHERE turn_id = 'legacy-turn:user-v2'");
    const migration = new LegacyConversationMigrationStore(db);
    expect(migration.runBatch().completed).toBe(false);
    expect(() => migration.runBatch()).toThrow(/legacy.*execution.*repair/i);
    expect(execution(db)).toBe(first);
    expect(execution(db, "v2")).toBe("legacy-execution:user-v2");
    db.exec("UPDATE canonical_agent_ingest_checkpoints SET phase = 'legacy_migrated' WHERE turn_id = 'legacy-turn:user-v2'");
    expect(await migration.runToCompletion()).toMatchObject({ migratedMessages: 4, completed: true });
    expect(execution(db, "v2")).toBe(second);
  });

  it("rejects an identity collision without changing either execution key", async () => {
    const expected = await seedConverted(db);
    downgrade(db);
    db.query(`INSERT INTO canonical_agent_turns
      (id, thread_id, execution_id, status, trigger_json, permission_mode, created_at, updated_at)
      SELECT 'conflicting-turn', thread_id, ?, status, trigger_json, permission_mode, created_at, updated_at
      FROM canonical_agent_turns WHERE id = 'legacy-turn:user-v1'`).run(expected);
    expect(() => new LegacyConversationMigrationStore(db).runBatch()).toThrow(/legacy.*execution.*collision/i);
    expect(execution(db)).toBe("legacy-execution:user-v1");
    expect(db.query("SELECT execution_id FROM canonical_agent_ingest_checkpoints").all())
      .toEqual([{ execution_id: "legacy-execution:user-v1" }]);
  });

  it.each([
    "UPDATE canonical_agent_turns SET status = 'Running'",
    "UPDATE canonical_agent_ingest_checkpoints SET phase = 'running'",
    "DELETE FROM canonical_agent_ingest_checkpoints",
    "UPDATE canonical_agent_turns SET execution_id = 'legacy-execution:'",
    "UPDATE messages SET role = 'assistant' WHERE id = 'user-v1'",
    "UPDATE canonical_agent_turns SET trigger_json = '{\"kind\":\"child\"}'",
    "UPDATE canonical_agent_turns SET ended_at = NULL",
    "UPDATE canonical_agent_ingest_checkpoints SET last_durable_sequence = 1",
    "UPDATE messages SET outcome_execution_id = 'legacy-execution:user-v1' WHERE id = 'assistant-v1'",
    `INSERT INTO canonical_writer_operation_receipts (execution_id, operation_id, kind, input_hash, receipt_json)
      VALUES ('legacy-execution:user-v1', 'unexpected-owner', 'commit', 'hash', '{}')`,
    `INSERT INTO canonical_writer_thread_operation_receipts (execution_id, thread_id, operation_id, kind, input_hash, receipt_json)
      VALUES ('legacy-execution:user-v1', 'thread-v1', 'unexpected-owner', 'append-accepted', 'hash', '{}')`,
    `INSERT INTO canonical_agent_events
      (event_id, thread_id, execution_id, accepted_sequence, durable_revision, envelope_json, accepted_at, persisted_at)
      VALUES ('unexpected-event', 'thread-v1', 'legacy-execution:user-v1', 1, 1, '{}', '2026-01-01', '2026-01-01')`,
    `INSERT INTO parent_assistant_text_checkpoints
      (execution_id, thread_id, turn_id, last_sequence, retained_bytes, retained_chunks, updated_at)
      VALUES ('legacy-execution:user-v1', 'thread-v1', 'legacy-turn:user-v1', 1, 0, 0, '2026-01-01')`,
  ])("rejects unsupported converted ownership: %s", async (corruption) => {
    await seedConverted(db);
    downgrade(db);
    db.exec(corruption);
    const previous = execution(db);
    const rows = preservedRows(db);
    expect(() => new LegacyConversationMigrationStore(db).runBatch()).toThrow(/legacy.*execution.*repair/i);
    expect(execution(db)).toBe(previous);
    expect(preservedRows(db)).toEqual(rows);
  });
});

it("upgrades completed history through the production writer and restores a mixed public subscription batch", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-legacy-id-upgrade-"));
  const dbPath = NodePath.join(directory, "app.sqlite");
  const seeded = openDatabase({ dbPath });
  let writer: ApplicationDatabaseWriter | undefined;
  let reader: Database | undefined;
  const socket = await openSubscriptionClient();
  const client = socket.client;
  try {
    const expected = await seedConverted(seeded);
    downgrade(seeded);
    seeded.query("INSERT INTO threads (id, workspace_id, title, branch, provider) VALUES (?, ?, ?, ?, ?)")
      .run("healthy-thread", "workspace-v1", "Healthy ACP", "main", "devin");
    seeded.close(true);
    writer = new ApplicationDatabaseWriter(dbPath);
    await writer.whenReady();
    reader = openReadOnlyDatabase(dbPath);
    const canonical = new CanonicalAgentBoundary(reader, writer, new CanonicalAgentWriterClient(writer), () => undefined);
    await canonical.startParentTurn({
      thread: { id: "healthy-thread", workspaceId: "workspace-v1", providerId: "devin", createdAt: "2026-01-01T00:00:00.000Z" },
      turnId: "healthy-turn", executionId: "00000000-0000-4000-8000-000000000099", permissionMode: "supervised", providerIdentities: [],
      userMessage: { kind: "create", messageId: "healthy-user", content: "Active ACP request", sequence: 1 },
    });
    addClient(client);
    const subscribe = () => routePushSubscriptionRpc("push.setThreadSubscriptions",
      { threadIds: ["healthy-thread", "thread-v1"], revisions: { "healthy-thread": { conversationRevision: 9999, rosterRevision: 9999 } } },
      { canonicalSink: canonical }, client);
    expect(subscribe).toThrow(/uuid/i);
    const migration = new LegacyConversationMigration(writer);
    expect(await migration.runBatch()).toMatchObject({ processedMessages: 0, migratedMessages: 2, completed: false });
    const result = SetThreadSubscriptionsResultSchema().parse(subscribe());
    expect(result.canonicalRecoveries.map((recovery) => recovery.threadId)).toEqual(["healthy-thread", "thread-v1"]);
    const states = result.canonicalRecoveries.map(({ durable }) => {
      if (durable.mode !== "snapshot") throw new Error("Expected full subscription recovery");
      return durable.snapshot.state;
    });
    expect(states[0]?.turns["healthy-turn"]?.status).toBe("Running");
    expect(states[1]?.turns["legacy-turn:user-v1"]?.status).toBe("Completed");
    expect(execution(reader)).toBe(expected);
    expect(canonical.loadConversationProjection("thread-v1", 10).messages.map((message) => message.content))
      .toEqual(["Question", "Answer"]);
    expect(canonical.loadConversationProjection("thread-v1", 10).narrativeByMessage["assistant-v1"]?.thoughts)
      .toEqual([expect.objectContaining({ id: "thought-v1", text: "Reasoned" })]);
    expect(await migration.runToCompletion()).toMatchObject({ migratedMessages: 3, completed: true });
    expect(await migration.runToCompletion()).toMatchObject({ migratedMessages: 3, completed: true });
    expect(execution(reader)).toBe(expected);
  } finally {
    removeClient(client);
    await socket.close();
    await writer?.close();
    reader?.close(true);
    seeded.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

async function openSubscriptionClient(): Promise<{ client: WebSocket; close: () => Promise<void> }> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Missing subscription fixture port");
  const connected = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
  const remote = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const client = await connected;
  return {
    client,
    close: async () => {
      remote.terminate();
      client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function seedConverted(db: Database, version = "v1"): Promise<string> {
  db.exec(fixture.replaceAll("v1", version));
  await new LegacyConversationMigrationStore(db).runToCompletion();
  return z.string().uuid().parse(execution(db, version));
}

function downgrade(db: Database, version = "v1"): void {
  const turnId = `legacy-turn:user-${version}`;
  const old = `legacy-execution:user-${version}`;
  db.transaction(() => {
    db.query("UPDATE canonical_agent_turns SET execution_id = ? WHERE id = ?").run(old, turnId);
    db.query("UPDATE canonical_agent_ingest_checkpoints SET execution_id = ? WHERE turn_id = ?").run(old, turnId);
  })();
}

function execution(db: Database, version = "v1"): string {
  return ExecutionRowSchema().parse(db.query("SELECT execution_id FROM canonical_agent_turns WHERE id = ?")
    .get(`legacy-turn:user-${version}`)).execution_id;
}

function preservedRows(db: Database): unknown[] {
  return ["messages", "canonical_agent_items", "canonical_legacy_message_provenance", "canonical_legacy_migration_checkpoints",
    "canonical_conversation_display_mappings", "thought_segments", "tool_call_records", "hook_executions"]
    .map((table) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
