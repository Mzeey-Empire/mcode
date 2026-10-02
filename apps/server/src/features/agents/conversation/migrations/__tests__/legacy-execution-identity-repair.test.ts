import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { Database } from "bun:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SetThreadSubscriptionsResultSchema } from "@mcode/contracts";
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

describe("converted legacy execution identity repair", () => {
  let db: Database;
  beforeEach(() => { db = openMemoryDatabase(); });
  afterEach(() => { db.close(true); });

  it("repairs completed conversion with the current import identity and preserves materialized content and counters", async () => {
    const expected = await seedConverted(db);
    const materializer = new ConversationDisplayMaterializationStore(db);
    while (!materializer.runBatch()) { /* Complete the existing bounded materialization. */ }
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
    "UPDATE canonical_legacy_message_provenance SET mapping_status = 'ambiguous' WHERE message_id = 'user-v1'",
    "UPDATE messages SET role = 'assistant' WHERE id = 'user-v1'",
    "UPDATE canonical_agent_items SET payload_json = json_set(payload_json, '$.message.role', 'assistant') WHERE id = 'message:user-v1'",
    "UPDATE messages SET outcome_execution_id = 'legacy-execution:user-v1' WHERE id = 'assistant-v1'",
    `INSERT INTO canonical_writer_operation_receipts (execution_id, operation_id, kind, input_hash, receipt_json)
      VALUES ('legacy-execution:user-v1', 'unexpected-owner', 'commit', 'hash', '{}')`,
  ])("rejects unsupported converted ownership: %s", async (corruption) => {
    await seedConverted(db);
    downgrade(db);
    db.exec(corruption);
    const rows = preservedRows(db);
    expect(() => new LegacyConversationMigrationStore(db).runBatch()).toThrow(/legacy.*execution.*repair/i);
    expect(execution(db)).toBe("legacy-execution:user-v1");
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
    addClient(client);
    const subscribe = () => routePushSubscriptionRpc("push.setThreadSubscriptions",
      { threadIds: ["healthy-thread", "thread-v1"] }, { canonicalSink: canonical }, client);
    expect(subscribe).toThrow(/uuid/i);
    const migration = new LegacyConversationMigration(writer);
    expect(await migration.runToCompletion()).toMatchObject({ migratedMessages: 2, completed: true });
    const result = SetThreadSubscriptionsResultSchema().parse(subscribe());
    expect(result.canonicalRecoveries.map((recovery) => recovery.threadId)).toEqual(["healthy-thread", "thread-v1"]);
    expect(execution(reader)).toBe(expected);
    expect(canonical.loadConversationProjection("thread-v1", 10).messages.map((message) => message.content))
      .toEqual(["Question", "Answer"]);
    expect(await migration.runToCompletion()).toMatchObject({ migratedMessages: 2, completed: true });
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
  return z.object({ execution_id: z.string() }).parse(db.query("SELECT execution_id FROM canonical_agent_turns WHERE id = ?")
    .get(`legacy-turn:user-${version}`)).execution_id;
}

function preservedRows(db: Database): unknown[] {
  return ["messages", "canonical_agent_items", "canonical_legacy_message_provenance", "canonical_legacy_migration_checkpoints",
    "canonical_conversation_display_mappings", "thought_segments", "tool_call_records", "hook_executions"]
    .map((table) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
