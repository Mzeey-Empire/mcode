import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import type { ExecutionSemanticOperation } from "../../execution/execution-worker-handler.js";
import { CanonicalAgentWriterClient } from "../canonical-agent-writer-client.js";
import { CanonicalExecutionWriterPort } from "../canonical-execution-writer-port.js";

const NOW = "2026-09-24T10:00:00.000Z";
const THREAD_ID = "semantic-worker-thread";
const TURN_ID = "semantic-worker-turn";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000177";
const execution = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID } as const;
const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "semantic-worker-lease" } as const;

function beginOperation(): ExecutionSemanticOperation {
  return {
    operationId: `${lease.leaseId}:1`, execution, lease, ordinal: 1,
    mutation: {
      kind: "begin", providerId: "codex",
      input: {
        thread: { id: THREAD_ID, workspaceId: "semantic-worker-workspace", providerId: "codex", createdAt: NOW },
        turnId: TURN_ID, executionId: EXECUTION_ID, permissionMode: "supervised", providerIdentities: [],
        userMessage: { kind: "create", messageId: "semantic-worker-user", content: "Question", sequence: 1 },
      },
    },
  };
}

describe("execution semantic writer transport", () => {
  let directory: string;
  let db: Database;
  let writer: CanonicalAgentWriterClient | undefined;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-execution-writer-"));
    db = openDatabase({ dbPath: NodePath.join(directory, "app.sqlite") });
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("semantic-worker-workspace", "Workspace", directory, NOW, NOW);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(THREAD_ID, "semantic-worker-workspace", "Thread", "main", "codex", NOW, NOW);
  });

  afterEach(async () => {
    await writer?.close();
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("commits and replays a semantic start through the dedicated SQLite worker", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const published: string[] = [];
    const port = new CanonicalExecutionWriterPort(writer, (events) => {
      published.push(...events.map((event) => event.eventId));
    });
    const operation = beginOperation();

    const first = await port.transact(operation);
    expect(first).toMatchObject({ kind: "committed", operationId: operation.operationId });
    expect(db.prepare("SELECT content FROM messages WHERE id = ?").get("semantic-worker-user"))
      .toEqual({ content: "Question" });
    expect(published.length).toBeGreaterThan(0);

    published.length = 0;
    expect(await port.transact(operation)).toEqual(first);
    expect(published.length).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?").get("semantic-worker-user"))
      .toEqual({ count: 1 });
  });

  it("does not acknowledge a failed database write and accepts a clean retry", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const port = new CanonicalExecutionWriterPort(writer, () => {});
    db.run(`CREATE TRIGGER reject_semantic_start BEFORE INSERT ON canonical_agent_events
      BEGIN SELECT RAISE(FAIL, 'injected write failure'); END`);

    await expect(port.transact(beginOperation())).rejects.toThrow("Canonical writer write-failed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?").get("semantic-worker-user"))
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ count: 0 });

    db.run("DROP TRIGGER reject_semantic_start");
    expect(await port.transact(beginOperation())).toMatchObject({ kind: "committed" });
  });

  it("replays a durable semantic receipt after the writer loses its reply", async () => {
    let dropReply = true;
    const createWorker = (): Worker => {
      const worker = new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" });
      return new Proxy(worker, {
        set(target, property, value) {
          if (property !== "onmessage" || typeof value !== "function") return Reflect.set(target, property, value);
          target.onmessage = (message) => {
            if (dropReply && message.data.kind === "semantic-transacted") {
              dropReply = false;
              target.terminate();
              return;
            }
            value(message);
          };
          return true;
        },
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"), createWorker);
    const published: string[] = [];
    const port = new CanonicalExecutionWriterPort(writer, (events) => {
      published.push(...events.map((event) => event.eventId));
    });

    expect(await port.transact(beginOperation())).toMatchObject({ kind: "committed" });
    expect(dropReply).toBe(false);
    expect(published.length).toBeGreaterThan(0);
    expect(new Set(published).size).toBe(published.length);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?").get("semantic-worker-user"))
      .toEqual({ count: 1 });
  });
});
