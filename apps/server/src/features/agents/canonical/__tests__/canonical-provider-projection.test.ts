import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { AgentEventType, type AgentEvent, type ProviderRuntimeExtension } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { CanonicalAgentWriterClient } from "../canonical-agent-writer-client.js";
import { CanonicalParentTurnWrite } from "../canonical-parent-turn-write.js";
import type { CanonicalAgentEventDraft } from "../canonical-agent-store.js";

const NOW = "2026-10-01T12:00:00.000Z";
const execution = { threadId: "projection-parent", turnId: "projection-turn", executionId: "00000000-0000-4000-8000-000000000991" };

function draft(sequence: number, event: AgentEvent, extension?: ProviderRuntimeExtension): CanonicalAgentEventDraft {
  const itemId = `projection-item-${sequence}`;
  return { eventId: `${execution.executionId}:${sequence}`, routing: { ...execution, itemId },
    sourceProviderId: "codex", sourceIdentities: [], sourceSequence: sequence,
    payload: { type: "item.recorded", item: { id: itemId, threadId: execution.threadId, turnId: execution.turnId,
      kind: "system", providerIdentities: [], createdAt: NOW, updatedAt: NOW,
      payload: { projection: "providerRuntimeEvent", runtimeEvent: { event, ...(extension ? { extension } : {}) } },
    } },
  };
}

function spawn() {
  return draft(1, { type: AgentEventType.ToolUse, threadId: execution.threadId, turnExecutionId: execution.executionId,
    toolCallId: "spawn-1", toolName: "Agent", toolInput: {} }, {
    providerId: "codex", kind: "codex-collaboration",
    collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-child"], prompt: "Inspect the fixture" },
  });
}

function dropCommittedReply(): Worker {
  const worker = new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" });
  return new Proxy(worker, {
    set(target, property, value) {
      if (property !== "onmessage" || typeof value !== "function") return Reflect.set(target, property, value);
      target.onmessage = (message) => {
        if (message.data.kind === "committed") { target.terminate(); return; }
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

describe("legacy provider transaction projection", () => {
  let directory: string;
  let db: Database;
  let owner: ApplicationDatabaseWriter | undefined;
  let client: CanonicalAgentWriterClient | undefined;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-provider-projection-"));
    db = openDatabase({ dbPath: NodePath.join(directory, "app.sqlite") });
    db.run("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", ["projection-workspace", "Workspace", directory, NOW, NOW]);
    db.run("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [execution.threadId, "projection-workspace", "Thread", "main", "codex", NOW, NOW]);
    new CanonicalParentTurnWrite(db, () => {}).start({
      thread: { id: execution.threadId, workspaceId: "projection-workspace", providerId: "codex", createdAt: NOW },
      turnId: execution.turnId, executionId: execution.executionId, permissionMode: "supervised", providerIdentities: [],
      userMessage: { kind: "create", messageId: "projection-user", content: "Inspect", sequence: 1 },
    });
  });

  afterEach(async () => {
    await client?.close();
    await owner?.close();
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("replays a lost reply and child publications without repeating child writes or interrupting the parent", async () => {
    let workers = 0;
    owner = new ApplicationDatabaseWriter(NodePath.join(directory, "app.sqlite"), () => ++workers === 1
      ? dropCommittedReply() : new Worker(new URL("../canonical-agent-writer.worker.ts", import.meta.url), { type: "module" }));
    client = new CanonicalAgentWriterClient(owner);
    const batch = { ...execution, phase: "running", events: [spawn()] };
    const result = await client.commitProjected("projected:spawn", batch);
    expect(workers).toBe(2);
    expect(result.events).toHaveLength(1);
    expect(result.providerProjection.events).toMatchObject([{ event: { toolCallId: "spawn-1",
      subagentPresentation: { detail: { kind: "canonical-child" } } } }]);
    expect(result.providerProjection.publications.some((event) => event.payload.type === "child-thread.recorded")).toBe(true);
    expect(await client.commitProjected("projected:spawn", batch)).toEqual(result);
    await expect(client.commit("projected:spawn", batch)).rejects.toThrow("operation-conflict");
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_collaboration_actions WHERE source_item_id = ?").get("toolCall:spawn-1")).toEqual({ count: 1 });
    const childDraft = draft(2, { type: AgentEventType.TurnStarted, threadId: execution.threadId, turnExecutionId: execution.executionId }, {
      providerId: "codex", kind: "codex-collaboration",
      child: { nativeThreadId: "native-child", nativeTurnId: "native-turn", parentCollaborationItemId: "spawn-1" },
    });
    const childBatch = { ...execution, phase: "running", events: [childDraft] };
    const started = await client.commitProjected("projected:child", childBatch);
    expect(started.providerProjection.events).toEqual([]);
    expect(started.providerProjection.publications.some((event) => event.routing.executionId !== execution.executionId)).toBe(true);
    const count = db.query("SELECT COUNT(*) AS count FROM canonical_agent_events").get();
    expect(await client.commitProjected("projected:child", childBatch)).toEqual(started);
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual(count);
    expect(db.query("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Running" });
  });

  it("rolls back partial child writes, retains the routing diagnostic and permits the next provider batch", async () => {
    db.run("CREATE TRIGGER reject_projection BEFORE INSERT ON canonical_collaboration_actions BEGIN SELECT RAISE(ABORT, 'child projection failed'); END");
    owner = new ApplicationDatabaseWriter(NodePath.join(directory, "app.sqlite"));
    client = new CanonicalAgentWriterClient(owner);
    const event = spawn();
    const rejected = await client.commitProjected("projected:failed", { ...execution, phase: "running", events: [event] });
    expect(rejected.providerProjection.events).toEqual([]);
    expect(rejected.providerProjection.publications).toMatchObject([
      { eventId: event.eventId },
      { payload: { type: "item.recorded", item: { payload: { projection: "codexChildRoutingFailure" } } } },
    ]);
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE event_id = ?").get(event.eventId)).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_collaboration_actions").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_threads").get()).toEqual({ count: 1 });
    const next = draft(2, { type: AgentEventType.TextDelta, threadId: execution.threadId, turnExecutionId: execution.executionId, delta: "Parent continues" });
    const saved = await client.commitProjected("projected:next", { ...execution, phase: "running", events: [next] });
    expect(saved.providerProjection.events).toMatchObject([{ event: { delta: "Parent continues" } }]);
    expect(db.query("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Running" });
  });

  it("rolls back both raw and child state when the final receipt cannot commit", async () => {
    db.run("CREATE TRIGGER reject_receipt BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.operation_id = 'projected:failed' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END");
    owner = new ApplicationDatabaseWriter(NodePath.join(directory, "app.sqlite"));
    client = new CanonicalAgentWriterClient(owner);
    const event = spawn();
    await expect(client.commitProjected("projected:failed", { ...execution, phase: "running", events: [event] }))
      .rejects.toThrow("receipt failed");
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE event_id = ?").get(event.eventId)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_collaboration_actions").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM canonical_agent_threads").get()).toEqual({ count: 1 });
    const next = draft(2, { type: AgentEventType.TextDelta, threadId: execution.threadId, turnExecutionId: execution.executionId, delta: "Still running" });
    const saved = await client.commitProjected("projected:next", { ...execution, phase: "running", events: [next] });
    expect(saved.providerProjection.events).toMatchObject([{ event: { delta: "Still running" } }]);
  });
});
