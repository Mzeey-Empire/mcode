import "reflect-metadata";
import type { Database } from "bun:sqlite";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEventType, type ParentNarrativeRecoveryItem } from "@mcode/contracts";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import type { CanonicalAgentEventDraft } from "../canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../canonical-agent-writer-client.js";
import { CanonicalExecutionWriterPort } from "../canonical-execution-writer-port.js";
import { ExecutionLivePublicationRelease } from "../execution-live-publication-release.js";
import { AgentEventPublicationRegistry } from "../../orchestration/agent-event-publication-registry.js";
import type { CanonicalWriterResponse } from "../canonical-agent-writer-protocol.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import type { ExecutionSemanticOperation } from "../../execution/execution-worker-handler.js";

const THREAD_ID = "writer-thread";
const TURN_ID = "writer-turn";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000176";
const NOW = "2026-09-24T12:00:00.000Z";

function workerDroppingReply(kind: CanonicalWriterResponse["kind"]): Worker {
  const worker = new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" });
  return new Proxy(worker, {
    set(target, property, value) {
      if (property !== "onmessage" || typeof value !== "function") return Reflect.set(target, property, value);
      target.onmessage = (message) => {
        if (message.data.kind === kind) {
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
}

function events(): CanonicalAgentEventDraft[] {
  const sourceIdentities = [{ providerId: "codex" as const, scope: "thread" as const, value: "native-writer-thread", provenance: "native" as const }];
  return [
    {
      eventId: `${EXECUTION_ID}:thread`,
      routing: { threadId: THREAD_ID, executionId: EXECUTION_ID },
      sourceProviderId: "codex",
      sourceIdentities,
      payload: {
        type: "thread.recorded",
        thread: {
          id: THREAD_ID,
          workspaceId: "writer-workspace",
          rootThreadId: THREAD_ID,
          providerId: "codex",
          providerIdentities: sourceIdentities,
          activityState: "Active",
          conversationRevision: 0,
          rosterRevision: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    },
    {
      eventId: `${EXECUTION_ID}:turn`,
      routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID },
      sourceProviderId: "codex",
      sourceIdentities,
      payload: {
        type: "turn.created",
        turn: {
          id: TURN_ID,
          threadId: THREAD_ID,
          status: "Pending",
          trigger: { kind: "user" },
          permissionMode: "supervised",
          approvalReviewMode: "manual",
          approvalReviewReason: "manual-requested",
          providerIdentities: sourceIdentities,
          startedAt: null,
          endedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    },
    {
      eventId: `${EXECUTION_ID}:started`,
      routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID },
      sourceProviderId: "codex",
      sourceIdentities,
      payload: { type: "turn.started", startedAt: NOW },
    },
  ];
}

function recoveryToolCall(id = "writer-recovery-tool"): ParentNarrativeRecoveryItem {
  return {
    kind: "toolCall",
    record: {
      id,
      message_id: "",
      parent_tool_call_id: null,
      tool_name: "Read",
      display_name: null,
      provider_agent_key: null,
      subagent_identity_key: null,
      subagent_provider_name: null,
      subagent_prompt: null,
      subagent_type: null,
      subagent_agent_id: null,
      subagent_duration_ms: null,
      model: null,
      reasoning_effort: null,
      input_summary: "a file",
      output_summary: "read",
      output_total_bytes: null,
      output_artifact_path: null,
      exit_code: null,
      status: "completed",
      started_at: NOW,
      completed_at: NOW,
      sort_order: 0,
    },
  };
}

describe("canonical SQLite writer", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let writer: CanonicalAgentWriterClient | undefined;

  beforeEach(async () => {
    tempDir = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-canonical-writer-"));
    dbPath = NodePath.join(tempDir, "app.sqlite");
    db = openDatabase({ dbPath });
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("writer-workspace", "Writer test", tempDir, NOW, NOW);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(THREAD_ID, "writer-workspace", "Writer thread", "main", "codex", NOW, NOW);
  });

  afterEach(async () => {
    await writer?.close();
    db.close(true);
    await NodeFSPromises.rm(tempDir, { recursive: true, force: true });
  });

  it("replays the original committed receipt and full envelopes", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    const first = await writer.commit("writer-operation-1", batch);
    expect(first).toMatchObject({ outcome: "committed", acceptedThrough: 3, durableThrough: 3 });
    expect(first.events.map((event) => event.eventId)).toEqual(batch.events.map((event) => event.eventId));
    expect(first).not.toHaveProperty("canonicalDelivery");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 3 });

    const replay = await writer.commit("writer-operation-1", batch);
    expect(replay).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 1 });
  });

  it("recovers one durable live publication identity after a file-backed writer loses its reply", async () => {
    const execution = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID };
    const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "publication-lease" };
    const operation: ExecutionSemanticOperation = {
      operationId: "publication-lease:1", execution, lease, ordinal: 1,
      mutation: { kind: "begin", providerId: "codex", input: {
        thread: { id: THREAD_ID, workspaceId: "writer-workspace", providerId: "codex", createdAt: NOW },
        turnId: TURN_ID, executionId: EXECUTION_ID, permissionMode: "supervised", providerIdentities: [],
        userMessage: { kind: "create", messageId: "publication-user", content: "Question", sequence: 1 },
      } },
      livePublication: [{ after: "writer", event: {
        type: AgentEventType.TurnStarted, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
      } }],
    };
    let created = 0;
    const registry = new AgentEventPublicationRegistry();
    const published: string[] = [];
    registry.bind((event) => published.push(event.type));
    const release = new ExecutionLivePublicationRelease(registry);
    writer = new CanonicalAgentWriterClient(dbPath, () => created++ === 0
      ? workerDroppingReply("semantic-transacted")
      : new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" }));
    let port = new CanonicalExecutionWriterPort(writer, () => {}, release);

    const receipt = await port.transact(operation);
    expect(created).toBe(2);
    expect(published).toEqual([AgentEventType.TurnStarted]);
    expect(receipt).toMatchObject({ kind: "committed", livePublication: [{
      publicationId: "publication-lease:1:0", after: "writer",
      event: { type: AgentEventType.TurnStarted, turnExecutionId: EXECUTION_ID },
    }] });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?").get("publication-user"))
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, operation.operationId)).toEqual({ count: 1 });

    await writer.close();
    writer = new CanonicalAgentWriterClient(dbPath);
    port = new CanonicalExecutionWriterPort(writer, () => {}, release);
    expect(await port.transact(operation)).toEqual(receipt);
    expect(published).toEqual([AgentEventType.TurnStarted]);
  });

  it("replays durable semantic assistant text after a worker reply is lost", async () => {
    const execution = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID };
    const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "text-lease" };
    const start: ExecutionSemanticOperation = {
      operationId: "text-lease:1", execution, lease, ordinal: 1,
      mutation: {
        kind: "begin", providerId: "codex",
        input: {
          thread: { id: THREAD_ID, workspaceId: "writer-workspace", providerId: "codex", createdAt: NOW },
          turnId: TURN_ID, executionId: EXECUTION_ID,
          permissionMode: "supervised", providerIdentities: [],
          userMessage: { kind: "create", messageId: "text-user", content: "Question", sequence: 1 },
        },
      },
    };
    writer = new CanonicalAgentWriterClient(dbPath);
    expect(await writer.transactSemantic(start, () => {})).toMatchObject({ kind: "committed" });
    await writer.close();

    let created = 0;
    writer = new CanonicalAgentWriterClient(dbPath, () => created++ === 0
      ? workerDroppingReply("semantic-transacted")
      : new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" }));
    const textOperation: ExecutionSemanticOperation = {
      operationId: "text-lease:2", execution, lease, ordinal: 2,
      mutation: { kind: "append-assistant-text", inputs: [{ ...execution, sequence: 1, text: "Worker durable text" }] },
    };
    const receipt = await writer.transactSemantic(textOperation, () => {});
    expect(receipt).toMatchObject({ kind: "committed", operationId: "text-lease:2",
      assistantTextCheckpoint: { outcome: "committed", durableThrough: 1 } });
    expect(created).toBe(2);
    expect(new ParentAssistantTextCheckpointService(db).restore(EXECUTION_ID)).toBe("Worker durable text");
    expect(db.prepare("SELECT COUNT(*) AS count FROM parent_assistant_text_checkpoint_chunks WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ count: 1 });
    await expect(NodeFSPromises.stat(NodePath.join(tempDir, "app.sqlite.recovery", "parent-assistant-text")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await writer.close();

    writer = new CanonicalAgentWriterClient(dbPath);
    expect(await writer.transactSemantic(textOperation, () => {})).toEqual(receipt);
    expect(await writer.interruptWorkerLoss({ execution, lease, reason: "worker exited", recoveryIncidentId: "text-loss" },
      () => {})).toMatchObject({ kind: "committed", operationId: "text-lease:worker-lost" });
    expect(db.prepare("SELECT content FROM messages WHERE role = 'assistant' AND is_internal = 0").get())
      .toEqual({ content: "Worker durable text" });
  });

  it("replays a narrative delta after the worker commits but loses its reply", async () => {
    const execution = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID };
    const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "narrative-lease" };
    const begin: ExecutionSemanticOperation = {
      operationId: "narrative-lease:1", execution, lease, ordinal: 1,
      mutation: { kind: "begin", providerId: "codex", input: {
        thread: { id: THREAD_ID, workspaceId: "writer-workspace", providerId: "codex", createdAt: NOW },
        turnId: TURN_ID, executionId: EXECUTION_ID, permissionMode: "supervised", providerIdentities: [],
        userMessage: { kind: "create", messageId: "narrative-user", content: "Question", sequence: 1 },
      } },
    };
    writer = new CanonicalAgentWriterClient(dbPath);
    expect((await writer.transactSemantic(begin, () => {})).kind).toBe("committed");
    await writer.close();

    let created = 0;
    const published: string[] = [];
    writer = new CanonicalAgentWriterClient(dbPath, () => created++ === 0
      ? workerDroppingReply("semantic-transacted")
      : new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" }));
    const delta: ExecutionSemanticOperation = {
      operationId: "narrative-lease:2", execution, lease, ordinal: 2,
      mutation: { kind: "narrative-delta", input: {
        executionId: EXECUTION_ID, items: [recoveryToolCall()], discardedItemIds: [],
      } },
    };
    const receipt = await writer.transactSemantic(delta, (events) => published.push(...events.map((event) => event.eventId)));
    expect(receipt).toMatchObject({ kind: "committed", operationId: "narrative-lease:2" });
    expect(created).toBe(2);
    expect(published).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = ?")
      .get("toolCall:writer-recovery-tool")).toEqual({ count: 1 });
    await writer.close();

    writer = new CanonicalAgentWriterClient(dbPath);
    expect(await writer.transactSemantic(delta, () => {})).toEqual(receipt);
    expect(await writer.interruptWorkerLoss({ execution, lease, reason: "worker exited", recoveryIncidentId: "narrative-loss" },
      () => {})).toMatchObject({ kind: "committed", operationId: "narrative-lease:worker-lost" });
    expect(db.prepare("SELECT id, status FROM tool_call_records WHERE id = ?")
      .get("writer-recovery-tool")).toEqual({ id: "writer-recovery-tool", status: "completed" });
  });

  it("rejects a database failure without reporting a durable receipt", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.whenReady();
    db.run("DROP TABLE canonical_agent_events");
    await expect(writer.commit("writer-operation-2", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      phase: "running",
      events: events(),
    })).rejects.toThrow("Canonical writer write-failed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_ingest_checkpoints").get()).toEqual({ count: 0 });
  });

  it("acknowledges structured recovery after persistence and converges on replay", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.commit("narrative-start", {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events(),
    });
    const recovery = { executionId: EXECUTION_ID, items: [recoveryToolCall()] };
    expect(await writer.recordParentNarrativeRecovery("narrative-record", recovery)).toEqual({ recorded: true });
    const row = db.prepare("SELECT payload_json FROM canonical_agent_items WHERE id = ?")
      .get("toolCall:writer-recovery-tool") as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toMatchObject({
      projection: "narrativeRecovery",
      narrative: recoveryToolCall(),
    });
    expect(await writer.recordParentNarrativeRecovery("narrative-record", recovery)).toEqual({ recorded: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = ?")
      .get("toolCall:writer-recovery-tool")).toEqual({ count: 1 });

    expect(await writer.recordParentNarrativeRecovery("narrative-discard", {
      executionId: EXECUTION_ID,
      items: [],
      discardedItemIds: ["toolCall:writer-recovery-tool"],
    })).toEqual({ recorded: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = ?")
      .get("toolCall:writer-recovery-tool")).toEqual({ count: 0 });
    expect(await writer.recordParentNarrativeRecovery("narrative-discard", {
      executionId: EXECUTION_ID,
      items: [],
      discardedItemIds: ["toolCall:writer-recovery-tool"],
    })).toEqual({ recorded: true });
  });

  it("rejects a failed recovery write without a durability acknowledgement", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.commit("narrative-start", {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events(),
    });
    db.run("DROP TABLE canonical_agent_items");
    await expect(writer.recordParentNarrativeRecovery("narrative-failed", {
      executionId: EXECUTION_ID,
      items: [recoveryToolCall()],
    })).rejects.toThrow("Canonical writer write-failed");
  });

  it("converges after a failure between bounded recovery batches", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.commit("batched-recovery-start", {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events(),
    });
    const input = {
      executionId: EXECUTION_ID,
      items: Array.from({ length: 65 }, (_, index) => recoveryToolCall(`batched-${index}`)),
    };
    db.run(`CREATE TRIGGER reject_last_recovery BEFORE INSERT ON canonical_agent_items
      WHEN NEW.id = 'toolCall:batched-64' BEGIN SELECT RAISE(FAIL, 'injected recovery failure'); END`);
    await expect(writer.recordParentNarrativeRecovery("batched-recovery", input))
      .rejects.toThrow("Canonical writer write-failed");
    const partial = db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id LIKE 'toolCall:batched-%'")
      .get() as { count: number };
    expect(partial.count).toBeGreaterThan(0);
    expect(partial.count).toBeLessThan(65);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE operation_id = ?")
      .get("batched-recovery")).toEqual({ count: 0 });
    db.run("DROP TRIGGER reject_last_recovery");
    expect(await writer.recordParentNarrativeRecovery("batched-recovery", input)).toEqual({ recorded: true });
    expect(await writer.recordParentNarrativeRecovery("batched-recovery", input)).toEqual({ recorded: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id LIKE 'toolCall:batched-%'")
      .get()).toEqual({ count: 65 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE operation_id = ?")
      .get("batched-recovery")).toEqual({ count: 1 });
  }, 30_000);

  it("lets a second SQLite writer proceed while recovery continues across batches", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.commit("slow-recovery-start", {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events(),
    });
    db.run("CREATE TABLE writer_lock_probe (id TEXT PRIMARY KEY)");
    db.run(`CREATE TRIGGER slow_recovery BEFORE INSERT ON canonical_agent_items
      WHEN NEW.id LIKE 'toolCall:slow-%' BEGIN SELECT randomblob(8000000); END`);
    const input = {
      executionId: EXECUTION_ID,
      items: Array.from({ length: 80 }, (_, index) => recoveryToolCall(`slow-${index}`)),
    };
    let settled = false;
    const recovery = writer.recordParentNarrativeRecovery("slow-recovery", input)
      .finally(() => { settled = true; });
    const count = db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id LIKE 'toolCall:slow-%'");
    for (let attempts = 0; attempts < 500 && (count.get() as { count: number }).count === 0; attempts++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect((count.get() as { count: number }).count).toBeGreaterThan(0);
    expect(settled).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE operation_id = ?")
      .get("slow-recovery")).toEqual({ count: 0 });
    const started = performance.now();
    db.prepare("INSERT INTO writer_lock_probe (id) VALUES (?)").run("main-write");
    const mainWriteMs = performance.now() - started;
    expect(mainWriteMs).toBeLessThan(250);
    await recovery;
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE operation_id = ?")
      .get("slow-recovery")).toEqual({ count: 1 });
  }, 30_000);

  it("reports a missing execution without claiming recovery was recorded", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    expect(await writer.recordParentNarrativeRecovery("missing-recovery", {
      executionId: "missing-execution",
      items: [recoveryToolCall()],
    })).toEqual({ recorded: false });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items").get()).toEqual({ count: 0 });
  });

  it("commits recovery and assistant-text reset together", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.commit("classification-start", {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events(),
    });
    const checkpoints = new ParentAssistantTextCheckpointService(db);
    checkpoints.appendChunk([{
      executionId: EXECUTION_ID, threadId: THREAD_ID, turnId: TURN_ID, sequence: 1, text: "provisional text",
    }]);
    const input = { executionId: EXECUTION_ID, items: [recoveryToolCall()] };
    expect(await writer.classifyParentNarrativeRecovery("classification-1", input))
      .toEqual({ recorded: true, reset: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM parent_assistant_text_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = ?")
      .get("toolCall:writer-recovery-tool")).toEqual({ count: 1 });
    expect(await writer.classifyParentNarrativeRecovery("classification-1", input))
      .toEqual({ recorded: true, reset: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = ?")
      .get("toolCall:writer-recovery-tool")).toEqual({ count: 1 });
  });

  it("rolls back recovery when the assistant-text checkpoint is missing", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.commit("classification-start", {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events(),
    });
    await expect(writer.classifyParentNarrativeRecovery("classification-missing", {
      executionId: EXECUTION_ID,
      items: [recoveryToolCall()],
    })).rejects.toThrow("Canonical writer write-failed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = ?")
      .get("toolCall:writer-recovery-tool")).toEqual({ count: 0 });
  });

  it("rejects an unmigrated path without creating a second database", async () => {
    const missingPath = NodePath.join(tempDir, "missing.sqlite");
    writer = new CanonicalAgentWriterClient(missingPath);
    await expect(writer.whenReady()).rejects.toThrow("Canonical writer open-failed");
    await expect(NodeFSPromises.stat(missingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds write admission while SQLite is busy", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const activeWriter = writer;
    await activeWriter.whenReady();
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    db.run("BEGIN IMMEDIATE");
    let locked = true;
    try {
      const accepted = Array.from({ length: 64 }, (_, index) => activeWriter.commit(`queued-${index}`, batch));
      await expect(activeWriter.commit("overflow", batch)).rejects.toThrow("Canonical writer admission is full");
      db.run("ROLLBACK");
      locked = false;
      const results = await Promise.all(accepted);
      expect(results[0]?.outcome).toBe("committed");
      expect(results.slice(1).every((result) => result.outcome === "duplicate")).toBe(true);
    } finally {
      if (locked) db.run("ROLLBACK");
    }
  });

  it("restarts a closed worker and accepts later writes", async () => {
    let worker: Worker | undefined;
    writer = new CanonicalAgentWriterClient(dbPath, () => {
      worker = new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" });
      return worker;
    });
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    await writer.commit("writer-operation-3", batch);
    const closed = new Promise((resolve) => worker?.addEventListener("close", resolve, { once: true }));
    worker?.terminate();
    await closed;
    expect(await writer.commit("writer-operation-4", batch)).toMatchObject({ outcome: "duplicate" });
  });

  it("replays the committed envelope after a response is lost with the worker", async () => {
    let created = 0;
    writer = new CanonicalAgentWriterClient(dbPath, () => {
      return created++ === 0 ? workerDroppingReply("committed")
        : new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" });
    });
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    const receipt = await writer.commit("lost-committed-response", batch);
    expect(receipt).toMatchObject({ outcome: "committed", acceptedThrough: 3 });
    expect(receipt.events.map((event) => event.eventId)).toEqual(batch.events.map((event) => event.eventId));
    expect(created).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 3 });
  });

  it("replays a classification after its reset committed but the reply was lost", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.commit("classification-start", {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events(),
    });
    new ParentAssistantTextCheckpointService(db).appendChunk([{
      executionId: EXECUTION_ID, threadId: THREAD_ID, turnId: TURN_ID, sequence: 1, text: "provisional",
    }]);
    await writer.close();
    let created = 0;
    writer = new CanonicalAgentWriterClient(dbPath, () => {
      return created++ === 0 ? workerDroppingReply("parent-narrative-recovery-classified")
        : new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" });
    });
    expect(await writer.classifyParentNarrativeRecovery("lost-classification", {
      executionId: EXECUTION_ID, items: [recoveryToolCall()],
    })).toEqual({ recorded: true, reset: true });
    expect(created).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM parent_assistant_text_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = ?")
      .get("toolCall:writer-recovery-tool")).toEqual({ count: 1 });
  });

  it("replays a recovery discard after its reply was lost", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.commit("recovery-start", {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events(),
    });
    await writer.recordParentNarrativeRecovery("recovery-record", {
      executionId: EXECUTION_ID, items: [recoveryToolCall()],
    });
    await writer.close();
    let created = 0;
    writer = new CanonicalAgentWriterClient(dbPath, () => created++ === 0
      ? workerDroppingReply("parent-narrative-recovery-recorded")
      : new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" }));
    expect(await writer.recordParentNarrativeRecovery("lost-recovery-discard", {
      executionId: EXECUTION_ID, items: [], discardedItemIds: ["toolCall:writer-recovery-tool"],
    })).toEqual({ recorded: true });
    expect(created).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = ?")
      .get("toolCall:writer-recovery-tool")).toEqual({ count: 0 });
  });

  it("stops after three lost replies and permits explicit replay later", async () => {
    let created = 0;
    writer = new CanonicalAgentWriterClient(dbPath, () => {
      created++;
      return workerDroppingReply("committed");
    });
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    await expect(writer.commit("lost-three-times", batch)).rejects.toThrow("Canonical writer worker closed");
    expect(created).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 3 });
    await writer.close();
    writer = new CanonicalAgentWriterClient(dbPath);
    expect(await writer.commit("lost-three-times", batch)).toMatchObject({ outcome: "committed" });
  });

  it("rejects reused operation IDs with changed phase or native cursor", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    await writer.commit("same-id", batch);
    await expect(writer.commit("same-id", { ...batch, phase: "finalizing" }))
      .rejects.toThrow("Canonical writer operation-conflict");
    await expect(writer.commit("same-id", { ...batch, nativeCursor: "later" }))
      .rejects.toThrow("Canonical writer operation-conflict");
  });

  it("caps outstanding receipts and resumes after acknowledgement", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    await writer.commit("capacity-start", batch);
    const insert = db.prepare(`INSERT INTO canonical_writer_operation_receipts
      (execution_id, operation_id, kind, input_hash, receipt_json, created_at)
      VALUES (?, ?, 'commit', ?, '{}', ?)`);
    db.transaction(() => {
      for (let index = 1; index < 16_384; index++) {
        insert.run(EXECUTION_ID, `seed-${index}`, "seed", NOW);
      }
    })();
    const before = db.prepare("SELECT COUNT(*) AS count, SUM(LENGTH(receipt_json)) AS bytes FROM canonical_writer_operation_receipts").get();
    expect(before).toEqual({ count: 16_384, bytes: expect.any(Number) });
    await expect(writer.commit("capacity-over", batch)).rejects.toThrow("Canonical writer receipt-capacity");
    await writer.acknowledgeOperation(EXECUTION_ID, "capacity-start");
    await writer.acknowledgeOperation(EXECUTION_ID, "capacity-start");
    expect(await writer.commit("capacity-over", batch)).toMatchObject({ outcome: "duplicate" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get())
      .toEqual({ count: 16_384 });
    db.prepare("DELETE FROM canonical_agent_turns WHERE execution_id = ?").run(EXECUTION_ID);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get())
      .toEqual({ count: 0 });
  }, 30_000);

  it("retries a failed acknowledgement before the next write", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    await writer.commit("ack-retry-start", batch);
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    await expect(writer.acknowledgeOperation(EXECUTION_ID, "ack-retry-start"))
      .rejects.toThrow("Canonical writer write-failed");
    expect(writer.pendingAcknowledgementCount).toBe(1);
    db.run("DROP TRIGGER reject_receipt_delete");
    expect(await writer.commit("ack-retry-next", batch)).toMatchObject({ outcome: "duplicate" });
    expect(writer.pendingAcknowledgementCount).toBe(0);
    expect(db.prepare("SELECT operation_id FROM canonical_writer_operation_receipts").all())
      .toEqual([{ operation_id: "ack-retry-next" }]);
  });

  it("retries failed acknowledgements on close", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.commit("ack-close-start", {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events(),
    });
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    await expect(writer.acknowledgeOperation(EXECUTION_ID, "ack-close-start"))
      .rejects.toThrow("Canonical writer write-failed");
    db.run("DROP TRIGGER reject_receipt_delete");
    await writer.close();
    expect(writer.pendingAcknowledgementCount).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get())
      .toEqual({ count: 0 });
  });

  it("bounds failed acknowledgement retention and reports unfinished close cleanup", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    for (let index = 0; index <= 64; index++) await writer.commit(`ack-full-${index}`, batch);
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    for (let index = 0; index < 64; index++) {
      await expect(writer.acknowledgeOperation(EXECUTION_ID, `ack-full-${index}`))
        .rejects.toThrow("Canonical writer write-failed");
    }
    await expect(writer.acknowledgeOperation(EXECUTION_ID, "ack-full-64"))
      .rejects.toThrow("Canonical writer acknowledgement retry queue is full");
    expect(writer.pendingAcknowledgementCount).toBe(64);
    await expect(writer.close()).rejects.toThrow("64 unacknowledged operations");
  }, 30_000);
});
