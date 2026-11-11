import "reflect-metadata";
import * as NodeFS from "node:fs";
import type { Database } from "bun:sqlite";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@mcode/shared";
import { AcceptedCanonicalAgentEventEnvelopeSchema } from "@mcode/contracts/compat/agent-model";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import { type ParentNarrativeRecoveryItem } from "@mcode/contracts/models/narrative-recovery";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { openMigratedTestDatabase } from "../../../../runtime/persistence/sqlite/testing/migrated-test-database.js";
import type { CanonicalAgentEventDraft } from "../canonical-agent-boundary.js";
import { CanonicalAgentWriterClient as SharedCanonicalAgentWriterClient, CanonicalWriterAcknowledgementCapacity } from "../canonical-agent-writer-client.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { workspaceWriteOperations } from "../../../projects/persistence/workspace-write-operations.js";
import { CanonicalAgentWriterReceipts } from "../canonical-agent-writer-receipts.js";
import { CanonicalExecutionWriterPort } from "../canonical-execution-writer-port.js";
import { ExecutionLivePublicationRelease } from "../execution-live-publication-release.js";
import { AgentEventPublicationRegistry } from "../../orchestration/agent-event-publication-registry.js";
import type { CanonicalWriterResponse } from "../canonical-agent-writer-protocol.js";
import { ParentAssistantTextCheckpointStore as ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-store.js";
import type { ExecutionSemanticOperation } from "../../execution/execution-worker-handler.js";
import type { CanonicalAcceptedWriteInput } from "../canonical-accepted-write.js";
import { syntheticThreadExecutionId } from "../canonical-thread-execution.js";

const THREAD_ID = "writer-thread";
const TURN_ID = "writer-turn";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000176";
const NOW = "2026-09-24T12:00:00.000Z";

// This fixture owns its transport. Production canonical adapters share the composition-owned writer.
class CanonicalAgentWriterClient extends SharedCanonicalAgentWriterClient {
  readonly owner: ApplicationDatabaseWriter;
  private readonly pathExists: boolean;

  constructor(dbPath: string, createWorker?: () => Worker) {
    const owner = new ApplicationDatabaseWriter(dbPath, createWorker);
    super(owner);
    this.owner = owner;
    this.pathExists = NodeFS.existsSync(dbPath);
  }

  override async close(): Promise<void> {
    await super.close();
    if (this.pathExists) await this.owner.close();
    else await expect(this.owner.close()).rejects.toThrow("open-failed");
  }
}

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

function workerWithEmptyFailureMessage(): Worker {
  const worker = new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" });
  return new Proxy(worker, {
    set(target, property, value) {
      if (property !== "onmessage" || typeof value !== "function") return Reflect.set(target, property, value);
      target.onmessage = (message) => {
        if (message.data.kind === "failed" && message.data.failure) message.data.failure.message = "";
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
          providerStartedAt: null,
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

function headlessAcceptedInput(threadId: string, operationId: string): CanonicalAcceptedWriteInput {
  const executionId = syntheticThreadExecutionId(threadId);
  const epoch = `headless:${threadId}`;
  return {
    execution: { threadId, turnId: "", executionId }, phase: "synthesized", nativeCursor: null,
    contentHash: "a".repeat(64), baseRevision: 0,
    predecessor: { epoch, sequence: 0 }, through: { epoch, sequence: 2 },
    events: [
      AcceptedCanonicalAgentEventEnvelopeSchema.parse({
        eventId: `${threadId}:${operationId}:thread`, routing: { threadId, executionId },
        sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: 1,
        serverTimestamps: { acceptedAt: NOW }, progressPosition: { epoch, sequence: 1 },
        payload: { type: "thread.recorded", thread: {
          id: threadId, workspaceId: "writer-workspace", rootThreadId: threadId,
          providerId: "codex", providerIdentities: [], activityState: "Idle",
          conversationRevision: 0, rosterRevision: 0, createdAt: NOW, updatedAt: NOW,
        } },
      }),
      AcceptedCanonicalAgentEventEnvelopeSchema.parse({
        eventId: `${threadId}:${operationId}:publication`, routing: { threadId, executionId },
        sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: 2,
        serverTimestamps: { acceptedAt: NOW }, progressPosition: { epoch, sequence: 2 },
        payload: { type: "publication.recorded", publicationId: "1",
          event: { type: "compacting", threadId, active: false } },
      }),
    ],
  };
}

function nextHeadlessInput(input: CanonicalAcceptedWriteInput, operationId: string): CanonicalAcceptedWriteInput {
  return { ...input, predecessor: input.through,
    through: { ...input.through, sequence: input.through.sequence + 1 },
    events: [AcceptedCanonicalAgentEventEnvelopeSchema.parse({
      eventId: `${input.execution.threadId}:${operationId}:publication`, routing: {
        threadId: input.execution.threadId, executionId: input.execution.executionId,
      }, sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: 3,
      serverTimestamps: { acceptedAt: NOW },
      progressPosition: { ...input.through, sequence: input.through.sequence + 1 },
      payload: { type: "publication.recorded", publicationId: "2",
        event: { type: "compacting", threadId: input.execution.threadId, active: true } },
    })],
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
    db = openMigratedTestDatabase(dbPath);
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

  it("stores supplied acceptance on the writer and replays a lost receipt without renumbering", async () => {
    let workers = 0;
    writer = new CanonicalAgentWriterClient(dbPath, () => ++workers === 1
      ? workerDroppingReply("accepted-appended")
      : new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" }));
    const started = await writer.commit("accepted:start", { threadId: THREAD_ID, turnId: TURN_ID,
      executionId: EXECUTION_ID, phase: "running", events: events() });
    const accepted = AcceptedCanonicalAgentEventEnvelopeSchema.parse({
      eventId: "accepted:publication", routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID },
      sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: started.acceptedThrough + 1,
      serverTimestamps: { acceptedAt: NOW }, progressPosition: { epoch: "accepted-epoch", sequence: 1 },
      payload: { type: "publication.recorded", publicationId: "1", event: { type: "textDelta", threadId: THREAD_ID,
        turnExecutionId: EXECUTION_ID, delta: "before save", textKind: "final-response" } },
    });
    const input = { execution: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID },
      phase: "running", nativeCursor: null, contentHash: "a".repeat(64),
      predecessor: { epoch: "accepted-epoch", sequence: 0 }, through: { epoch: "accepted-epoch", sequence: 1 },
      baseRevision: started.conversationRevision, events: [accepted] };
    const saved = await writer.appendAccepted("accepted:append", input);
    expect(workers).toBe(2);
    expect(saved.receipt).toMatchObject({ operationId: "accepted:append", contentHash: input.contentHash,
      predecessor: input.predecessor, through: input.through, durableRevision: started.conversationRevision + 1 });
    expect(saved.events[0]).toMatchObject({ eventId: accepted.eventId, acceptedSequence: accepted.acceptedSequence,
      progressPosition: accepted.progressPosition, serverTimestamps: { acceptedAt: NOW } });
    expect(await writer.appendAccepted("accepted:append", input)).toEqual(saved);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE event_id = ?").get(accepted.eventId))
      .toEqual({ count: 1 });
    await expect(writer.appendAccepted("accepted:wrong-next", { ...input, contentHash: "b".repeat(64), events: [{ ...accepted,
      eventId: "accepted:other", acceptedSequence: accepted.acceptedSequence + 1 }] }))
      .rejects.toThrow();
  });

  it("saves headless accepted progress without creating a turn or ingest checkpoint", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const input = headlessAcceptedInput(THREAD_ID, "headless-save");
    const saved = await writer.appendAccepted("headless-save", input);
    expect(saved.events).toMatchObject(input.events);
    expect(saved.receipt).toMatchObject({ operationId: "headless-save", durableRevision: 1, through: input.through });
    expect(saved.events.every((event) => event.routing.turnId === undefined)).toBe(true);
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_turns").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_ingest_checkpoints").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 0 });
    expect(db.query("SELECT thread_id, execution_id, operation_id FROM canonical_writer_thread_operation_receipts").all())
      .toEqual([{ thread_id: THREAD_ID, execution_id: input.execution.executionId, operation_id: "headless-save" }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("replays headless committed envelopes after lost replies and continues their sequence after restart", async () => {
    let workers = 0;
    writer = new CanonicalAgentWriterClient(dbPath, () => ++workers === 1
      ? workerDroppingReply("accepted-appended")
      : new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" }));
    const input = headlessAcceptedInput(THREAD_ID, "headless-lost");
    const saved = await writer.appendAccepted("headless-lost", input);
    expect(workers).toBe(2);
    await writer.close();
    writer = new CanonicalAgentWriterClient(dbPath);
    expect(await writer.appendAccepted("headless-lost", input)).toEqual(saved);
    await expect(writer.appendAccepted("headless-lost", { ...input, contentHash: "b".repeat(64) }))
      .rejects.toThrow("Canonical writer operation-conflict");
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 2 });
    const next = await writer.appendAccepted("headless-next", nextHeadlessInput(input, "headless-next"));
    expect(next.events).toMatchObject([{ acceptedSequence: 3, routing: { executionId: input.execution.executionId } }]);
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 3 });
  });

  it("restores an empty-message worker failure with its class name and worker stack", async () => {
    writer = new CanonicalAgentWriterClient(dbPath, workerWithEmptyFailureMessage);
    const input = headlessAcceptedInput(THREAD_ID, "empty-failure");
    await writer.appendAccepted("empty-failure", input);
    const failure = await writer.appendAccepted("empty-failure", { ...input, contentHash: "b".repeat(64) })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected a restored worker error");
    expect(failure.name).toBe("CanonicalWriterOperationConflict");
    expect(failure.message).toBe("Canonical writer operation-conflict: CanonicalWriterOperationConflict");
    expect(failure.stack).toContain("canonical-agent-writer-receipts.ts");
    if (!failure.stack) throw new Error("Expected the worker stack");
    expect(failure.stack.length).toBeLessThanOrEqual(4000);
  });

  it("keeps matching operation IDs independent across headless threads and retries only their acknowledgements", async () => {
    const otherThreadId = "other-headless-thread";
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(otherThreadId, "writer-workspace", "Other headless", "main", "codex", NOW, NOW);
    writer = new CanonicalAgentWriterClient(dbPath);
    const first = headlessAcceptedInput(THREAD_ID, "same-headless-operation");
    const second = headlessAcceptedInput(otherThreadId, "same-headless-operation");
    const firstSaved = await writer.appendAccepted("same-headless-operation", first);
    const secondSaved = await writer.appendAccepted("same-headless-operation", second);
    expect(first.execution.executionId).not.toBe(second.execution.executionId);
    expect(firstSaved.events.map((event) => event.acceptedSequence)).toEqual([1, 2]);
    expect(secondSaved.events.map((event) => event.acceptedSequence)).toEqual([1, 2]);
    db.run(`CREATE TRIGGER reject_headless_ack BEFORE DELETE ON canonical_writer_thread_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'headless ack unavailable'); END`);
    await expect(writer.acknowledgeOperations([{ executionId: first.execution.executionId, operationId: "same-headless-operation" }]))
      .rejects.toThrow("Canonical writer write-failed");
    expect(writer.pendingAcknowledgementCount).toBe(1);
    db.run("DROP TRIGGER reject_headless_ack");
    expect(await writer.appendAccepted("same-headless-operation", second)).toEqual(secondSaved);
    expect(writer.pendingAcknowledgementCount).toBe(0);
    expect(db.query("SELECT thread_id FROM canonical_writer_thread_operation_receipts").all()).toEqual([{ thread_id: otherThreadId }]);
    await writer.close();
    let workers = 0;
    writer = new CanonicalAgentWriterClient(dbPath, () => ++workers === 1
      ? workerDroppingReply("operations-acknowledged")
      : new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" }));
    await writer.acknowledgeOperations([{ executionId: second.execution.executionId, operationId: "same-headless-operation" }]);
    await writer.acknowledgeOperations([{ executionId: second.execution.executionId, operationId: "same-headless-operation" }]);
    expect(workers).toBe(2);
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_thread_operation_receipts").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 4 });
  });

  it("rejects forged headless execution ownership before replaying or appending progress", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const input = headlessAcceptedInput(THREAD_ID, "headless-forged");
    const saved = await writer.appendAccepted("headless-forged", input);
    await expect(writer.appendAccepted("headless-forged", { ...input,
      execution: { ...input.execution, threadId: "another-headless-owner" } })).rejects.toThrow();
    await expect(writer.appendAccepted("headless-other", { ...input,
      execution: { ...input.execution, executionId: EXECUTION_ID } })).rejects.toThrow();
    expect(await writer.appendAccepted("headless-forged", input)).toEqual(saved);
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_thread_operation_receipts").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 2 });
  });

  it("rejects virtual identity overlap and preserves both receipts when an acknowledgement has ambiguous ownership", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const input = headlessAcceptedInput(THREAD_ID, "headless-overlap");
    db.prepare(`INSERT INTO canonical_agent_threads
      (id, workspace_id, root_thread_id, provider_id, activity_state, created_at, updated_at)
      VALUES (?, 'writer-workspace', ?, 'codex', 'Active', ?, ?)`).run(THREAD_ID, THREAD_ID, NOW, NOW);
    db.prepare(`INSERT INTO canonical_agent_turns
      (id, thread_id, execution_id, status, trigger_json, permission_mode, created_at, updated_at)
      VALUES (?, ?, ?, 'Running', '{"kind":"user"}', 'supervised', ?, ?)`)
      .run(TURN_ID, THREAD_ID, input.execution.executionId, NOW, NOW);
    await expect(writer.appendAccepted("headless-overlap", input)).rejects.toThrow("Canonical writer operation-conflict");
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_thread_operation_receipts").get()).toEqual({ count: 0 });
    db.prepare(`INSERT INTO canonical_writer_operation_receipts
      (execution_id, operation_id, kind, input_hash, receipt_json)
      VALUES (?, 'ambiguous-receipt', 'commit', 'seed', '{}')`).run(input.execution.executionId);
    db.prepare(`INSERT INTO canonical_writer_thread_operation_receipts
      (execution_id, thread_id, operation_id, kind, input_hash, receipt_json)
      VALUES (?, ?, 'ambiguous-receipt', 'append-accepted', 'seed', '{}')`).run(input.execution.executionId, THREAD_ID);
    try {
      await expect(writer.acknowledgeOperations([{ executionId: input.execution.executionId, operationId: "ambiguous-receipt" }]))
        .rejects.toThrow("Canonical writer write-failed");
      expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 1 });
      expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_thread_operation_receipts").get()).toEqual({ count: 1 });
    } finally {
      db.run("DELETE FROM canonical_writer_operation_receipts WHERE operation_id = 'ambiguous-receipt'");
      db.run("DELETE FROM canonical_writer_thread_operation_receipts WHERE operation_id = 'ambiguous-receipt'");
    }
  });

  it("cascades headless receipts with their thread while retaining real-turn foreign keys", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const input = headlessAcceptedInput(THREAD_ID, "headless-delete");
    await writer.appendAccepted("headless-delete", input);
    const insertTurnReceipt = db.prepare(`INSERT INTO canonical_writer_operation_receipts
      (execution_id, operation_id, kind, input_hash, receipt_json) VALUES (?, ?, 'commit', 'seed', '{}')`);
    expect(() => insertTurnReceipt.run(input.execution.executionId, "fake-turn"))
      .toThrow("FOREIGN KEY constraint failed");
    expect(() => db.prepare(`INSERT INTO canonical_writer_thread_operation_receipts
      (execution_id, thread_id, operation_id, kind, input_hash, receipt_json)
      VALUES (?, ?, 'missing-thread', 'append-accepted', 'seed', '{}')`)
      .run(syntheticThreadExecutionId("missing-thread"), "missing-thread")).toThrow("FOREIGN KEY constraint failed");
    expect(() => db.prepare(`INSERT INTO canonical_writer_thread_operation_receipts
      (execution_id, thread_id, operation_id, kind, input_hash, receipt_json)
      VALUES (?, ?, 'wrong-kind', 'commit', 'seed', '{}')`)
      .run(input.execution.executionId, THREAD_ID)).toThrow();
    db.prepare("DELETE FROM canonical_agent_threads WHERE id = ?").run(THREAD_ID);
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_thread_operation_receipts").get()).toEqual({ count: 0 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("bounds thread receipt capacity without consuming another thread or a real turn's capacity", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const input = headlessAcceptedInput(THREAD_ID, "headless-capacity");
    await writer.appendAccepted("headless-capacity", input);
    const insert = db.prepare(`INSERT INTO canonical_writer_thread_operation_receipts
      (execution_id, thread_id, operation_id, kind, input_hash, receipt_json)
      VALUES (?, ?, ?, 'append-accepted', 'seed', '{}')`);
    db.transaction(() => {
      for (let index = 1; index < 16_384; index++) insert.run(input.execution.executionId, THREAD_ID, `seed-${index}`);
    })();
    const nextInput = nextHeadlessInput(input, "headless-capacity-next");
    await expect(writer.appendAccepted("headless-capacity-next", nextInput)).rejects.toThrow("Canonical writer receipt-capacity");
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 2 });
    const otherThreadId = "capacity-independent-thread";
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(otherThreadId, "writer-workspace", "Other capacity", "main", "codex", NOW, NOW);
    expect(await writer.appendAccepted("headless-capacity", headlessAcceptedInput(otherThreadId, "headless-capacity")))
      .toMatchObject({ receipt: { durableRevision: 1 } });
    await writer.acknowledgeOperations([{ executionId: input.execution.executionId, operationId: "headless-capacity" }]);
    expect(await writer.appendAccepted("headless-capacity-next", nextInput))
      .toMatchObject({ receipt: { durableRevision: 2 } });
    expect(await writer.commit("turn-capacity", { threadId: THREAD_ID, turnId: TURN_ID,
      executionId: EXECUTION_ID, phase: "running", events: events() })).toMatchObject({ outcome: "committed" });
  }, 30_000);

  it("reserves the receipt writer before a peer can invalidate its read snapshot", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const input = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
      phase: "running", events: events() };
    const receipt = await writer.commit("receipt-lock:start", input);
    const peer = openDatabase({ dbPath });
    peer.run("PRAGMA busy_timeout = 0");
    try {
      let peerFailure: unknown;
      const receipts = new CanonicalAgentWriterReceipts(db);
      const response = receipts.execute({ kind: "commit", requestId: "receipt-lock:request",
        operationId: "receipt-lock:append", executionId: EXECUTION_ID, input }, () => {
        try {
          peer.prepare("UPDATE threads SET title = ? WHERE id = ?").run("Peer update", THREAD_ID);
        } catch (error) { peerFailure = error; }
        return { kind: "committed", requestId: "receipt-lock:request", operationId: "receipt-lock:append",
          executionId: EXECUTION_ID, receipt };
      });
      expect(response.kind).toBe("committed");
      expect(peerFailure).toMatchObject({ code: "SQLITE_BUSY" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE operation_id = ?")
        .get("receipt-lock:append")).toEqual({ count: 1 });
      peer.prepare("UPDATE threads SET title = ? WHERE id = ?").run("Peer update", THREAD_ID);
      expect(db.prepare("SELECT title FROM threads WHERE id = ?").get(THREAD_ID)).toEqual({ title: "Peer update" });
    } finally { peer.close(true); }
  });

  it("replays a committed content replacement's receipt with its reason after a lost reply", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const saved = headlessAcceptedInput(THREAD_ID, "before-replaced");
    await writer.appendAccepted("before-replaced", saved);
    const receipts = new CanonicalAgentWriterReceipts(db);
    const replaced = { reason: "live publication is invalid or exceeds its size limit" };
    const input = { ...nextHeadlessInput(saved, "replaced"), replaced };
    const request = { kind: "append-accepted" as const, requestId: "replaced:request", operationId: "lease:2:replaced",
      executionId: input.execution.executionId, input };
    let applied = 0;
    const apply = (): Extract<CanonicalWriterResponse, { kind: "accepted-appended" }> => {
      applied += 1;
      return { kind: "accepted-appended", requestId: request.requestId, operationId: request.operationId,
        executionId: request.executionId, result: { receipt: { operationId: request.operationId, contentHash: input.contentHash,
          predecessor: input.predecessor, through: input.through, durableRevision: 2, replaced },
        revision: { conversationRevision: 2, rosterRevision: 0 }, events: [] } };
    };
    const first = receipts.execute(request, apply);
    const replay = receipts.execute({ ...request, requestId: "replaced:retry" }, apply);
    expect(applied).toBe(1);
    expect(replay).toEqual({ ...first, requestId: "replaced:retry" });
    expect(replay).toMatchObject({ kind: "accepted-appended", result: { receipt: { replaced } } });
  });

  it("retains a failed publication head until the worker's final response before releasing an ordinary tail", async () => {
    const execution = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID };
    const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "failed-publication-lease" };
    const operation: ExecutionSemanticOperation = {
      operationId: "failed-publication-lease:1", execution, lease, ordinal: 1,
      mutation: { kind: "begin", providerId: "codex", input: {
        thread: { id: THREAD_ID, workspaceId: "writer-workspace", providerId: "codex", createdAt: NOW },
        turnId: TURN_ID, executionId: EXECUTION_ID, permissionMode: "supervised", providerIdentities: [],
        userMessage: { kind: "create", messageId: "failed-publication-user", content: "Question", sequence: 1 },
      } },
    };
    let notifyFinal: () => void = () => {};
    const workerFinished = new Promise<void>((resolve) => { notifyFinal = resolve; });
    writer = new CanonicalAgentWriterClient(dbPath, () => {
      const worker = new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" });
      return new Proxy(worker, {
        set(target, property, value) {
          if (property !== "onmessage" || typeof value !== "function") return Reflect.set(target, property, value);
          target.onmessage = (message: MessageEvent<CanonicalWriterResponse>) => {
            if (message.data.kind === "semantic-transacted") {
              notifyFinal();
              setTimeout(() => value(message), 100);
            } else value(message);
          };
          return true;
        },
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const failedPublication = writer.transactSemantic(operation, () => { throw new Error("Publication callback failed"); });
    const observed = expect(failedPublication).rejects.toThrow("Publication callback failed");
    const tail = writer.owner.execute(workspaceWriteOperations.create, ["After publication", "after-publication", true]);
    await workerFinished;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(db.query("SELECT COUNT(*) AS count FROM workspaces WHERE path = 'after-publication'").get()).toEqual({ count: 0 });
    await observed;
    expect(await tail).toMatchObject({ name: "After publication" });
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE id = 'failed-publication-user'").get()).toEqual({ count: 1 });
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
      publicationId: "1", after: "writer",
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
      livePublication: [{ after: "writer", event: { type: "textDelta", threadId: THREAD_ID,
        turnExecutionId: EXECUTION_ID, delta: "Worker durable text", isFinalResponse: true } }],
      mutation: { kind: "live-event", text: { kind: "append", inputs: [{ ...execution, sequence: 1, text: "Worker durable text" }] } },
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
    expect(published).toEqual([expect.stringContaining(`narrative:${EXECUTION_ID}:toolCall:writer-recovery-tool:`)]);
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

  it("replays one live reclassification receipt after the worker loses its reply", async () => {
    const execution = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID };
    const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "live-text-lease" };
    const begin: ExecutionSemanticOperation = {
      operationId: "live-text-lease:1", execution, lease, ordinal: 1,
      mutation: { kind: "begin", providerId: "codex", input: {
        thread: { id: THREAD_ID, workspaceId: "writer-workspace", providerId: "codex", createdAt: NOW },
        turnId: TURN_ID, executionId: EXECUTION_ID, permissionMode: "supervised", providerIdentities: [],
        userMessage: { kind: "create", messageId: "live-text-user", content: "Question", sequence: 1 },
      } },
    };
    writer = new CanonicalAgentWriterClient(dbPath);
    expect((await writer.transactSemantic(begin, () => {})).kind).toBe("committed");
    const provisional: ExecutionSemanticOperation = {
      operationId: "live-text-lease:2", execution, lease, ordinal: 2,
      mutation: { kind: "live-event", text: { kind: "append", inputs: [{
        ...execution, sequence: 1, text: "provisional thought",
      }] } },
      livePublication: [{ after: "writer", event: {
        type: AgentEventType.TextDelta, threadId: THREAD_ID,
        turnExecutionId: EXECUTION_ID, delta: "provisional thought",
      } }],
    };
    expect((await writer.transactSemantic(provisional, () => {})).kind).toBe("committed");
    await writer.close();

    const thought = { kind: "narrationSegment" as const, record: {
      id: "live-thought", message_id: "", text: "provisional thought",
      started_at: NOW, ended_at: NOW, sort_order: 0,
    } };
    const reclassified: ExecutionSemanticOperation = {
      operationId: "live-text-lease:3", execution, lease, ordinal: 3,
      mutation: { kind: "live-event", text: { kind: "reclassify", expectedText: "provisional thought" },
        narrative: { executionId: EXECUTION_ID, items: [thought], discardedItemIds: [] } },
      livePublication: [{ after: "writer", event: {
        type: AgentEventType.AssistantMessageBoundary, threadId: THREAD_ID,
        turnExecutionId: EXECUTION_ID, isFinalResponse: false,
      } }],
    };
    let created = 0;
    writer = new CanonicalAgentWriterClient(dbPath, () => created++ === 0
      ? workerDroppingReply("semantic-transacted")
      : new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" }));
    const receipt = await writer.transactSemantic(reclassified, () => {});
    expect(receipt).toMatchObject({ kind: "committed", operationId: "live-text-lease:3",
      livePublication: [{ publicationId: "2", after: "writer" }] });
    expect(created).toBe(2);
    expect(new ParentAssistantTextCheckpointService(db).restore(EXECUTION_ID)).toBe("");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = ?")
      .get("narrationSegment:live-thought")).toEqual({ count: 1 });
    await writer.close();

    writer = new CanonicalAgentWriterClient(dbPath);
    expect(await writer.transactSemantic(reclassified, () => {})).toEqual(receipt);
    expect((await writer.interruptWorkerLoss({ execution, lease, reason: "worker exited",
      recoveryIncidentId: "live-thought-loss" }, () => {})).kind).toBe("committed");
    expect(db.prepare("SELECT id, text FROM thought_segments WHERE id = ?").get("live-thought"))
      .toEqual({ id: "live-thought", text: "provisional thought" });
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
    let notifyBatchPaused: () => void = () => {};
    const batchPaused = new Promise<void>((resolve) => { notifyBatchPaused = resolve; });
    const worker = new Worker(new URL("./recovery-paused-writer.worker.ts", import.meta.url), { type: "module" });
    writer = new CanonicalAgentWriterClient(dbPath, () => new Proxy(worker, {
      set(target, property, value) {
        if (property !== "onmessage" || typeof value !== "function") return Reflect.set(target, property, value);
        target.onmessage = (message: MessageEvent<CanonicalWriterResponse | "recovery-batch-paused">) => {
          if (message.data === "recovery-batch-paused") notifyBatchPaused();
          else value(message);
        };
        return true;
      },
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
    await writer.commit("slow-recovery-start", {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events(),
    });
    db.run("CREATE TABLE writer_lock_probe (id TEXT PRIMARY KEY, recovered_count INTEGER NOT NULL)");
    const input = {
      executionId: EXECUTION_ID,
      items: Array.from({ length: 80 }, (_, index) => recoveryToolCall(`slow-${index}`)),
    };
    let settled = false;
    const recovery = writer.recordParentNarrativeRecovery("slow-recovery", input)
      .finally(() => { settled = true; });
    const count = db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id LIKE 'toolCall:slow-%'");
    try {
      await Promise.race([batchPaused, recovery]);
      expect(settled).toBe(false);
      expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE operation_id = ?")
        .get("slow-recovery")).toEqual({ count: 0 });
      db.prepare(`INSERT INTO writer_lock_probe (id, recovered_count)
        SELECT ?, COUNT(*) FROM canonical_agent_items WHERE id LIKE 'toolCall:slow-%'`).run("main-write");
      const probe = db.prepare<{ recovered_count: number }, []>(
        "SELECT recovered_count FROM writer_lock_probe WHERE id = 'main-write'",
      ).get();
      expect(probe?.recovered_count).toBeGreaterThan(0);
      expect(probe?.recovered_count).toBeLessThan(input.items.length);
    } finally {
      worker.postMessage("resume-recovery");
      await recovery;
    }
    expect(count.get()).toEqual({ count: input.items.length });
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
    await writer.acknowledgeOperations([{ executionId: EXECUTION_ID, operationId: "capacity-start" }]);
    await writer.acknowledgeOperations([{ executionId: EXECUTION_ID, operationId: "capacity-start" }]);
    expect(await writer.commit("capacity-over", batch)).toMatchObject({ outcome: "duplicate" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get())
      .toEqual({ count: 16_384 });
    db.prepare("DELETE FROM canonical_agent_turns WHERE execution_id = ?").run(EXECUTION_ID);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get())
      .toEqual({ count: 0 });
  }, 30_000);

  it("batches 200 handled saves into at most four cleanup requests", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.whenReady();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const send = vi.spyOn(writer.owner, "sendCanonical");
      let input = headlessAcceptedInput(THREAD_ID, "batched-0");
      for (let index = 0; index < 200; index++) {
        const saved = await writer.appendAccepted(`batched-${index}`, input);
        writer.enqueueAcknowledgement(input.execution.executionId, `batched-${index}`);
        input = nextHeadlessInput(input, `batched-${index + 1}`);
        input = { ...input, baseRevision: saved.receipt.durableRevision,
          events: input.events.map((event) => ({ ...event, acceptedSequence: input.through.sequence })) };
      }
      await writer.close();
      const requests = send.mock.calls.filter(([request]) => request.kind === "ack-operations");
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.length).toBeLessThanOrEqual(4);
      expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 201 });
      expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_thread_operation_receipts").get()).toEqual({ count: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes queued receipt deletion before close resolves", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.commit("queued-close", { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() });
    writer.enqueueAcknowledgement(EXECUTION_ID, "queued-close");
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 1 });
    await writer.close();
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 0 });
  });

  it("retains a failed deferred drain and bounds only failed cleanup", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    for (let index = 0; index < 65; index++) await writer.commit(`deferred-${index}`, batch);
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    writer.enqueueAcknowledgement(EXECUTION_ID, "deferred-0");
    await expect.poll(() => writer.pendingAcknowledgementCount).toBe(1);
    for (let index = 1; index < 64; index++) {
      await expect(writer.acknowledgeOperations([{ executionId: EXECUTION_ID, operationId: `deferred-${index}` }]))
        .rejects.toThrow("Canonical writer write-failed");
    }
    expect(() => writer.enqueueAcknowledgement(EXECUTION_ID, "deferred-64")).toThrow(CanonicalWriterAcknowledgementCapacity);
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 65 });
    db.run("DROP TRIGGER reject_receipt_delete");
    await writer.close();
    expect(db.query("SELECT operation_id FROM canonical_writer_operation_receipts").all()).toEqual([{ operation_id: "deferred-64" }]);
  });

  it.each(["queued", "awaited"])("admits healthy %s cleanup while 64 deletions are in flight", async (mode) => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    for (let index = 0; index < 66; index++) await writer.commit(`held-${index}`, batch);
    let releaseDelete: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const original = writer.owner.sendCanonical.bind(writer.owner);
    vi.spyOn(writer.owner, "sendCanonical").mockImplementation(async (...args) => {
      if (args[0].kind === "ack-operations") await held;
      return original(...args);
    });
    try {
      for (let index = 0; index < 64; index++) writer.enqueueAcknowledgement(EXECUTION_ID, `held-${index}`);
      if (mode === "queued") expect(() => writer.enqueueAcknowledgement(EXECUTION_ID, "held-64")).not.toThrow();
      const awaited = writer.acknowledgeOperations([{ executionId: EXECUTION_ID, operationId: mode === "queued" ? "held-65" : "held-64" }]);
      releaseDelete();
      await expect(awaited).resolves.toBeUndefined();
      if (mode === "awaited") writer.enqueueAcknowledgement(EXECUTION_ID, "held-65");
      await writer.close();
      expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 0 });
    } finally {
      releaseDelete();
    }
  });

  it("retires 70 receipts from one save without exhausting cleanup capacity", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    for (let index = 0; index < 70; index++) await writer.commit(`page-${index}`, batch);
    expect(() => {
      for (let index = 0; index < 70; index++) writer.enqueueAcknowledgement(EXECUTION_ID, `page-${index}`);
    }).not.toThrow();
    await writer.close();
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 0 });
  });

  it("isolates a poison receipt and reaches capacity only after 64 distinct failed deletions", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    for (let index = 0; index < 64; index++) {
      await writer.commit(`bad-${index}`, batch);
      await writer.commit(`good-${index}`, batch);
    }
    db.run(`CREATE TRIGGER poison_cleanup BEFORE DELETE ON canonical_writer_operation_receipts
      WHEN OLD.operation_id LIKE 'bad-%' BEGIN SELECT RAISE(FAIL, 'poison'); END`);
    try {
      await expect(writer.acknowledgeOperations([
        { executionId: EXECUTION_ID, operationId: "bad-0" },
        { executionId: EXECUTION_ID, operationId: "good-0" },
      ])).rejects.toThrow("Canonical writer write-failed");
      expect(db.query("SELECT operation_id FROM canonical_writer_operation_receipts WHERE operation_id = 'good-0'").all()).toEqual([]);
      await expect(writer.acknowledgeOperations([
        { executionId: EXECUTION_ID, operationId: "bad-0" },
        ...Array.from({ length: 63 }, (_, index) => ({ executionId: EXECUTION_ID, operationId: `good-${index + 1}` })),
      ])).rejects.toThrow("Canonical writer write-failed");
      expect(writer.pendingAcknowledgementCount).toBe(1);
      expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE operation_id LIKE 'good-%'").get()).toEqual({ count: 0 });
      expect(() => writer.enqueueAcknowledgement(EXECUTION_ID, "healthy-after-poison")).not.toThrow();
      await expect(writer.acknowledgeOperations(Array.from({ length: 63 }, (_, index) => ({
        executionId: EXECUTION_ID, operationId: `bad-${index + 1}`,
      })))).rejects.toThrow("Canonical writer write-failed");
      expect(writer.pendingAcknowledgementCount).toBe(64);
      expect(() => writer.enqueueAcknowledgement(EXECUTION_ID, "overflow")).toThrow(CanonicalWriterAcknowledgementCapacity);
    } finally {
      db.run("DROP TRIGGER poison_cleanup");
    }
    await writer.close();
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 0 });
  });

  it("submits the next live write while active cleanup is held", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const held = Promise.withResolvers<void>();
    const original = writer.owner.sendCanonical.bind(writer.owner);
    const requests: string[] = [];
    vi.spyOn(writer.owner, "sendCanonical").mockImplementation(async (...args) => {
      requests.push(args[0].kind);
      if (args[0].kind === "ack-operations") await held.promise;
      return original(...args);
    });
    let saving: Promise<unknown> | undefined;
    try {
      for (let index = 0; index < 64; index++) writer.enqueueAcknowledgement(EXECUTION_ID, `previous-${index}`);
      saving = writer.commit("next-live-write", {
        threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events(),
      });
      await Promise.resolve();
      expect(requests).toEqual(["ack-operations", "commit"]);
      await expect(saving).resolves.toMatchObject({ outcome: "committed" });
      held.resolve();
      expect(requests).toEqual(["ack-operations", "commit"]);
    } finally {
      held.resolve();
      await saving;
    }
  });

  it("fully flushes retained receipts on close after an active limited retry", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    for (let index = 0; index < 20; index++) await writer.commit(`close-${index}`, batch);
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    await expect(writer.acknowledgeOperations(Array.from({ length: 20 }, (_, index) => ({
      executionId: EXECUTION_ID, operationId: `close-${index}`,
    })))).rejects.toThrow();
    db.run("DROP TRIGGER reject_receipt_delete");
    const held = Promise.withResolvers<void>();
    const original = writer.owner.sendCanonical.bind(writer.owner);
    vi.spyOn(writer.owner, "sendCanonical").mockImplementation(async (...args) => {
      if (args[0].kind === "ack-operations") await held.promise;
      return original(...args);
    });
    const saving = writer.commit("live-close", batch).then((receipt) => receipt, (error: unknown) => error);
    const closing = writer.close();
    const result = expect(closing).resolves.toBeUndefined();
    held.resolve();
    await result;
    expect(await saving).toMatchObject({ outcome: "duplicate" });
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE operation_id LIKE 'close-%'").get()).toEqual({ count: 0 });
  });

  it("fully flushes retained receipts when a save arrives during close", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    for (let index = 0; index < 20; index++) await writer.commit(`closing-${index}`, batch);
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    await expect(writer.acknowledgeOperations(Array.from({ length: 20 }, (_, index) => ({
      executionId: EXECUTION_ID, operationId: `closing-${index}`,
    })))).rejects.toThrow();
    db.run("DROP TRIGGER reject_receipt_delete");
    const closing = writer.close();
    await expect(writer.commit("save-during-close", batch)).rejects.toThrow("Canonical writer closed");
    await expect(closing).resolves.toBeUndefined();
    expect(writer.pendingAcknowledgementCount).toBe(0);
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 0 });
  });

  it("clears capacity failures only after the overflowed receipts are deleted", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    for (let index = 0; index < 66; index++) await writer.commit(`recovered-${index}`, batch);
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    await expect(writer.acknowledgeOperations(Array.from({ length: 66 }, (_, index) => ({
      executionId: EXECUTION_ID, operationId: `recovered-${index}`,
    })))).rejects.toThrow(CanonicalWriterAcknowledgementCapacity);
    db.run("DROP TRIGGER reject_receipt_delete");
    await writer.acknowledgeOperations([{ executionId: EXECUTION_ID, operationId: "recovered-64" }]);
    await writer.acknowledgeOperations(Array.from({ length: 64 }, (_, index) => ({
      executionId: EXECUTION_ID, operationId: `recovered-${index}`,
    })));
    writer.enqueueAcknowledgement(EXECUTION_ID, "recovered-65");
    await expect(writer.close()).resolves.toBeUndefined();
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 0 });
  });

  it("logs the capacity failure and its deletion cause as strings", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const logged = vi.spyOn(logger, "error").mockClear();
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    for (let index = 0; index < 65; index++) await writer.commit(`logged-${index}`, batch);
    await expect(writer.acknowledgeOperations(Array.from({ length: 65 }, (_, index) => ({
      executionId: EXECUTION_ID, operationId: `logged-${index}`,
    })))).rejects.toThrow(CanonicalWriterAcknowledgementCapacity);
    expect(logged.mock.calls).toContainEqual(["Canonical writer receipt cleanup exceeded retry capacity", {
      executionId: EXECUTION_ID, operationId: "logged-64",
      error: "Canonical writer acknowledgement retry queue is full", cause: expect.stringContaining("ack unavailable"),
    }]);
    db.run("DROP TRIGGER reject_receipt_delete");
    await writer.acknowledgeOperations([{ executionId: EXECUTION_ID, operationId: "logged-64" }]);
    logged.mockRestore();
  });

  it("bounds failing receipt cleanup to eight retries per live write", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    for (let index = 0; index < 9; index++) await writer.commit(`bounded-${index}`, batch);
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    try {
      await expect(writer.acknowledgeOperations(Array.from({ length: 9 }, (_, index) => ({
        executionId: EXECUTION_ID, operationId: `bounded-${index}`,
      })))).rejects.toThrow();
      const send = vi.spyOn(writer.owner, "sendCanonical");
      for (let index = 0; index < 2; index++) {
        send.mockClear();
        await writer.commit(`live-${index}`, batch);
        await expect.poll(() => send.mock.settledResults.filter(({ type }) => type === "rejected").length).toBe(9);
        // After the final transport response, drain its promise continuations before starting another round.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(send.mock.calls.filter(([request]) => request.kind === "ack-operations")).toHaveLength(9);
        expect(writer.pendingAcknowledgementCount).toBe(9);
      }
    } finally {
      db.run("DROP TRIGGER reject_receipt_delete");
    }
  }, 30_000);

  it.each([1, 32, 63])("admits healthy queued cleanup alongside %i retained failures", async (failures) => {
    writer = new CanonicalAgentWriterClient(dbPath);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    for (let index = 0; index < 65; index++) await writer.commit(`mixed-${index}`, batch);
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    try {
      await expect(writer.acknowledgeOperations(Array.from({ length: failures }, (_, index) => ({
        executionId: EXECUTION_ID, operationId: `mixed-${index}`,
      })))).rejects.toThrow();
      db.run("DROP TRIGGER reject_receipt_delete");
      expect(() => {
        for (let index = failures; index < 65; index++) writer?.enqueueAcknowledgement(EXECUTION_ID, `mixed-${index}`);
      }).not.toThrow();
      await writer.close();
      expect(db.query("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 0 });
    } finally {
      db.run("DROP TRIGGER IF EXISTS reject_receipt_delete");
      vi.useRealTimers();
    }
  });

  it("surfaces capacity overflow during queued cleanup on close", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const logged = vi.spyOn(logger, "error").mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    for (let index = 0; index < 65; index++) await writer.commit(`overflow-${index}`, batch);
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    try {
      for (let index = 0; index < 65; index++) writer.enqueueAcknowledgement(EXECUTION_ID, `overflow-${index}`);
      await writer.commit("overflow-0", batch);
      await expect.poll(() => logged.mock.calls.filter(([message]) => message === "Canonical writer receipt cleanup exceeded retry capacity").length).toBe(1);
      await writer.owner.barrier();
      db.run("DROP TRIGGER reject_receipt_delete");
      await expect(writer.close()).rejects.toThrow(CanonicalWriterAcknowledgementCapacity);
      expect(writer.pendingAcknowledgementCount).toBe(0);
      expect(db.query("SELECT operation_id FROM canonical_writer_operation_receipts").all()).toEqual([{ operation_id: "overflow-64" }]);
    } finally {
      db.run("DROP TRIGGER IF EXISTS reject_receipt_delete");
      vi.useRealTimers();
      logged.mockRestore();
    }
  });

  it("retries a failed acknowledgement before the next write", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    const batch = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events() };
    await writer.commit("ack-retry-start", batch);
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    await expect(writer.acknowledgeOperations([{ executionId: EXECUTION_ID, operationId: "ack-retry-start" }]))
      .rejects.toThrow("Canonical writer write-failed");
    expect(writer.pendingAcknowledgementCount).toBe(1);
    db.run("DROP TRIGGER reject_receipt_delete");
    expect(await writer.commit("ack-retry-next", batch)).toMatchObject({ outcome: "duplicate" });
    expect(writer.pendingAcknowledgementCount).toBe(0);
    expect(db.prepare("SELECT operation_id FROM canonical_writer_operation_receipts").all())
      .toEqual([{ operation_id: "ack-retry-next" }]);
  });

  it("retries receipt deletion after its committed acknowledgement response is lost", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.commit("lost-ack", { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
      phase: "running", events: events() });
    await writer.close();
    let created = 0;
    writer = new CanonicalAgentWriterClient(dbPath, () => created++ === 0
      ? workerDroppingReply("operations-acknowledged")
      : new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" }));
    const before = db.prepare("SELECT event_id FROM canonical_agent_events").all();
    await writer.acknowledgeOperations([{ executionId: EXECUTION_ID, operationId: "lost-ack" }]);
    await writer.acknowledgeOperations([{ executionId: EXECUTION_ID, operationId: "lost-ack" }]);
    expect(created).toBe(2);
    expect(writer.pendingAcknowledgementCount).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT event_id FROM canonical_agent_events").all()).toEqual(before);
  });

  it("retries failed acknowledgements on close", async () => {
    writer = new CanonicalAgentWriterClient(dbPath);
    await writer.commit("ack-close-start", {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: events(),
    });
    db.run(`CREATE TRIGGER reject_receipt_delete BEFORE DELETE ON canonical_writer_operation_receipts
      BEGIN SELECT RAISE(FAIL, 'ack unavailable'); END`);
    await expect(writer.acknowledgeOperations([{ executionId: EXECUTION_ID, operationId: "ack-close-start" }]))
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
      await expect(writer.acknowledgeOperations([{ executionId: EXECUTION_ID, operationId: `ack-full-${index}` }]))
        .rejects.toThrow("Canonical writer write-failed");
    }
    await expect(writer.acknowledgeOperations([{ executionId: EXECUTION_ID, operationId: "ack-full-64" }]))
      .rejects.toThrow("Canonical writer acknowledgement retry queue is full");
    expect(writer.pendingAcknowledgementCount).toBe(64);
    await expect(writer.close()).rejects.toThrow(CanonicalWriterAcknowledgementCapacity);
  }, 30_000);
});
