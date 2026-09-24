import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import type { ExecutionSemanticOperation } from "../../execution/execution-worker-handler.js";
import { ExecutionWorkerHandler } from "../../execution/execution-worker-handler.js";
import { CanonicalExecutionSemanticWriter } from "../canonical-execution-semantic-writer.js";
import type { DataOnlyParentTurnStartInput } from "../canonical-parent-turn-write.js";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-09-24T10:00:00.000Z";
const execution = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID } as const;
const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "lease-1" } as const;

function seedThread(db: Database): void {
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("workspace-1", "Workspace", "C:/fixture", NOW, NOW);
  db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(THREAD_ID, "workspace-1", "Thread", "main", "codex", NOW, NOW);
}

function startInput(): DataOnlyParentTurnStartInput {
  return {
    thread: { id: THREAD_ID, workspaceId: "workspace-1", providerId: "codex", createdAt: NOW },
    turnId: TURN_ID,
    executionId: EXECUTION_ID,
    permissionMode: "supervised",
    providerIdentities: [],
    userMessage: { kind: "create", messageId: "user-1", content: "Question", sequence: 1 },
  };
}

function event() {
  return {
    eventId: `${EXECUTION_ID}:item-1`,
    routing: { ...execution, itemId: "item-1" },
    sourceProviderId: "codex",
    sourceIdentities: [],
    payload: {
      type: "item.recorded" as const,
      item: {
        id: "item-1",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        kind: "message" as const,
        providerIdentities: [],
        payload: { projection: "message", content: "Event" },
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  };
}

function toolNarrative(messageId: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    kind: "toolCall" as const,
    sequence: 2,
    sortOrder: index,
    record: {
      id: `tool-${index}`,
      message_id: messageId,
      parent_tool_call_id: null,
      tool_name: "Read",
      input_summary: `file-${index}`,
      output_summary: "ok",
      status: "completed" as const,
      started_at: NOW,
      completed_at: NOW,
      sort_order: index,
    },
  }));
}

function operation(ordinal: number, mutation: ExecutionSemanticOperation["mutation"]): ExecutionSemanticOperation {
  return { operationId: `${lease.leaseId}:${ordinal}`, execution, lease, ordinal, mutation };
}

describe("CanonicalExecutionSemanticWriter through ExecutionWorkerHandler", () => {
  let directory: string;
  let path: string;
  let db: Database;
  let published: string[];
  let writer: CanonicalExecutionSemanticWriter;
  let handler: ExecutionWorkerHandler;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-semantic-write-"));
    path = NodePath.join(directory, "mcode.db");
    db = openDatabase({ dbPath: path });
    seedThread(db);
    published = [];
    writer = new CanonicalExecutionSemanticWriter(db, (events) => {
      published.push(...events.map((item) => item.eventId));
    });
    handler = new ExecutionWorkerHandler(writer);
  });

  afterEach(() => {
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  async function send(ordinal: number, command: Parameters<ExecutionWorkerHandler["handle"]>[0]["command"]) {
    return (await handler.handle({ requestId: ordinal, execution, lease, ordinal, command })).result;
  }

  it("commits start, event, and finalization with durable receipts across a database reload", async () => {
    const begin = operation(1, { kind: "begin", providerId: "codex", input: startInput() });
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    expect((await send(2, { kind: "event", events: [event()] })).kind).toBe("committed");
    const staged = new MessageRepo(db).create(THREAD_ID, "assistant", "Answer", 2, undefined, undefined, undefined, "model", true);
    const finish = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [],
      outcome: "completed" as const,
      projection: { message: staged, narrative: [] },
    };
    const terminal = await send(3, { kind: "finalize", outcome: "completed", input: finish });
    expect(terminal.kind).toBe("committed");
    expect(published).toContain(`${EXECUTION_ID}:turn.completed`);

    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalExecutionSemanticWriter(db, () => {});
    expect(await writer.transact(begin)).toMatchObject({ kind: "committed", operationId: "lease-1:1" });
    expect(await writer.transact(operation(1, {
      kind: "begin",
      providerId: "codex",
      input: { ...startInput(), permissionMode: "full" },
    }))).toEqual({ kind: "conflict", operationId: "lease-1:1" });
    expect(await writer.transact(operation(3, { kind: "finish", outcome: "completed", input: finish })))
      .toEqual(terminal);
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: "completed" });
    expect(db.prepare("SELECT kind, receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "semantic:head")).toMatchObject({ kind: "semantic-head" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND kind != 'semantic-publication'").get(EXECUTION_ID))
      .toEqual({ count: 4 });
  });

  it("rejects stale leases and skipped ordinals while checkpointing without a new event", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const eventsBefore = db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE execution_id = ?").get(EXECUTION_ID);
    const append = operation(2, { kind: "append-events", events: [event()] });
    expect(await writer.transact({ ...append, lease: { ...lease, ownerEpoch: 2, leaseId: "lease-2" }, operationId: "lease-2:2" }))
      .toEqual({ kind: "conflict", operationId: "lease-2:2" });
    expect(await writer.transact({ ...append, ordinal: 3, operationId: "lease-1:3" }))
      .toEqual({ kind: "conflict", operationId: "lease-1:3" });
    expect(await send(2, { kind: "checkpoint", phase: "running", nativeCursor: null }))
      .toMatchObject({ kind: "committed", operationId: "lease-1:2" });
    expect(await send(3, { kind: "effect-result", effectId: "unsupported", settled: true }))
      .toEqual({ kind: "rejected", reason: "writer-conflict" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual(eventsBefore);
    expect(db.prepare("SELECT receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "semantic:head")).toMatchObject({ receipt_json: expect.stringContaining('"ordinal":2') });
    expect(db.prepare("SELECT phase, native_cursor_json FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ phase: "running", native_cursor_json: null });
  });

  it("rolls back terminal checkpoint and semantic receipt together when receipt storage fails", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const staged = new MessageRepo(db).create(THREAD_ID, "assistant", "Answer", 2, undefined, undefined, undefined, "model", true);
    const finish = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [],
      outcome: "completed" as const,
      projection: { message: staged, narrative: [] },
    };
    db.run("CREATE TRIGGER fail_semantic_receipt BEFORE UPDATE OF kind ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:finish' BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
    await expect(send(2, { kind: "finalize", outcome: "completed", input: finish })).rejects.toThrow("receipt unavailable");
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: null });
    expect(db.prepare("SELECT kind FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "lease-1:2")).toEqual({ kind: "semantic:finish-pending" });
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, staged.id)).toBeNull();
    expect(published).not.toContain(`${EXECUTION_ID}:turn.completed`);

    db.run("DROP TRIGGER fail_semantic_receipt");
    expect((await send(2, { kind: "finalize", outcome: "completed", input: finish })).kind).toBe("committed");
  });

  it("rolls back an event and its checkpoint when its semantic receipt cannot be stored", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const before = db.prepare("SELECT last_durable_sequence FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID);
    db.run("CREATE TRIGGER fail_semantic_event_receipt BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:append-events' BEGIN SELECT RAISE(ABORT, 'event receipt unavailable'); END");
    await expect(send(2, { kind: "event", events: [event()] })).rejects.toThrow("event receipt unavailable");
    expect(db.prepare("SELECT last_durable_sequence FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual(before);
    expect(db.prepare("SELECT id FROM canonical_agent_items WHERE id = ?").get("item-1")).toBeNull();
    expect(published).not.toContain(event().eventId);

    db.run("DROP TRIGGER fail_semantic_event_receipt");
    expect((await send(2, { kind: "event", events: [event()] })).kind).toBe("committed");
    expect(published).toContain(event().eventId);
  });

  it("replays committed event publication after a failed publisher and database reopen", async () => {
    let failPublication = false;
    writer = new CanonicalExecutionSemanticWriter(db, (events) => {
      if (failPublication) throw new Error("publisher unavailable");
      published.push(...events.map((item) => item.eventId));
    });
    handler = new ExecutionWorkerHandler(writer);
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    failPublication = true;
    await expect(send(2, { kind: "event", events: [event()] })).rejects.toThrow("publisher unavailable");
    expect(db.prepare("SELECT event_id FROM canonical_agent_events WHERE event_id = ?").get(event().eventId))
      .toEqual({ event_id: event().eventId });
    const receipt = db.prepare("SELECT receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "lease-1:2") as { receipt_json: string };
    expect(receipt.receipt_json.length).toBeLessThan(256);

    db.close(true);
    db = openDatabase({ dbPath: path });
    published = [];
    writer = new CanonicalExecutionSemanticWriter(db, (events) => {
      published.push(...events.map((item) => item.eventId));
    });
    expect(await writer.transact(operation(2, { kind: "append-events", events: [event()] })))
      .toMatchObject({ kind: "committed", operationId: "lease-1:2" });
    expect(published).toContain(event().eventId);
  });

  it("replays terminal publication after its checkpoint committed and the publisher failed", async () => {
    writer = new CanonicalExecutionSemanticWriter(db, (events) => {
      if (events.some((item) => item.eventId === `${EXECUTION_ID}:turn.completed`)) {
        throw new Error("terminal publisher unavailable");
      }
      published.push(...events.map((item) => item.eventId));
    });
    handler = new ExecutionWorkerHandler(writer);
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const staged = new MessageRepo(db).create(THREAD_ID, "assistant", "Answer", 2, undefined, undefined, undefined, "model", true);
    const finish = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [],
      outcome: "completed" as const,
      projection: { message: staged, narrative: [] },
    };
    await expect(send(2, { kind: "finalize", outcome: "completed", input: finish }))
      .rejects.toThrow("terminal publisher unavailable");
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: "completed" });
    expect(db.prepare("SELECT kind FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "lease-1:2")).toEqual({ kind: "semantic:finish" });

    db.close(true);
    db = openDatabase({ dbPath: path });
    published = [];
    writer = new CanonicalExecutionSemanticWriter(db, (events) => {
      published.push(...events.map((item) => item.eventId));
    });
    expect(await writer.transact(operation(2, { kind: "finish", outcome: "completed", input: finish })))
      .toMatchObject({ kind: "committed", operationId: "lease-1:2" });
    expect(published).toContain(`${EXECUTION_ID}:turn.completed`);
  });

  it("replays earlier terminal batches after publication failed before finalization", async () => {
    let failTerminalBatch = false;
    writer = new CanonicalExecutionSemanticWriter(db, (events) => {
      if (failTerminalBatch) {
        failTerminalBatch = false;
        throw new Error("first terminal batch unavailable");
      }
      published.push(...events.map((item) => item.eventId));
    });
    handler = new ExecutionWorkerHandler(writer);
    const start = await send(1, { kind: "start", providerId: "codex", input: startInput() });
    expect(start.kind).toBe("committed");
    if (start.kind !== "committed") throw new Error("Canonical start did not commit");
    const staged = new MessageRepo(db).create(THREAD_ID, "assistant", "Answer", 2, undefined, undefined, undefined, "model", true);
    const finish = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      providerId: "codex",
      providerIdentities: [],
      outcome: "completed" as const,
      projection: { message: staged, narrative: toolNarrative(staged.id, 100) },
    };
    failTerminalBatch = true;
    await expect(send(2, { kind: "finalize", outcome: "completed", input: finish }))
      .rejects.toThrow("first terminal batch unavailable");
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: null });
    expect(db.prepare("SELECT kind FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "lease-1:2")).toEqual({ kind: "semantic:finish-pending" });
    const priorChunks = db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND kind = 'semantic-publication'")
      .get(EXECUTION_ID) as { count: number };
    expect(priorChunks.count).toBeGreaterThan(0);
    expect(await writer.transact(operation(2, {
      kind: "finish",
      outcome: "completed",
      input: { ...finish, error: "different input" },
    }))).toEqual({ kind: "conflict", operationId: "lease-1:2" });

    db.close(true);
    db = openDatabase({ dbPath: path });
    published = [];
    writer = new CanonicalExecutionSemanticWriter(db, (events) => {
      published.push(...events.map((item) => item.eventId));
    });
    expect(await writer.transact(operation(2, { kind: "finish", outcome: "completed", input: finish })))
      .toMatchObject({ kind: "committed", operationId: "lease-1:2" });
    const terminalEventCount = db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE execution_id = ? AND accepted_sequence > ?")
      .get(EXECUTION_ID, start.durableRevision) as { count: number };
    expect(published).toContain(`${EXECUTION_ID}:turn.completed`);
    expect(published).toHaveLength(terminalEventCount.count);
  });

  it("rolls back the canonical start and user message when the begin receipt fails", async () => {
    db.run("CREATE TRIGGER fail_semantic_begin_receipt BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:begin' BEGIN SELECT RAISE(ABORT, 'begin receipt unavailable'); END");
    await expect(send(1, { kind: "start", providerId: "codex", input: startInput() }))
      .rejects.toThrow("begin receipt unavailable");
    expect(db.prepare("SELECT execution_id FROM canonical_agent_turns WHERE execution_id = ?").get(EXECUTION_ID)).toBeNull();
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, "user-1")).toBeNull();
    expect(db.prepare("SELECT operation_id FROM canonical_writer_operation_receipts WHERE execution_id = ?")
      .all(EXECUTION_ID)).toEqual([]);
    expect(published).toEqual([]);

    db.run("DROP TRIGGER fail_semantic_begin_receipt");
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
  });

  it("keeps publication separate while a batched finish starts another execution", async () => {
    const otherExecution = {
      threadId: "thread-2",
      turnId: "turn-2",
      executionId: "00000000-0000-4000-8000-000000000002",
    };
    const otherLease = { ...lease, workerIndex: 1, leaseId: "lease-2" };
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(otherExecution.threadId, "workspace-1", "Second", "main", "codex", NOW, NOW);
    let finishing = false;
    let secondStartRequested = false;
    let secondStart: Promise<unknown> | null = null;
    writer = new CanonicalExecutionSemanticWriter(db, (events) => {
      published.push(...events.map((item) => item.eventId));
      if (!finishing || secondStartRequested) return;
      secondStartRequested = true;
      secondStart = handler.handle({
        requestId: 1,
        execution: otherExecution,
        lease: otherLease,
        ordinal: 1,
        command: {
          kind: "start",
          providerId: "codex",
          input: {
            ...startInput(),
            thread: { ...startInput().thread, id: otherExecution.threadId },
            turnId: otherExecution.turnId,
            executionId: otherExecution.executionId,
            userMessage: { kind: "create", messageId: "user-2", content: "Second question", sequence: 1 },
          },
        },
      }).then((reply) => reply.result);
    });
    handler = new ExecutionWorkerHandler(writer);
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const staged = new MessageRepo(db).create(THREAD_ID, "assistant", "Answer", 2, undefined, undefined, undefined, "model", true);
    const narrative = toolNarrative(staged.id, 100);
    finishing = true;
    expect((await send(2, {
      kind: "finalize",
      outcome: "completed",
      input: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        executionId: EXECUTION_ID,
        providerId: "codex",
        providerIdentities: [],
        outcome: "completed",
        projection: { message: staged, narrative },
      },
    })).kind).toBe("committed");
    expect(await secondStart).toMatchObject({ kind: "committed", operationId: "lease-2:1" });
    expect(published).toContain(`${EXECUTION_ID}:turn.completed`);
    expect(published.some((eventId) => eventId.startsWith(otherExecution.executionId))).toBe(true);
    const terminalReceipt = db.prepare("SELECT receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "lease-1:2") as { receipt_json: string };
    expect(terminalReceipt.receipt_json.length).toBeLessThan(256);
    const chunks = db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND kind = 'semantic-publication'")
      .get(EXECUTION_ID) as { count: number };
    expect(chunks.count).toBeGreaterThan(1);
    const chunkSize = db.prepare("SELECT MAX(json_array_length(receipt_json)) AS size FROM canonical_writer_operation_receipts WHERE execution_id = ? AND kind = 'semantic-publication'")
      .get(EXECUTION_ID) as { size: number };
    expect(chunkSize.size).toBeLessThanOrEqual(64);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE kind = 'semantic-head'").get())
      .toEqual({ count: 2 });
  });
});
