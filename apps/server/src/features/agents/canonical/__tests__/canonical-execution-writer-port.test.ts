import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { AgentEventType, type AgentEvent, type ProviderRuntimeExtension } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { deriveTurnAssistantMessageId } from "../../turns/turn-assistant-message-id.js";
import { ExecutionMailboxScheduler } from "../../execution/execution-mailbox-scheduler.js";
import type { ExecutionLease } from "../../execution/execution-mailbox-protocol.js";
import { ExecutionThreadWorkerPort } from "../../execution/execution-worker-port.js";
import { AgentEventPublicationRegistry } from "../../orchestration/agent-event-publication-registry.js";
import type { ExecutionSemanticOperation, ExecutionWorkCommand, ExecutionWorkerResult } from "../../execution/execution-worker-handler.js";
import { CanonicalAgentWriterClient } from "../canonical-agent-writer-client.js";
import { CanonicalExecutionWriterPort } from "../canonical-execution-writer-port.js";
import { ExecutionLivePublicationRelease } from "../execution-live-publication-release.js";

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

function runtimeDraft(
  sequence: number,
  event: AgentEvent,
  extension?: ProviderRuntimeExtension,
): Extract<ExecutionSemanticOperation["mutation"], { kind: "append-events" }>["events"][number] {
  const itemId = `runtime-item-${sequence}`;
  return {
    eventId: `${EXECUTION_ID}:runtime-${sequence}`,
    routing: { ...execution, itemId },
    sourceProviderId: "codex", sourceIdentities: [], sourceSequence: sequence,
    payload: { type: "item.recorded", item: {
      id: itemId, threadId: THREAD_ID, turnId: TURN_ID, kind: "system",
      providerIdentities: [],
      payload: { projection: "providerRuntimeEvent", runtimeEvent: {
        event, ...(extension ? { extension } : {}),
      } },
      createdAt: NOW, updatedAt: NOW,
    } },
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

  it("releases live receipts in order after their writer and terminal barriers", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const registry = new AgentEventPublicationRegistry();
    const published: AgentEvent[] = [];
    registry.bind((event) => published.push(event));
    const release = new ExecutionLivePublicationRelease(registry);
    const port = new CanonicalExecutionWriterPort(writer, () => {}, release);
    const started = { type: AgentEventType.TurnStarted, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID };
    const begin: ExecutionSemanticOperation = {
      ...beginOperation(), livePublication: [{ after: "writer", event: started }],
    };
    expect((await port.transact(begin)).kind).toBe("committed");
    expect(published.map((event) => event.type)).toEqual([AgentEventType.TurnStarted]);
    expect(published[0]?.publicationId).toBe("1");

    const delta: AgentEvent = { type: AgentEventType.TextDelta, threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID, delta: "answer", isFinalResponse: true };
    const system: AgentEvent = { type: AgentEventType.System, threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID, subtype: "test" };
    const append: ExecutionSemanticOperation = {
      operationId: `${lease.leaseId}:2`, execution, lease, ordinal: 2,
      mutation: { kind: "append-events", phase: "running", nativeCursor: null,
        events: [runtimeDraft(1, delta), runtimeDraft(2, system)] },
      livePublication: [{ after: "writer", event: delta }, { after: "writer", event: system }],
    };
    expect((await port.transact(append)).kind).toBe("committed");
    expect(published.map((event) => event.type))
      .toEqual([AgentEventType.TurnStarted, AgentEventType.TextDelta, AgentEventType.System]);
    expect(published.slice(1).map((event) => event.publicationId))
      .toEqual(["2", "3"]);
    expect((await port.transact(append)).kind).toBe("committed");
    expect(published).toHaveLength(3);

    const staged = new MessageRepo(db).create(THREAD_ID, "assistant", "Answer", 2,
      undefined, undefined, undefined, "model", true);
    const ended: AgentEvent = { type: AgentEventType.Ended, threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID, outcome: "completed" };
    const finish: ExecutionSemanticOperation = {
      operationId: `${lease.leaseId}:3`, execution, lease, ordinal: 3,
      mutation: { kind: "finish", outcome: "completed", input: {
        threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, providerId: "codex",
        providerIdentities: [], outcome: "completed", projection: { message: staged, narrative: [] },
      } },
      livePublication: [{ after: "terminal", event: ended }],
    };
    db.run("CREATE TRIGGER fail_live_release BEFORE UPDATE OF kind ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:finish' BEGIN SELECT RAISE(ABORT, 'finish unavailable'); END");
    await expect(port.transact(finish)).rejects.toThrow("Canonical writer write-failed");
    expect(published).toHaveLength(3);
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ terminal_outcome: null });
    db.run("DROP TRIGGER fail_live_release");

    expect((await port.transact(finish)).kind).toBe("committed");
    expect(published.map((event) => event.type))
      .toEqual([AgentEventType.TurnStarted, AgentEventType.TextDelta, AgentEventType.System, AgentEventType.Ended]);
    expect((await port.transact(finish)).kind).toBe("committed");
    expect(published).toHaveLength(4);
  });

  it("carries a live publication from the execution worker to the bound host publisher", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const registry = new AgentEventPublicationRegistry();
    const published: AgentEvent[] = [];
    registry.bind((event) => published.push(event));
    const release = new ExecutionLivePublicationRelease(registry);
    const port = new CanonicalExecutionWriterPort(writer, () => {}, release);
    const scheduler = new ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>({
      workerCount: 1,
      limits: {
        maxPending: 4, maxPendingBytes: 8_000, reservedControl: 2, reservedControlBytes: 4_000,
        maxPerExecutionPending: 4, maxPerExecutionBytes: 8_000,
        reservedPerExecutionControl: 2, reservedPerExecutionControlBytes: 4_000,
      },
      createWorker: () => new ExecutionThreadWorkerPort(port),
      onWorkerLost: () => { throw new Error("Execution worker was lost"); },
    });
    try {
      const claim = scheduler.claim(execution, 1);
      if (claim.kind !== "claimed") throw new Error(`Execution claim failed: ${claim.kind}`);
      const begin = beginOperation().mutation;
      if (begin.kind !== "begin") throw new Error("Unexpected begin operation");
      const admission = scheduler.submit({ execution, lease: claim.lease, byteLength: 1_000,
        command: { kind: "start", providerId: "codex", input: begin.input,
          livePublication: [{ after: "writer", event: {
            type: AgentEventType.TurnStarted, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
          } }],
        },
      });
      if (admission.kind !== "admitted") throw new Error(`Execution admission failed: ${admission.kind}`);
      await expect(admission.completion).resolves.toMatchObject({ kind: "reply", result: {
        kind: "committed", livePublication: [{ publicationId: "1" }],
      } });
      expect(published.map((event) => event.type)).toEqual([AgentEventType.TurnStarted]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?").get(THREAD_ID))
        .toEqual({ count: 1 });
    } finally {
      scheduler.shutdown();
    }
  });

  it("releases a compound live event after its single writer receipt", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const registry = new AgentEventPublicationRegistry();
    const published: AgentEvent[] = [];
    registry.bind((event) => published.push(event));
    const port = new CanonicalExecutionWriterPort(writer, () => {}, new ExecutionLivePublicationRelease(registry));
    expect((await port.transact(beginOperation())).kind).toBe("committed");
    const event: AgentEvent = { type: AgentEventType.AssistantMessageBoundary, threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID, isFinalResponse: false };
    const operation: ExecutionSemanticOperation = {
      operationId: `${lease.leaseId}:2`, execution, lease, ordinal: 2,
      mutation: { kind: "live-event", text: { kind: "unchanged" } },
      livePublication: [{ after: "writer", event }],
    };
    expect((await port.transact(operation)).kind).toBe("committed");
    expect(published).toEqual([{ ...event, publicationId: "1" }]);
    expect((await port.transact(operation)).kind).toBe("committed");
    expect(published).toEqual([{ ...event, publicationId: "1" }]);
  });

  it("replays a committed live receipt when the public publisher becomes available", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const registry = new AgentEventPublicationRegistry();
    const release = new ExecutionLivePublicationRelease(registry);
    const port = new CanonicalExecutionWriterPort(writer, () => {}, release);
    const begin: ExecutionSemanticOperation = { ...beginOperation(), livePublication: [{
      after: "writer", event: {
        type: AgentEventType.TurnStarted, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
      },
    }] };
    await expect(port.transact(begin)).rejects.toThrow("Live AgentEvent publisher is not bound");
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?").get(THREAD_ID))
      .toEqual({ count: 1 });
    const published: AgentEvent[] = [];
    registry.bind((event) => published.push(event));
    expect((await port.transact(begin)).kind).toBe("committed");
    expect(published.map((event) => event.type)).toEqual([AgentEventType.TurnStarted]);
    expect((await port.transact(begin)).kind).toBe("committed");
    expect(published).toHaveLength(1);
  });

  it("replays the same public identity when publication succeeds before the host loses its reply", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const registry = new AgentEventPublicationRegistry();
    const published: AgentEvent[] = [];
    let loseReply = true;
    registry.bind((event) => {
      published.push(event);
      if (loseReply) {
        loseReply = false;
        throw new Error("host lost reply after publish");
      }
    });
    const operation: ExecutionSemanticOperation = { ...beginOperation(), livePublication: [{
      after: "writer", event: {
        type: AgentEventType.TurnStarted, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
      },
    }] };
    const firstHost = new CanonicalExecutionWriterPort(writer, () => {}, new ExecutionLivePublicationRelease(registry));
    await expect(firstHost.transact(operation)).rejects.toThrow("host lost reply after publish");
    const restartedHost = new CanonicalExecutionWriterPort(writer, () => {}, new ExecutionLivePublicationRelease(registry));
    expect((await restartedHost.transact(operation)).kind).toBe("committed");
    expect(published.map((event) => event.publicationId))
      .toEqual(["1", "1"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?").get(THREAD_ID))
      .toEqual({ count: 1 });
  });

  it("keeps releasing after the recent host cache reaches an all-day event count", () => {
    let published = 0;
    const release = new ExecutionLivePublicationRelease({
      isBound: () => true,
      publish: () => { published++; },
    });
    const started: AgentEvent = { type: AgentEventType.TurnStarted, threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID };
    for (let ordinal = 1; ordinal <= 8_193; ordinal++) {
      const operationId = `${lease.leaseId}:${ordinal}`;
      const operation: ExecutionSemanticOperation = { ...beginOperation(), operationId, ordinal,
        livePublication: [{ after: "writer", event: started }] };
      release.release(operation, { kind: "committed", operationId, durableRevision: ordinal,
        livePublication: [{ after: "writer", event: started,
          publicationId: String(ordinal) }] });
    }
    expect(published).toBe(8_193);
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

  it("delivers a large committed event batch in bounded publication pages", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const pageSizes: number[] = [];
    const published: string[] = [];
    const port = new CanonicalExecutionWriterPort(writer, (events) => {
      pageSizes.push(events.length);
      published.push(...events.map((event) => event.eventId));
    });
    expect(await port.transact(beginOperation())).toMatchObject({ kind: "committed" });
    pageSizes.length = 0;
    published.length = 0;
    const events = Array.from({ length: 130 }, (_, index) => runtimeDraft(index + 1, {
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID,
      delta: "x",
      isFinalResponse: true,
    }));
    const operation: ExecutionSemanticOperation = {
      operationId: `${lease.leaseId}:2`, execution, lease, ordinal: 2,
      mutation: { kind: "append-events", phase: "running", nativeCursor: null, events },
    };
    expect(await port.transact(operation)).toMatchObject({ kind: "committed" });
    expect(pageSizes).toEqual([64, 64, 2]);
    expect(published).toEqual(events.map((event) => event.eventId));
    pageSizes.length = 0;
    published.length = 0;
    expect(await port.transact(operation)).toMatchObject({ kind: "committed" });
    expect(pageSizes).toEqual([64, 64, 2]);
    expect(published).toEqual(events.map((event) => event.eventId));
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

  it("commits and replays worker-loss interruption through the SQLite writer worker", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const published: string[] = [];
    const port = new CanonicalExecutionWriterPort(writer, (events) => {
      published.push(...events.map((event) => event.eventId));
    });
    const input = { execution, lease, reason: "Execution worker exited", recoveryIncidentId: "incident-1" };
    expect(await port.interruptWorkerLoss(input)).toEqual({
      kind: "conflict", operationId: `${lease.leaseId}:worker-lost`, recoveryState: "not-started",
    });
    expect(await port.transact(beginOperation())).toMatchObject({ kind: "committed" });
    expect(await port.interruptWorkerLoss({ ...input, lease: { ...lease, ownerEpoch: 2 } }))
      .toEqual({ kind: "conflict", operationId: `${lease.leaseId}:worker-lost` });
    const first = await port.interruptWorkerLoss(input);
    expect(first).toMatchObject({ kind: "committed", operationId: `${lease.leaseId}:worker-lost` });
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ terminal_outcome: "interrupted" });
    expect(published).toContain(`${EXECUTION_ID}:recovery-interrupted`);
    published.length = 0;
    expect(await port.interruptWorkerLoss(input)).toEqual(first);
    expect(published).toContain(`${EXECUTION_ID}:recovery-interrupted`);
    expect(await port.transact({
      operationId: `${lease.leaseId}:2`, execution, lease, ordinal: 2,
      mutation: { kind: "checkpoint", phase: "running", nativeCursor: null },
    })).toEqual({ kind: "conflict", operationId: `${lease.leaseId}:2` });
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

  it("stages and finalizes assistant rows without a main-connection projection write", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const published: string[] = [];
    const port = new CanonicalExecutionWriterPort(writer, (events) => {
      published.push(...events.map((event) => event.eventId));
    });
    const op = (ordinal: number, mutation: ExecutionSemanticOperation["mutation"]): ExecutionSemanticOperation => ({
      operationId: `${lease.leaseId}:${ordinal}`, execution, lease, ordinal, mutation,
    });
    expect(await port.transact(beginOperation())).toMatchObject({ kind: "committed" });
    const terminalInput = {
      threadId: THREAD_ID, executionId: EXECUTION_ID, outcome: "completed" as const, endedAt: NOW,
      assistant: { content: "Answer", model: "fixture", attachments: [] }, narrative: [],
    };
    expect(await port.transact(op(2, { kind: "provider-outcome", outcome: "completed" })))
      .toMatchObject({ kind: "committed" });
    const staged = op(3, { kind: "stage-terminal", input: terminalInput });
    expect(await port.transact(staged)).toMatchObject({ kind: "committed" });
    expect(db.prepare("SELECT content, is_internal FROM messages WHERE role = 'assistant'").get())
      .toEqual({ content: "Answer", is_internal: 1 });
    const stagedId = deriveTurnAssistantMessageId(THREAD_ID, `execution:${EXECUTION_ID}`);
    expect(new MessageRepo(db).findByIdInThreadIncludingInternal(THREAD_ID, stagedId))
      .toMatchObject({ content: "Answer", is_internal: true });
    expect(published).not.toContain(`${EXECUTION_ID}:turn.completed`);

    const finish = op(4, { kind: "finish", outcome: "completed", input: {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, providerId: "codex",
      providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" },
    } });
    expect(await port.transact(finish)).toMatchObject({ kind: "committed" });
    expect(db.prepare("SELECT content, is_internal, outcome FROM messages WHERE role = 'assistant'").get())
      .toEqual({ content: "Answer", is_internal: 0, outcome: "completed" });
    expect(published).toContain(`${EXECUTION_ID}:turn.completed`);
    expect(await port.transact(staged)).toMatchObject({ kind: "committed" });
    expect(await port.transact(finish)).toMatchObject({ kind: "committed" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'").get())
      .toEqual({ count: 1 });
  });

  it("rolls back a failed semantic terminal stage and retries at the same ordinal", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const port = new CanonicalExecutionWriterPort(writer, () => {});
    expect(await port.transact(beginOperation())).toMatchObject({ kind: "committed" });
    expect(await port.transact({
      operationId: `${lease.leaseId}:2`, execution, lease, ordinal: 2,
      mutation: { kind: "provider-outcome", outcome: "completed" },
    })).toMatchObject({ kind: "committed" });
    const stage: ExecutionSemanticOperation = {
      operationId: `${lease.leaseId}:3`, execution, lease, ordinal: 3,
      mutation: { kind: "stage-terminal", input: {
        threadId: THREAD_ID, executionId: EXECUTION_ID, outcome: "completed", endedAt: NOW,
        assistant: { content: "Answer", model: null, attachments: [] }, narrative: [],
      } },
    };
    db.run(`CREATE TRIGGER reject_terminal_stage BEFORE INSERT ON messages
      WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(FAIL, 'injected terminal failure'); END`);
    await expect(port.transact(stage)).rejects.toThrow("Canonical writer write-failed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE operation_id = ?")
      .get(stage.operationId)).toEqual({ count: 0 });

    db.run("DROP TRIGGER reject_terminal_stage");
    expect(await port.transact(stage)).toMatchObject({ kind: "committed", operationId: stage.operationId });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant' AND is_internal = 1").get())
      .toEqual({ count: 1 });
  });

  it("fences a stopped execution to a cancelled durable outcome", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const port = new CanonicalExecutionWriterPort(writer, () => {});
    const op = (ordinal: number, mutation: ExecutionSemanticOperation["mutation"]): ExecutionSemanticOperation => ({
      operationId: `${lease.leaseId}:${ordinal}`, execution, lease, ordinal, mutation,
    });
    expect(await port.transact(beginOperation())).toMatchObject({ kind: "committed" });
    expect(await port.transact(op(2, {
      kind: "stop-requested", requestId: "stop-1", lastAdmittedOrdinal: 1,
    }))).toMatchObject({ kind: "committed" });
    const nativeCursor = { providerId: "codex", scope: "thread", value: "native-thread", provenance: "native" };
    expect(await port.transact(op(3, { kind: "checkpoint", phase: "stopping", nativeCursor })))
      .toMatchObject({ kind: "committed" });
    expect(db.prepare("SELECT phase, native_cursor_json FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ phase: "stopping", native_cursor_json: JSON.stringify(nativeCursor) });
    expect(await port.transact(op(4, { kind: "provider-outcome", outcome: "completed" })))
      .toEqual({ kind: "conflict", operationId: `${lease.leaseId}:4` });
    expect(await port.transact(op(4, { kind: "provider-outcome", outcome: "cancelled" })))
      .toMatchObject({ kind: "committed" });
    expect(await port.transact(op(5, { kind: "stage-terminal", input: {
      threadId: THREAD_ID, executionId: EXECUTION_ID, outcome: "cancelled", endedAt: NOW,
      assistant: { content: "Partial answer", model: null, attachments: [] }, narrative: [],
    } }))).toMatchObject({ kind: "committed" });
    expect(await port.transact(op(6, { kind: "finish", outcome: "cancelled", input: {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, providerId: "codex",
      providerIdentities: [], outcome: "cancelled", projection: { kind: "writer-staged" },
    } }))).toMatchObject({ kind: "committed" });
    expect(db.prepare("SELECT outcome FROM messages WHERE role = 'assistant'").get())
      .toEqual({ outcome: "cancelled" });
  });

  it("runs a complete assistant turn through an execution worker and the sole writer worker", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const published: string[] = [];
    const port = new CanonicalExecutionWriterPort(writer, (events) => {
      published.push(...events.map((event) => event.eventId));
    });
    const scheduler = new ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>({
      workerCount: 1,
      limits: {
        maxPending: 16, maxPendingBytes: 64_000, reservedControl: 4, reservedControlBytes: 16_000,
        maxPerExecutionPending: 12, maxPerExecutionBytes: 48_000,
        reservedPerExecutionControl: 3, reservedPerExecutionControlBytes: 12_000,
      },
      createWorker: () => new ExecutionThreadWorkerPort(port),
      onWorkerLost: () => { throw new Error("Execution worker was lost"); },
    });
    try {
      const claim = scheduler.claim(execution, 1);
      if (claim.kind !== "claimed") throw new Error(`Execution claim failed: ${claim.kind}`);
      const send = (lease: ExecutionLease, command: Parameters<typeof scheduler.submit>[0]["command"]) => {
        const admission = scheduler.submit({ execution, lease, command, byteLength: 1_000 });
        if (admission.kind !== "admitted") throw new Error(`Execution admission failed: ${admission.kind}`);
        return admission.completion;
      };
      const start = beginOperation().mutation;
      if (start.kind !== "begin") throw new Error("Unexpected begin operation");
      await expect(send(claim.lease, { kind: "start", providerId: "codex", input: start.input }))
        .resolves.toMatchObject({ kind: "reply", result: { kind: "committed" } });
      const nativeCursor = { providerId: "codex", scope: "thread", value: "native-worker-thread", provenance: "native" };
      await expect(send(claim.lease, { kind: "event", phase: "running", nativeCursor, events: [{
        eventId: `${EXECUTION_ID}:worker-item`,
        routing: { ...execution, itemId: "worker-item" },
        sourceProviderId: "codex", sourceIdentities: [], sourceSequence: 1,
        payload: { type: "item.recorded", item: {
          id: "worker-item", threadId: THREAD_ID, turnId: TURN_ID, kind: "message",
          providerIdentities: [], payload: { projection: "message", content: "Worker event" },
          createdAt: NOW, updatedAt: NOW,
        } },
      }] })).resolves.toMatchObject({
        kind: "reply",
        result: { kind: "committed", providerCommit: { outcome: "committed", eventCount: 1 } },
      });
      expect(db.prepare("SELECT native_cursor_json FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
        .get(EXECUTION_ID)).toEqual({ native_cursor_json: JSON.stringify(nativeCursor) });
      await expect(send(claim.lease, { kind: "provider-outcome", outcome: "completed" }))
        .resolves.toMatchObject({ kind: "reply", result: { kind: "committed" } });
      await expect(send(claim.lease, { kind: "stage-terminal", input: {
        threadId: THREAD_ID, executionId: EXECUTION_ID, outcome: "completed", endedAt: NOW,
        assistant: { content: "Worker answer", model: null, attachments: [] }, narrative: [],
      } })).resolves.toMatchObject({ kind: "reply", result: { kind: "committed" } });
      await expect(send(claim.lease, { kind: "finalize", outcome: "completed", input: {
        threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, providerId: "codex",
        providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" },
      } })).resolves.toMatchObject({ kind: "reply", result: { kind: "committed" } });
      await expect(send(claim.lease, { kind: "release" }))
        .resolves.toEqual({ kind: "reply", result: { kind: "released" } });
      expect(scheduler.release(execution, claim.lease)).toBe(true);
      expect(db.prepare("SELECT content, outcome FROM messages WHERE role = 'assistant' AND is_internal = 0").get())
        .toEqual({ content: "Worker answer", outcome: "completed" });
      expect(published).toContain(`${EXECUTION_ID}:worker-item`);
      expect(published.indexOf(`${EXECUTION_ID}:worker-item`))
        .toBeLessThan(published.indexOf(`${EXECUTION_ID}:turn.completed`));
      expect(published).toContain(`${EXECUTION_ID}:turn.completed`);
      expect(await port.interruptWorkerLoss({
        execution, lease: claim.lease, reason: "Execution worker exited", recoveryIncidentId: "incident-complete",
      })).toEqual({
        kind: "conflict", operationId: `${claim.lease.leaseId}:worker-lost`, recoveryState: "already-terminal",
      });
    } finally {
      scheduler.shutdown();
    }
  });

  it("stages a partial assistant after Stop before the cancelled terminal commit", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const port = new CanonicalExecutionWriterPort(writer, () => {});
    const scheduler = new ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>({
      workerCount: 1,
      limits: {
        maxPending: 16, maxPendingBytes: 64_000, reservedControl: 4, reservedControlBytes: 16_000,
        maxPerExecutionPending: 12, maxPerExecutionBytes: 48_000,
        reservedPerExecutionControl: 3, reservedPerExecutionControlBytes: 12_000,
      },
      createWorker: () => new ExecutionThreadWorkerPort(port),
      onWorkerLost: () => { throw new Error("Execution worker was lost"); },
    });
    try {
      const claim = scheduler.claim(execution, 1);
      if (claim.kind !== "claimed") throw new Error(`Execution claim failed: ${claim.kind}`);
      const send = (command: Parameters<typeof scheduler.submit>[0]["command"]) => {
        const admission = scheduler.submit({ execution, lease: claim.lease, command, byteLength: 1_000 });
        if (admission.kind !== "admitted") throw new Error(`Execution admission failed: ${admission.kind}`);
        return admission.completion;
      };
      const start = beginOperation().mutation;
      if (start.kind !== "begin") throw new Error("Unexpected begin operation");
      expect((await send({ kind: "start", providerId: "codex", input: start.input })).kind).toBe("reply");
      expect((await send({ kind: "stop", requestId: "stop-partial" })).kind).toBe("reply");
      expect((await send({ kind: "provider-outcome", outcome: "cancelled" })).kind).toBe("reply");
      expect((await send({ kind: "stage-terminal", input: {
        threadId: THREAD_ID, executionId: EXECUTION_ID, outcome: "cancelled", endedAt: NOW,
        assistant: { content: "Partial answer", model: null, attachments: [] }, narrative: [],
      } })).kind).toBe("reply");
      await expect(send({ kind: "finalize", outcome: "cancelled", input: {
        threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, providerId: "codex",
        providerIdentities: [], outcome: "cancelled", projection: { kind: "writer-staged" },
      } })).resolves.toMatchObject({ kind: "reply", result: { kind: "committed" } });
      expect(db.prepare("SELECT content, outcome FROM messages WHERE role = 'assistant' AND is_internal = 0").get())
        .toEqual({ content: "Partial answer", outcome: "cancelled" });
    } finally {
      scheduler.shutdown();
    }
  });

  it("projects Codex parent and child events on the writer and replays without repeating child writes", async () => {
    writer = new CanonicalAgentWriterClient(NodePath.join(directory, "app.sqlite"));
    const published: string[] = [];
    const port = new CanonicalExecutionWriterPort(writer, (events) => {
      published.push(...events.map((event) => event.eventId));
    });
    const scheduler = new ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>({
      workerCount: 1,
      limits: {
        maxPending: 16, maxPendingBytes: 64_000, reservedControl: 4, reservedControlBytes: 16_000,
        maxPerExecutionPending: 12, maxPerExecutionBytes: 48_000,
        reservedPerExecutionControl: 3, reservedPerExecutionControlBytes: 12_000,
      },
      createWorker: () => new ExecutionThreadWorkerPort(port),
      onWorkerLost: () => { throw new Error("Execution worker was lost"); },
    });
    try {
      const claim = scheduler.claim(execution, 1);
      if (claim.kind !== "claimed") throw new Error(`Execution claim failed: ${claim.kind}`);
      const send = (command: Parameters<typeof scheduler.submit>[0]["command"]) => {
        const admission = scheduler.submit({ execution, lease: claim.lease, command, byteLength: 1_000 });
        if (admission.kind !== "admitted") throw new Error(`Execution admission failed: ${admission.kind}`);
        return admission.completion;
      };
      const start = beginOperation().mutation;
      if (start.kind !== "begin") throw new Error("Unexpected begin operation");
      await expect(send({ kind: "start", providerId: "codex", input: start.input }))
        .resolves.toMatchObject({ kind: "reply", result: { kind: "committed" } });

      const parent = runtimeDraft(1, {
        type: AgentEventType.ToolUse, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
        toolCallId: "spawn-1", toolName: "Agent", toolInput: {},
      }, {
        providerId: "codex", kind: "codex-collaboration",
        collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-child"], prompt: "Inspect the task" },
      });
      const parentCommand = { kind: "event" as const, phase: "running", nativeCursor: null, events: [parent] };
      await expect(send(parentCommand)).resolves.toMatchObject({
        kind: "reply", result: { kind: "committed", providerEvents: [{
          event: { type: AgentEventType.ToolUse, toolInput: {}, subagentPresentation: {
            detail: { kind: "canonical-child" },
          } },
        }] },
      });
      const delegation = db.prepare("SELECT target_thread_id FROM canonical_collaboration_actions WHERE source_item_id = ?")
        .get("toolCall:spawn-1");
      expect(delegation).toMatchObject({ target_thread_id: expect.any(String) });
      const parentOperation: ExecutionSemanticOperation = {
        operationId: `${claim.lease.leaseId}:2`, execution, lease: claim.lease, ordinal: 2,
        mutation: { kind: "append-events", phase: "running", nativeCursor: null, events: [parent] },
      };
      const replayedParent = await port.transact(parentOperation);
      expect(replayedParent).toMatchObject({ kind: "committed", providerEvents: [{
        event: { toolInput: {}, subagentPresentation: { detail: { kind: "canonical-child" } } },
      }] });
      expect(replayedParent).toMatchObject(db.prepare("SELECT last_durable_sequence AS durableRevision FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
        .get(EXECUTION_ID));
      expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_collaboration_actions WHERE source_item_id = ?")
        .get("toolCall:spawn-1")).toEqual({ count: 1 });

      const child = runtimeDraft(2, {
        type: AgentEventType.TurnStarted, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
      }, {
        providerId: "codex", kind: "codex-collaboration",
        child: { nativeThreadId: "native-child", nativeTurnId: "native-turn", parentCollaborationItemId: "spawn-1" },
      });
      await expect(send({ kind: "event", phase: "running", nativeCursor: null, events: [child] }))
        .resolves.toMatchObject({ kind: "reply", result: { kind: "committed", providerEvents: [] } });
      expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns WHERE thread_id = (SELECT target_thread_id FROM canonical_collaboration_actions WHERE source_item_id = ?)")
        .get("toolCall:spawn-1")).toEqual({ count: 1 });
      const childEventsBefore = db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE thread_id = (SELECT target_thread_id FROM canonical_collaboration_actions WHERE source_item_id = ?)")
        .get("toolCall:spawn-1");
      expect(childEventsBefore).toMatchObject({ count: expect.any(Number) });
      const publishedBeforeReplay = published.length;
      expect(await port.transact({
        operationId: `${claim.lease.leaseId}:3`, execution, lease: claim.lease, ordinal: 3,
        mutation: { kind: "append-events", phase: "running", nativeCursor: null, events: [child] },
      })).toMatchObject({ kind: "committed", providerEvents: [] });
      expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE thread_id = (SELECT target_thread_id FROM canonical_collaboration_actions WHERE source_item_id = ?)")
        .get("toolCall:spawn-1")).toEqual(childEventsBefore);
      expect(published.length).toBeGreaterThan(publishedBeforeReplay);
      expect(published).toContain(parent.eventId);
      expect(published).toContain(child.eventId);
    } finally {
      scheduler.shutdown();
    }
  });

});
