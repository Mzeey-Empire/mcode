import "reflect-metadata";
import { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import type { ExecutionSemanticOperation } from "../../execution/execution-worker-handler.js";
import { APPEND_GROUP_LIMITS, selectAppendGroup, type QueuedCanonicalWrite } from "../canonical-append-group.js";
import { CanonicalExecutionSemanticWriter } from "../canonical-execution-semantic-writer.js";
import { CanonicalAgentWriterClient } from "../canonical-agent-writer-client.js";

const NOW = "2026-09-25T12:00:00.000Z";

function append(index: number, ordinal = 2): ExecutionSemanticOperation {
  const execution = { threadId: `thread-${index}`, turnId: `turn-${index}`,
    executionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` };
  const itemId = `item-${index}-${ordinal}`;
  return {
    execution, lease: { ownerEpoch: 1, workerIndex: index, workerGeneration: 1, leaseId: `lease-${index}` },
    operationId: `lease-${index}:${ordinal}`, ordinal,
    mutation: { kind: "append-events", phase: "running", nativeCursor: null, events: [{
      eventId: `${execution.executionId}:item-${ordinal}`, routing: { ...execution, itemId },
      sourceProviderId: "codex", sourceIdentities: [],
      payload: { type: "item.recorded", item: { id: itemId, threadId: execution.threadId,
        turnId: execution.turnId, kind: "message", providerIdentities: [],
        payload: { projection: "message", content: "Durable event" }, createdAt: NOW, updatedAt: NOW } },
    }] },
  };
}

function queued(operation: ExecutionSemanticOperation, bytes = 100): QueuedCanonicalWrite {
  return { bytes, request: { kind: "semantic-transact", requestId: `request-${operation.operationId}`,
    operationId: operation.operationId, executionId: operation.execution.executionId, operation } };
}

describe("bounded append groups", () => {
  it("preserves FIFO across repeated identities, controls, mismatched routing, and reclassification", () => {
    const first = queued(append(1));
    const second = queued(append(2));
    const repeated = queued(append(1, 3));
    const control = queued({ ...append(3), mutation: { kind: "checkpoint", phase: "running", nativeCursor: null } });
    expect(selectAppendGroup([first, second, repeated, queued(append(4))])).toEqual([first.request, second.request]);
    expect(selectAppendGroup([first, control, second])).toEqual([first.request]);
    const mismatched: QueuedCanonicalWrite = { ...second, request: { ...second.request, executionId: "wrong" } };
    expect(selectAppendGroup([first, mismatched, queued(append(4))])).toEqual([first.request]);
    const source = append(3);
    if (source.mutation.kind !== "append-events") throw new Error("Expected append");
    const reclassify = queued({ ...source, mutation: { ...source.mutation,
      parentLive: { text: { kind: "reclassify", expectedText: "" } } } });
    expect(selectAppendGroup([first, reclassify, second])).toEqual([first.request]);
  });

  it("caps count and bytes without consuming the rest of the queue", () => {
    const queue = Array.from({ length: 10 }, (_, index) => queued(append(index + 1)));
    expect(selectAppendGroup(queue)).toHaveLength(APPEND_GROUP_LIMITS.operations);
    expect(queue).toHaveLength(10);
    expect(selectAppendGroup([queued(append(1), APPEND_GROUP_LIMITS.bytes), queued(append(2))])).toHaveLength(1);
  });
});

describe("file-backed grouped semantic commits", () => {
  let directory: string;
  let db: Database;
  let observer: Database;
  let writer: CanonicalExecutionSemanticWriter;
  let published: string[];

  beforeEach(async () => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-append-group-"));
    const path = NodePath.join(directory, "app.sqlite");
    db = openDatabase({ dbPath: path });
    observer = new Database(path, { strict: true, readonly: true });
    published = [];
    writer = new CanonicalExecutionSemanticWriter(db, (events) => published.push(...events.map((event) => event.eventId)));
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("workspace-1", "Fixture", "C:/fixture", NOW, NOW);
    for (const index of [1, 2]) {
      const operation = append(index);
      db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(operation.execution.threadId, "workspace-1", "Fixture", "main", "codex", NOW, NOW);
      expect(await writer.transact({ ...operation, ordinal: 1, operationId: `lease-${index}:1`, mutation: {
        kind: "begin", providerId: "codex", input: {
          thread: { id: operation.execution.threadId, workspaceId: "workspace-1", providerId: "codex", createdAt: NOW },
          turnId: operation.execution.turnId, executionId: operation.execution.executionId,
          permissionMode: "supervised", providerIdentities: [],
          userMessage: { kind: "create", messageId: `user-${index}`, content: "Question", sequence: 1 },
        },
      } })).toMatchObject({ kind: "committed" });
    }
    published.length = 0;
    // A fixed clock makes the transaction tests independent of host load; SQLite remains real.
    vi.spyOn(performance, "now").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    observer.close(true);
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  function persistedAppends() {
    return observer.query("SELECT operation_id FROM canonical_writer_operation_receipts WHERE kind = 'semantic:append-events' ORDER BY execution_id").all();
  }

  it("returns each request's publications only after the outer commit is visible to another connection", () => {
    const results = writer.transactAppendGroup([append(1), append(2)]);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.receipt.kind)).toEqual(["committed", "committed"]);
    expect(db.inTransaction).toBe(false);
    expect(persistedAppends()).toEqual([{ operation_id: "lease-1:2" }, { operation_id: "lease-2:2" }]);
    expect(published).toEqual([]);
    for (const result of results) {
      expect(result.publications.flat().every((event) => event.routing.executionId === result.operation.execution.executionId)).toBe(true);
      expect(result.publications.flat().length).toBeGreaterThan(0);
    }
  });

  it("rolls back a conflicting append's savepoint while committing its peer", () => {
    const conflicting = append(1);
    if (conflicting.mutation.kind !== "append-events") throw new Error("Expected append");
    const results = writer.transactAppendGroup([{ ...conflicting, mutation: { ...conflicting.mutation,
      parentLive: { text: { kind: "unchanged" } } } }, append(2)]);
    expect(results.map((result) => result.receipt.kind)).toEqual(["conflict", "committed"]);
    expect(results[0]?.publications).toEqual([]);
    expect(persistedAppends()).toEqual([{ operation_id: "lease-2:2" }]);
    expect(observer.query("SELECT event_id FROM canonical_agent_events WHERE event_id = ?")
      .get(`${conflicting.execution.executionId}:item-2`)).toBeNull();
  });

  it("discards all results and publications when the physical outer commit fails", () => {
    db.exec(`CREATE TABLE group_commit_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE group_commit_child (parent_id INTEGER REFERENCES group_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_group_commit AFTER INSERT ON canonical_writer_operation_receipts
      WHEN NEW.kind = 'semantic:append-events'
      BEGIN INSERT INTO group_commit_child(parent_id) VALUES (999); END;`);
    expect(() => writer.transactAppendGroup([append(1), append(2)])).toThrow();
    expect(db.inTransaction).toBe(false);
    expect(persistedAppends()).toEqual([]);
    expect(published).toEqual([]);
    db.exec("DROP TRIGGER fail_group_commit");
    expect(writer.transactAppendGroup([append(1), append(2)]).map((result) => result.receipt.kind))
      .toEqual(["committed", "committed"]);
  });

  it("replays a lost acknowledgement with the original receipts and no duplicate rows", () => {
    const initial = writer.transactAppendGroup([append(1), append(2)]);
    const replay = writer.transactAppendGroup([append(1), append(2)]);
    expect(replay).toEqual(initial);
    expect(persistedAppends()).toHaveLength(2);
    expect(published).toEqual([]);
  });

  it("returns the consumed prefix when the elapsed limit ends the transaction", () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(APPEND_GROUP_LIMITS.elapsedMs);
    const operations = [append(1), append(2)];
    const first = writer.transactAppendGroup(operations);
    expect(first).toHaveLength(1);
    expect(writer.transactAppendGroup(operations.slice(first.length))).toHaveLength(1);
    expect(persistedAppends()).toHaveLength(2);
  });

  it("correlates concurrent worker requests and publishes only rows visible from a separate connection", async () => {
    vi.restoreAllMocks();
    const client = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const observed: string[] = [];
    try {
      const operations = [append(1), append(2)];
      const receipts = await Promise.all(operations.map(async (operation) => {
        const receipt = await client.transactSemantic(operation, (events) => {
          for (const event of events) {
            expect(event.routing.executionId).toBe(operation.execution.executionId);
            expect(observer.query("SELECT event_id FROM canonical_agent_events WHERE event_id = ?")
              .get(event.eventId)).toEqual({ event_id: event.eventId });
            expect(observer.query("SELECT operation_id FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
              .get(operation.execution.executionId, operation.operationId)).toEqual({ operation_id: operation.operationId });
          }
          observed.push(`publication:${operation.operationId}`);
        });
        observed.push(`receipt:${operation.operationId}`);
        return receipt;
      }));
      expect(receipts.map((receipt) => receipt.kind)).toEqual(["committed", "committed"]);
      for (const operation of operations) {
        expect(observed.indexOf(`publication:${operation.operationId}`)).toBeGreaterThanOrEqual(0);
        expect(observed.indexOf(`publication:${operation.operationId}`)).toBeLessThan(observed.indexOf(`receipt:${operation.operationId}`));
      }
      expect(persistedAppends()).toHaveLength(2);
      expect(observer.query("SELECT id, thread_id FROM canonical_agent_items WHERE id IN ('item-1-2', 'item-2-2') ORDER BY id").all())
        .toEqual([{ id: "item-1-2", thread_id: "thread-1" }, { id: "item-2-2", thread_id: "thread-2" }]);
    } finally {
      await client.close();
    }
  });

  it("keeps a concurrent worker peer usable when one execution's database write fails", async () => {
    vi.restoreAllMocks();
    db.exec(`CREATE TRIGGER reject_first_append BEFORE INSERT ON canonical_writer_operation_receipts
      WHEN NEW.kind = 'semantic:append-events' AND NEW.execution_id = '${append(1).execution.executionId}'
      BEGIN SELECT RAISE(ABORT, 'execution write failed'); END;`);
    const client = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const seen: string[] = [];
    try {
      const results = await Promise.allSettled([1, 2].map((index) => client.transactSemantic(append(index),
        (events) => seen.push(...events.map((event) => event.routing.executionId)))));
      expect(results[0]).toMatchObject({ status: "rejected" });
      expect(results[1]).toMatchObject({ status: "fulfilled", value: { kind: "committed" } });
      expect(seen).not.toContain(append(1).execution.executionId);
      expect(seen).toContain(append(2).execution.executionId);
      expect(persistedAppends()).toEqual([{ operation_id: "lease-2:2" }]);
    } finally {
      await client.close();
    }
  });

  it("rejects an unserializable queued append without losing a healthy worker peer", async () => {
    vi.restoreAllMocks();
    const invalid = append(1);
    if (invalid.mutation.kind !== "append-events") throw new Error("Expected append");
    const operation = { ...invalid, mutation: { ...invalid.mutation, nativeCursor: 1n } };
    const client = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    try {
      const results = await Promise.allSettled([
        client.transactSemantic(operation, () => {}), client.transactSemantic(append(2), () => {}),
      ]);
      expect(results[0]).toMatchObject({ status: "rejected" });
      expect(results[1]).toMatchObject({ status: "fulfilled", value: { kind: "committed" } });
      expect(persistedAppends()).toEqual([{ operation_id: "lease-2:2" }]);
    } finally {
      await client.close();
    }
  });
});
