import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { TaskRepo } from "../../orchestration/persistence/task-repo.js";
import { CodexLiveEventReducer } from "../../execution/codex-live-event-reducer.js";
import type { ExecutionSemanticOperation } from "../../execution/execution-worker-handler.js";
import { ExecutionWorkerHandler } from "../../execution/execution-worker-handler.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { CodexParentMessageProjection } from "../../turns/codex-parent-message-projection.js";
import { NarrativeRecoveryDelta } from "../../turns/narrative-recovery-delta.js";
import { CanonicalAgentBoundary } from "../canonical-agent-boundary.js";
import type { CodexSystemWriterIntent } from "../canonical-codex-system-error-projection.js";
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

function runtimeEvent(sequence: number, agentEvent: AgentEvent): Extract<
  ExecutionSemanticOperation["mutation"], { kind: "append-events" }
>["events"][number] {
  const itemId = `runtime-${sequence}`;
  return {
    eventId: `${EXECUTION_ID}:${itemId}`,
    routing: { ...execution, itemId },
    sourceProviderId: "codex",
    sourceIdentities: [],
    sourceSequence: sequence,
    payload: { type: "item.recorded", item: {
      id: itemId, threadId: THREAD_ID, turnId: TURN_ID, kind: "system",
      providerIdentities: [],
      payload: { projection: "providerRuntimeEvent", runtimeEvent: { event: agentEvent } },
      createdAt: NOW, updatedAt: NOW,
    } },
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

function systemLiveOperation(ordinal: number, systemEvent: Extract<AgentEvent, { type: "system" }>): ExecutionSemanticOperation {
  const reduction = new CodexLiveEventReducer(execution).reduce(systemEvent);
  if (reduction.kind !== "reduced" || reduction.publication.after !== "writer") throw new Error("Expected a bound live system event");
  const systemIntents = reduction.writer.filter((intent): intent is CodexSystemWriterIntent =>
    intent.kind === "notice-session" || intent.kind === "system-notice" || intent.kind === "session-cursor");
  if (systemIntents.length !== reduction.writer.length) throw new Error("Unexpected system reducer intent");
  return {
    ...operation(ordinal, { kind: "live-event", text: { kind: "unchanged" }, systemIntents }),
    livePublication: [reduction.publication],
  };
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

  const loss = {
    execution, lease,
    reason: "The execution worker exited before its provider turn could be proved live.",
    recoveryIncidentId: "incident-1",
  };

  it("commits context and compaction projections before publishing their canonical events", async () => {
    const seenAtPublication: { eventId: string; state: unknown }[] = [];
    writer = new CanonicalExecutionSemanticWriter(db, (events) => {
      for (const item of events) {
        const state = db.prepare("SELECT last_context_tokens, last_compact_summary FROM threads WHERE id = ?").get(THREAD_ID);
        seenAtPublication.push({ eventId: item.eventId, state });
      }
    });
    handler = new ExecutionWorkerHandler(writer);
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    async function append(ordinal: number, agentEvent: AgentEvent) {
      return send(ordinal, { kind: "event", phase: "running", nativeCursor: null, events: [runtimeEvent(ordinal, agentEvent)] });
    }
    const identity = { threadId: THREAD_ID, turnExecutionId: EXECUTION_ID };
    expect((await append(2, { ...identity, type: "contextEstimate", tokensIn: 100, totalProcessedTokens: 120, contextWindow: 200_000 })).kind).toBe("committed");
    expect((await append(3, { ...identity, type: "compacting", active: true })).kind).toBe("committed");
    expect((await append(4, { ...identity, type: "contextEstimate", tokensIn: 90, totalProcessedTokens: 140 })).kind).toBe("committed");
    expect((await append(5, { ...identity, type: "compactSummary", summary: "Short context" })).kind).toBe("committed");
    expect((await append(6, { ...identity, type: "contextEstimate", tokensIn: 30, totalProcessedTokens: 150 })).kind).toBe("committed");
    expect((await append(7, { ...identity, type: "compacting", active: true })).kind).toBe("committed");
    expect((await append(8, { ...identity, type: "compacting", active: false })).kind).toBe("committed");
    expect((await append(9, { ...identity, type: "turnComplete", reason: "end_turn", costUsd: null, tokensIn: 40, tokensOut: 5 })).kind).toBe("committed");

    expect(seenAtPublication.filter(({ eventId }) => eventId.includes(":runtime-"))).toEqual([
      { eventId: `${EXECUTION_ID}:runtime-2`, state: { last_context_tokens: 100, last_compact_summary: null } },
      { eventId: `${EXECUTION_ID}:runtime-3`, state: { last_context_tokens: 100, last_compact_summary: null } },
      { eventId: `${EXECUTION_ID}:runtime-4`, state: { last_context_tokens: 100, last_compact_summary: null } },
      { eventId: `${EXECUTION_ID}:runtime-5`, state: { last_context_tokens: 100, last_compact_summary: "Short context" } },
      { eventId: `${EXECUTION_ID}:runtime-6`, state: { last_context_tokens: 30, last_compact_summary: "Short context" } },
      { eventId: `${EXECUTION_ID}:runtime-7`, state: { last_context_tokens: 30, last_compact_summary: "Short context" } },
      { eventId: `${EXECUTION_ID}:runtime-8`, state: { last_context_tokens: 30, last_compact_summary: "Short context" } },
      { eventId: `${EXECUTION_ID}:runtime-9`, state: { last_context_tokens: 40, last_compact_summary: "Short context" } },
    ]);
    expect(new MessageRepo(db).listIncludingInternal(THREAD_ID)).toContainEqual(expect.objectContaining({ role: "system", content: "Context compacted" }));

    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalExecutionSemanticWriter(db, () => {});
    const dividerCount = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND content = 'Context compacted'")
      .get(THREAD_ID);
    expect(await writer.transact(operation(8, { kind: "append-events", phase: "running", nativeCursor: null,
      events: [runtimeEvent(8, { ...identity, type: "compacting", active: false })] }))).toMatchObject({ kind: "committed" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND content = 'Context compacted'")
      .get(THREAD_ID)).toEqual(dividerCount);
  });

  it("rolls back context projections and rejects completion during compaction", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const identity = { threadId: THREAD_ID, turnExecutionId: EXECUTION_ID };
    db.run("CREATE TRIGGER fail_context_receipt BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:append-events' BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
    await expect(send(2, { kind: "event", phase: "running", nativeCursor: null, events: [
      runtimeEvent(2, { ...identity, type: "contextEstimate", tokensIn: 80, totalProcessedTokens: 90 }),
    ] })).rejects.toThrow("receipt unavailable");
    expect(db.prepare("SELECT last_context_tokens FROM threads WHERE id = ?").get(THREAD_ID)).toEqual({ last_context_tokens: null });
    expect(published).not.toContain(`${EXECUTION_ID}:runtime-2`);
    db.run("DROP TRIGGER fail_context_receipt");
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [
      runtimeEvent(2, { ...identity, type: "compacting", active: true }),
    ] })).kind).toBe("committed");
    expect(await send(3, { kind: "event", phase: "running", nativeCursor: null, events: [
      runtimeEvent(3, { ...identity, type: "turnComplete", reason: "end_turn", costUsd: null, tokensIn: 50, tokensOut: 1 }),
    ] })).toEqual({ kind: "rejected", reason: "writer-conflict" });
    expect(db.prepare("SELECT event_id FROM canonical_agent_events WHERE event_id = ?").get(`${EXECUTION_ID}:runtime-3`)).toBeNull();
    expect(published).not.toContain(`${EXECUTION_ID}:runtime-3`);
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null, events: [
      runtimeEvent(3, { ...identity, type: "compactSummary", summary: "Recovered" }),
    ] })).kind).toBe("committed");
  });

  it("fences a lost worker while retaining durable text and narrative", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const text = new ParentAssistantTextCheckpointService(db);
    expect(text.appendChunk([{ ...execution, sequence: 1, text: "Partial answer" }]).outcome).toBe("committed");
    text.recoveryJournal.append([{ ...execution, sequence: 2, text: " from journal" }]);
    const { CanonicalAgentBoundary } = await import("../canonical-agent-boundary.js");
    const canonical = new CanonicalAgentBoundary(db, () => {});
    expect(canonical.recordParentNarrativeRecovery({
      executionId: EXECUTION_ID, items: toolNarrative("", 1),
    })).toBe(true);

    const receipt = writer.interruptWorkerLoss(loss);
    expect(receipt).toMatchObject({ kind: "committed", operationId: "lease-1:worker-lost" });
    expect(canonical.loadTurn(TURN_ID)).toMatchObject({ status: "Interrupted" });
    expect(canonical.loadCheckpoint(EXECUTION_ID)).toMatchObject({ phase: "interrupted", terminalOutcome: "interrupted" });
    expect(new MessageRepo(db).listIncludingInternal(THREAD_ID)).toContainEqual(expect.objectContaining({
      role: "assistant", content: "Partial answer from journal", outcome: "interrupted", is_internal: false,
    }));
    expect(db.prepare("SELECT id, status, message_id FROM tool_call_records WHERE id = ?").get("tool-0"))
      .toMatchObject({ id: "tool-0", status: "completed",
        message_id: canonical.loadTerminalProjection(TURN_ID).message?.id });
    expect(published).toContain(`${EXECUTION_ID}:recovery-interrupted`);
    expect(await writer.transact(operation(2, { kind: "append-events", phase: "running", nativeCursor: null, events: [event()] })))
      .toEqual({ kind: "conflict", operationId: "lease-1:2" });

    db.close(true);
    db = openDatabase({ dbPath: path });
    published = [];
    writer = new CanonicalExecutionSemanticWriter(db, (events) => published.push(...events.map((item) => item.eventId)));
    expect(writer.interruptWorkerLoss(loss)).toEqual(receipt);
    expect(published).toContain(`${EXECUTION_ID}:recovery-interrupted`);
  });

  it("keeps an assistant-text receipt and text across writer restart and worker loss", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const inputs = [{ ...execution, sequence: 1, text: "Durable partial answer" }];
    const textOperation = operation(2, { kind: "append-assistant-text", inputs });
    const appended = await send(2, { kind: "assistant-text", inputs });
    expect(appended).toMatchObject({
      kind: "committed", operationId: "lease-1:2",
      assistantTextCheckpoint: { outcome: "committed", durableThrough: 1, committedItems: 1 },
    });
    expect(new ParentAssistantTextCheckpointService(db).restore(EXECUTION_ID)).toBe("Durable partial answer");

    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalExecutionSemanticWriter(db, () => {});
    expect(await writer.transact(textOperation)).toEqual(appended);
    expect(new ParentAssistantTextCheckpointService(db).restore(EXECUTION_ID)).toBe("Durable partial answer");
    expect(db.prepare("SELECT COUNT(*) AS count FROM parent_assistant_text_checkpoint_chunks WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ count: 1 });
    expect(writer.interruptWorkerLoss(loss).kind).toBe("committed");
    expect(new MessageRepo(db).listIncludingInternal(THREAD_ID)).toContainEqual(expect.objectContaining({
      role: "assistant", content: "Durable partial answer", outcome: "interrupted",
    }));
  });

  it("cancels after a text checkpoint and retires it only after terminal commit", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    expect((await send(2, { kind: "assistant-text", inputs: [
      { ...execution, sequence: 1, text: "Saved before cancellation" },
    ] })).kind).toBe("committed");
    expect((await handler.handle({ requestId: 3, execution, lease, ordinal: 3, stopWatermark: 2,
      command: { kind: "stop", requestId: "cancel-1" } })).result.kind).toBe("committed");
    expect((await send(4, { kind: "provider-outcome", outcome: "cancelled" })).kind).toBe("committed");
    expect((await send(5, { kind: "stage-terminal", input: {
      threadId: THREAD_ID, executionId: EXECUTION_ID, outcome: "cancelled", endedAt: NOW,
      assistant: { content: "Saved before cancellation", model: null, attachments: [] }, narrative: [],
    } })).kind).toBe("committed");
    expect(new ParentAssistantTextCheckpointService(db).restore(EXECUTION_ID)).toBe("Saved before cancellation");
    const finish = operation(6, { kind: "finish", outcome: "cancelled", input: {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
      providerId: "codex", providerIdentities: [], outcome: "cancelled", projection: { kind: "writer-staged" },
    } });
    db.run("CREATE TRIGGER fail_text_retirement BEFORE DELETE ON parent_assistant_text_checkpoints BEGIN SELECT RAISE(ABORT, 'retirement unavailable'); END");
    await expect(writer.transact(finish)).rejects.toThrow("retirement unavailable");
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ terminal_outcome: "cancelled" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM parent_assistant_text_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ count: 1 });
    db.run("DROP TRIGGER fail_text_retirement");
    expect((await writer.transact(finish)).kind).toBe("committed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM parent_assistant_text_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ count: 0 });
    expect(new MessageRepo(db).listIncludingInternal(THREAD_ID)).toContainEqual(expect.objectContaining({
      role: "assistant", content: "Saved before cancellation", outcome: "cancelled", is_internal: false,
    }));
    expect((await writer.transact(finish)).kind).toBe("committed");
  });

  it("publishes the assigned live assistant ID only when finish names the staged ID", async () => {
    const assignedId = "a".repeat(64);
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    expect((await send(2, { kind: "provider-outcome", outcome: "completed" })).kind).toBe("committed");
    expect((await send(3, { kind: "stage-terminal", input: {
      threadId: THREAD_ID, executionId: EXECUTION_ID, outcome: "completed", endedAt: NOW,
      assistant: { content: "Live answer", model: null, attachments: [], messageId: assignedId }, narrative: [],
    } })).kind).toBe("committed");

    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalExecutionSemanticWriter(db, () => {});
    const finishInput = {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
      providerId: "codex" as const, providerIdentities: [], outcome: "completed" as const,
      projection: { kind: "writer-staged" as const, messageId: assignedId },
    };
    expect(await writer.transact(operation(4, { kind: "finish", outcome: "completed",
      input: { ...finishInput, projection: { kind: "writer-staged" } } })))
      .toEqual({ kind: "conflict", operationId: "lease-1:4" });
    expect(await writer.transact(operation(4, { kind: "finish", outcome: "completed",
      input: { ...finishInput, projection: { kind: "writer-staged", messageId: "b".repeat(64) } } })))
      .toEqual({ kind: "conflict", operationId: "lease-1:4" });
    expect((await writer.transact(operation(4, { kind: "finish", outcome: "completed", input: finishInput }))).kind)
      .toBe("committed");
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, assignedId))
      .toMatchObject({ id: assignedId, content: "Live answer", is_internal: false });
  });

  it("stages a projected Codex message with its receipt before live publication and reuses it at finish", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const projection = new CodexParentMessageProjection({ execution, turnKind: "ordinary" });
    const projected = projection.projectMessage({
      execution, content: "Live answer", model: null, precedingMessageId: "user-1", postTurnGoalReceipt: false,
    });
    const message = {
      precedingMessageId: "user-1", messageId: projected.messageId,
      content: "Live answer", model: projected.model, attachments: projected.attachments ?? [],
    };
    const event = { type: AgentEventType.Message, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
      content: message.content, tokens: null, messageId: message.messageId, model: message.model };
    const liveOperation = { ...operation(2, { kind: "live-event", text: { kind: "unchanged" }, message }),
      livePublication: [{ after: "writer" as const, event }] };

    expect(await writer.transact({ ...liveOperation, livePublication: [{ after: "writer",
      event: { ...event, content: "Different public body" } }] }))
      .toEqual({ kind: "conflict", operationId: "lease-1:2" });
    expect(new MessageRepo(db).findByIdInThreadIncludingInternal(THREAD_ID, message.messageId)).toBeNull();

    db.run("CREATE TRIGGER fail_message_receipt BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:live-event' AND NEW.operation_id = 'lease-1:2' BEGIN SELECT RAISE(ABORT, 'message receipt unavailable'); END");
    await expect(writer.transact(liveOperation)).rejects.toThrow("message receipt unavailable");
    expect(new MessageRepo(db).findByIdInThreadIncludingInternal(THREAD_ID, message.messageId)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "lease-1:2")).toEqual({ count: 0 });
    db.run("DROP TRIGGER fail_message_receipt");

    const committedMessage = await send(2, {
      kind: "live-event", text: { kind: "unchanged" }, message,
      publication: { after: "writer", event },
    });
    expect(committedMessage).toMatchObject({ kind: "committed", livePublication: [{
      publicationId: "lease-1:2:0", event,
    }] });
    expect(new MessageRepo(db).findByIdInThreadIncludingInternal(THREAD_ID, message.messageId))
      .toMatchObject({ id: message.messageId, content: message.content, model: null, is_internal: true });

    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalExecutionSemanticWriter(db, () => {});
    expect(await writer.transact(liveOperation)).toEqual(committedMessage);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?").get(message.messageId))
      .toEqual({ count: 1 });
    expect(await writer.transact({ ...liveOperation, mutation: { kind: "live-event", text: { kind: "unchanged" },
      message: { ...message, content: "Different body" } },
    livePublication: [{ after: "writer", event: { ...event, content: "Different body" } }] }))
      .toEqual({ kind: "conflict", operationId: "lease-1:2" });
    expect(await writer.transact({ ...liveOperation, ordinal: 3, operationId: "lease-1:3",
      mutation: { kind: "live-event", text: { kind: "unchanged" }, message: { ...message, content: "Different body" } },
      livePublication: [{ after: "writer", event: { ...event, content: "Different body" } }],
    })).toEqual({ kind: "conflict", operationId: "lease-1:3" });
    expect(new MessageRepo(db).findByIdInThreadIncludingInternal(THREAD_ID, message.messageId))
      .toMatchObject({ content: "Live answer" });

    expect((await writer.transact(operation(3, { kind: "provider-outcome", outcome: "completed" }))).kind)
      .toBe("committed");
    const terminal = projection.projectTerminal({
      execution, outcome: "completed", endedAt: NOW, fallbackModel: null, narrative: [],
    });
    expect(await writer.transact(operation(4, { kind: "stage-terminal", input: {
      ...terminal, assistant: { ...terminal.assistant, messageId: "b".repeat(64) },
    } }))).toEqual({ kind: "conflict", operationId: "lease-1:4" });
    expect((await writer.transact(operation(4, { kind: "stage-terminal", input: terminal }))).kind)
      .toBe("committed");
    expect((await writer.transact(operation(5, { kind: "finish", outcome: "completed", input: {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
      providerId: "codex", providerIdentities: [], outcome: "completed",
      projection: { kind: "writer-staged", messageId: message.messageId },
    } }))).kind).toBe("committed");
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, message.messageId))
      .toMatchObject({ id: message.messageId, content: "Live answer", outcome: "completed", is_internal: false });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?").get(message.messageId))
      .toEqual({ count: 1 });
  });

  it("uses a live message row with its assigned ID when the worker is lost", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const projection = new CodexParentMessageProjection({ execution, turnKind: "ordinary" });
    const projected = projection.projectMessage({
      execution, content: "Durable body", model: null, precedingMessageId: "user-1", postTurnGoalReceipt: false,
    });
    const message = {
      precedingMessageId: "user-1", messageId: projected.messageId,
      content: "Durable body", model: projected.model, attachments: projected.attachments ?? [],
    };
    expect((await send(2, { kind: "live-event", text: { kind: "unchanged" }, message,
      publication: { after: "writer", event: { type: AgentEventType.Message,
        threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, content: message.content,
        tokens: null, messageId: message.messageId, model: message.model } },
    })).kind).toBe("committed");
    expect(writer.interruptWorkerLoss(loss).kind).toBe("committed");
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, message.messageId))
      .toMatchObject({ content: "Durable body", outcome: "interrupted", is_internal: false });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND role = 'assistant'")
      .get(THREAD_ID)).toEqual({ count: 1 });
  });

  it("fences assistant-text routing, lease, ordinal, input size, and conflicting replay", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const inputs = [{ ...execution, sequence: 1, text: "Saved text" }];
    const appendText = operation(2, { kind: "append-assistant-text", inputs });
    expect(await writer.transact({ ...appendText, lease: { ...lease, ownerEpoch: 2, leaseId: "lease-2" },
      operationId: "lease-2:2" })).toEqual({ kind: "conflict", operationId: "lease-2:2" });
    expect(await writer.transact({ ...appendText, ordinal: 3, operationId: "lease-1:3" }))
      .toEqual({ kind: "conflict", operationId: "lease-1:3" });
    expect(await writer.transact(operation(2, { kind: "append-assistant-text",
      inputs: [{ ...inputs[0]!, threadId: "wrong-thread" }],
    }))).toEqual({ kind: "conflict", operationId: "lease-1:2" });
    expect(await writer.transact(operation(2, { kind: "append-assistant-text",
      inputs: [{ ...inputs[0]!, text: "x".repeat(16 * 1024 + 1) }],
    }))).toEqual({ kind: "conflict", operationId: "lease-1:2" });
    expect(await writer.transact(appendText)).toMatchObject({ kind: "committed", operationId: "lease-1:2" });
    expect(await writer.transact(operation(2, { kind: "append-assistant-text",
      inputs: [{ ...inputs[0]!, text: "Changed text" }],
    }))).toEqual({ kind: "conflict", operationId: "lease-1:2" });
    expect(await writer.transact(operation(3, { kind: "append-assistant-text", inputs })))
      .toEqual({ kind: "conflict", operationId: "lease-1:3" });
    expect(new ParentAssistantTextCheckpointService(db).restore(EXECUTION_ID)).toBe("Saved text");
  });

  it("rolls back assistant text if its semantic receipt cannot commit", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    db.run("CREATE TRIGGER fail_text_receipt BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:append-assistant-text' BEGIN SELECT RAISE(ABORT, 'text receipt unavailable'); END");
    const input = operation(2, { kind: "append-assistant-text",
      inputs: [{ ...execution, sequence: 1, text: "Keep me out until receipt" }],
    });
    await expect(writer.transact(input)).rejects.toThrow("text receipt unavailable");
    expect(db.prepare("SELECT COUNT(*) AS count FROM parent_assistant_text_checkpoint_chunks").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "semantic:head")).toMatchObject({ receipt_json: expect.stringContaining('"ordinal":1') });
    db.run("DROP TRIGGER fail_text_receipt");
    expect(await writer.transact(input)).toMatchObject({ kind: "committed", operationId: "lease-1:2" });
  });

  it("replays narrative changes and discards, then recovers only the saved narrative after worker loss", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const canonical = new CanonicalAgentBoundary(db, () => {});
    const reducer = new NarrativeRecoveryDelta();
    const publicationCount = published.length;
    const initialDelta = reducer.prepare(toolNarrative("", 1));
    if (!initialDelta) throw new Error("Expected an initial narrative delta");
    const first = operation(2, { kind: "narrative-delta", input: {
      executionId: EXECUTION_ID, items: initialDelta.items, discardedItemIds: initialDelta.discardedItemIds,
    } });
    expect((await writer.transact(first)).kind).toBe("committed");
    initialDelta.acknowledge();
    expect(canonical.loadParentNarrativeRecovery(TURN_ID)).toHaveLength(1);
    expect(published).toHaveLength(publicationCount);
    const discardedDelta = reducer.prepare([]);
    if (!discardedDelta) throw new Error("Expected a discarded narrative delta");
    const discard = operation(3, { kind: "narrative-delta", input: {
      executionId: EXECUTION_ID, items: discardedDelta.items, discardedItemIds: discardedDelta.discardedItemIds,
    } });
    expect((await writer.transact(discard)).kind).toBe("committed");
    discardedDelta.acknowledge();
    expect(canonical.loadParentNarrativeRecovery(TURN_ID)).toEqual([]);
    const latestDelta = reducer.prepare([toolNarrative("", 2)[1]!]);
    if (!latestDelta) throw new Error("Expected a new narrative delta");
    const latest = operation(4, { kind: "narrative-delta", input: {
      executionId: EXECUTION_ID, items: latestDelta.items, discardedItemIds: latestDelta.discardedItemIds,
    } });
    const receipt = await writer.transact(latest);
    expect(receipt).toMatchObject({ kind: "committed", operationId: "lease-1:4" });
    latestDelta.acknowledge();
    expect(published).toHaveLength(publicationCount);

    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalExecutionSemanticWriter(db, (events) => published.push(...events.map((item) => item.eventId)));
    expect(await writer.transact(first)).toMatchObject({ kind: "committed", operationId: "lease-1:2" });
    expect(await writer.transact(discard)).toMatchObject({ kind: "committed", operationId: "lease-1:3" });
    expect(await writer.transact(latest)).toEqual(receipt);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = ?").get("toolCall:tool-1"))
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = ?").get("toolCall:tool-0"))
      .toEqual({ count: 0 });
    expect(writer.interruptWorkerLoss(loss).kind).toBe("committed");
    expect(db.prepare("SELECT id, status FROM tool_call_records WHERE id = ?").get("tool-1"))
      .toEqual({ id: "tool-1", status: "completed" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tool_call_records WHERE id = ?").get("tool-0"))
      .toEqual({ count: 0 });
  });

  it("rolls back narrative changes when the semantic receipt cannot commit", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const delta = operation(2, { kind: "narrative-delta", input: {
      executionId: EXECUTION_ID, items: toolNarrative("", 1), discardedItemIds: [],
    } });
    expect(await writer.transact(operation(2, { kind: "narrative-delta", input: {
      executionId: "wrong-execution", items: toolNarrative("", 1), discardedItemIds: [],
    } }))).toEqual({ kind: "conflict", operationId: "lease-1:2" });
    expect(await writer.transact(operation(2, { kind: "narrative-delta", input: {
      executionId: EXECUTION_ID, items: [{ ...toolNarrative("", 1)[0]!, record: {
        ...toolNarrative("", 1)[0]!.record, input_summary: "x".repeat(256 * 1024 + 1),
      } }], discardedItemIds: [],
    } }))).toEqual({ kind: "conflict", operationId: "lease-1:2" });
    db.run("CREATE TRIGGER fail_narrative_receipt BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:narrative-delta' BEGIN SELECT RAISE(ABORT, 'narrative receipt unavailable'); END");
    await expect(writer.transact(delta)).rejects.toThrow("narrative receipt unavailable");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = ?").get("toolCall:tool-0"))
      .toEqual({ count: 0 });
    db.run("DROP TRIGGER fail_narrative_receipt");
    expect((await writer.transact(delta)).kind).toBe("committed");
  });

  it("commits reclassification and promotion with their narrative changes before live publication", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const publicationCount = published.length;
    const unknown = operation(2, { kind: "live-event", text: { kind: "append", inputs: [
      { ...execution, sequence: 1, text: "unknown draft" },
    ] } });
    const unknownEvent = { type: AgentEventType.TextDelta, threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID, delta: "unknown draft" };
    const appended = await writer.transact({ ...unknown, livePublication: [{ after: "writer", event: unknownEvent }] });
    expect(appended).toMatchObject({ kind: "committed", assistantTextCheckpoint: { durableThrough: 1 },
      livePublication: [{ publicationId: "lease-1:2:0", event: unknownEvent }] });
    expect(new ParentAssistantTextCheckpointService(db).restore(EXECUTION_ID)).toBe("unknown draft");

    const thought = { kind: "narrationSegment" as const, record: {
      id: "thought-1", message_id: "", text: "unknown draft", started_at: NOW,
      ended_at: NOW, sort_order: 0,
    } };
    const boundary = { type: AgentEventType.AssistantMessageBoundary, threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID, isFinalResponse: false };
    const reclassified = { ...operation(3, { kind: "live-event", text: {
      kind: "reclassify", expectedText: "unknown draft",
    }, narrative: { executionId: EXECUTION_ID, items: [thought], discardedItemIds: [] } }),
    livePublication: [{ after: "writer" as const, event: boundary }] };
    db.run("CREATE TRIGGER fail_compound_receipt BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:live-event' AND NEW.operation_id = 'lease-1:3' BEGIN SELECT RAISE(ABORT, 'compound receipt unavailable'); END");
    await expect(writer.transact(reclassified)).rejects.toThrow("compound receipt unavailable");
    expect(new ParentAssistantTextCheckpointService(db).restore(EXECUTION_ID)).toBe("unknown draft");
    expect(new CanonicalAgentBoundary(db, () => {}).loadParentNarrativeRecovery(TURN_ID)).toEqual([]);
    expect(published).toHaveLength(publicationCount);
    db.run("DROP TRIGGER fail_compound_receipt");
    const reclassifiedReceipt = await writer.transact(reclassified);
    expect(reclassifiedReceipt).toMatchObject({ kind: "committed", livePublication: [
      { publicationId: "lease-1:3:0", event: boundary },
    ] });
    expect(new ParentAssistantTextCheckpointService(db).restore(EXECUTION_ID)).toBe("");
    expect(new CanonicalAgentBoundary(db, () => {}).loadParentNarrativeRecovery(TURN_ID)).toEqual([thought]);

    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalExecutionSemanticWriter(db, () => {});
    expect(await writer.transact(reclassified)).toEqual(reclassifiedReceipt);
    expect(new ParentAssistantTextCheckpointService(db).restore(EXECUTION_ID)).toBe("");

    const finalBoundary = { ...boundary, isFinalResponse: true };
    const promoted = { ...operation(4, { kind: "live-event", text: { kind: "promote", input: {
      ...execution, sequence: 1, text: "final thought",
    } }, narrative: { executionId: EXECUTION_ID, items: [], discardedItemIds: ["narrationSegment:thought-1"] } }),
    livePublication: [{ after: "writer" as const, event: finalBoundary }] };
    expect(await writer.transact(promoted)).toMatchObject({ kind: "committed",
      assistantTextCheckpoint: { durableThrough: 1 },
      livePublication: [{ publicationId: "lease-1:4:0", event: finalBoundary }],
    });
    expect(new ParentAssistantTextCheckpointService(db).restore(EXECUTION_ID)).toBe("final thought");
    expect(new CanonicalAgentBoundary(db, () => {}).loadParentNarrativeRecovery(TURN_ID)).toEqual([]);
    expect(writer.interruptWorkerLoss(loss).kind).toBe("committed");
    expect(new MessageRepo(db).listIncludingInternal(THREAD_ID)).toContainEqual(expect.objectContaining({
      role: "assistant", content: "final thought", outcome: "interrupted",
    }));
  });

  it("durably acknowledges a boundary with no new text or narrative rows", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const boundary = { type: AgentEventType.AssistantMessageBoundary, threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID, isFinalResponse: true };
    const op = { ...operation(2, { kind: "live-event", text: { kind: "unchanged" } }),
      livePublication: [{ after: "writer" as const, event: boundary }] };
    const receipt = await writer.transact(op);
    expect(receipt).toMatchObject({ kind: "committed", livePublication: [
      { publicationId: "lease-1:2:0", event: boundary },
    ] });
    expect(await writer.transact(op)).toEqual(receipt);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "lease-1:2")).toEqual({ count: 1 });
  });

  it("commits a system notice and its generated message ID in one replayable live receipt", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const notice: Extract<AgentEvent, { type: "system" }> = {
      type: "system", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
      subtype: "provider.notice.unknown-event", message: "Codex reported an update.",
      systemNotice: { kind: "diagnostic", presentation: "timeline", scope: "turn", noticeKey: "notice-1" },
    };
    const op = systemLiveOperation(2, notice);
    const publishedBefore = [...published];
    db.run("CREATE TRIGGER fail_system_receipt BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:live-event' BEGIN SELECT RAISE(ABORT, 'system receipt unavailable'); END");
    await expect(writer.transact(op)).rejects.toThrow("system receipt unavailable");
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND role = 'system'").get(THREAD_ID))
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, op.operationId)).toEqual({ count: 0 });
    expect(published).toEqual(publishedBefore);
    db.run("DROP TRIGGER fail_system_receipt");

    const receipt = await writer.transact(op);
    expect(receipt).toMatchObject({ kind: "committed", livePublication: [{ publicationId: "lease-1:2:0",
      after: "writer", event: { ...notice, messageId: expect.any(String) } }] });
    if (receipt.kind !== "committed") return;
    const messageId = receipt.livePublication?.[0]?.event.type === "system"
      ? receipt.livePublication[0].event.messageId : undefined;
    expect(messageId).toBeDefined();
    if (!messageId) return;
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, messageId))
      .toMatchObject({ role: "system", content: notice.message });
    expect(await writer.transact(op)).toEqual(receipt);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND role = 'system'").get(THREAD_ID))
      .toEqual({ count: 1 });

    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalExecutionSemanticWriter(db, () => {});
    expect(await writer.transact(op)).toEqual(receipt);
    const stored = db.prepare("SELECT receipt_json FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, op.operationId) as { receipt_json: string };
    const corrupted = JSON.parse(stored.receipt_json) as { livePublication: { event: { messageId: string } }[] };
    corrupted.livePublication[0]!.event.messageId = "not-a-message-id";
    db.prepare("UPDATE canonical_writer_operation_receipts SET receipt_json = ? WHERE execution_id = ? AND operation_id = ?")
      .run(JSON.stringify(corrupted), EXECUTION_ID, op.operationId);
    await expect(writer.transact(op)).rejects.toThrow("Invalid uuid");
    const altered = JSON.parse(stored.receipt_json) as { livePublication: { event: { message: string } }[] };
    altered.livePublication[0]!.event.message = "Different notice";
    db.prepare("UPDATE canonical_writer_operation_receipts SET receipt_json = ? WHERE execution_id = ? AND operation_id = ?")
      .run(JSON.stringify(altered), EXECUTION_ID, op.operationId);
    await expect(writer.transact(op)).rejects.toThrow("Live publication receipt does not match");
  });

  it("fences session cursors to the selected execution in the compound live writer", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const cursor: Extract<AgentEvent, { type: "system" }> = {
      type: "system", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, subtype: "sdk_session_id:native-cursor",
    };
    const unbound = { ...cursor, turnExecutionId: undefined };
    expect(await send(2, { kind: "live-event", text: { kind: "unchanged" },
      systemIntents: [{ kind: "session-cursor", event: unbound }], publication: { event: unbound, after: "writer" },
    })).toEqual({ kind: "rejected", reason: "writer-conflict" });
    expect(db.prepare("SELECT sdk_session_id FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ sdk_session_id: null });
    expect(await send(2, { kind: "live-event", text: { kind: "unchanged" },
      systemIntents: [{ kind: "session-cursor", event: { ...cursor, turnExecutionId: "other-execution" } }],
      publication: { event: cursor, after: "writer" },
    })).toEqual({ kind: "rejected", reason: "writer-conflict" });
    expect(db.prepare("SELECT sdk_session_id FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ sdk_session_id: null });
    const receipt = await send(2, { kind: "live-event", text: { kind: "unchanged" },
      systemIntents: [{ kind: "session-cursor", event: cursor }], publication: { event: cursor, after: "writer" },
    });
    expect(receipt).toMatchObject({ kind: "committed", livePublication: [{ event: cursor }] });
    expect(db.prepare("SELECT sdk_session_id FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ sdk_session_id: "native-cursor" });
    expect(new CanonicalAgentBoundary(db, () => {}).loadCheckpoint(EXECUTION_ID))
      .toMatchObject({ nativeCursor: { providerId: "codex", scope: "thread", value: "native-cursor" } });
  });

  it("stores task-tool rows before the matching live tool publication", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const toolUse = { type: AgentEventType.ToolUse, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
      toolCallId: "todo-1", toolName: "TodoWrite", toolInput: { todos: [{ content: "Ship task" }] } };
    const op = { ...operation(2, { kind: "live-event", text: { kind: "unchanged" },
      taskIntents: [{ kind: "upsert-group", group: "Tasks",
        tasks: [{ content: "Ship task", status: "pending", group: "Tasks" }] }],
    }), livePublication: [{ after: "writer" as const, event: toolUse }] };
    db.run("CREATE TRIGGER fail_task_receipt BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:live-event' BEGIN SELECT RAISE(ABORT, 'task receipt unavailable'); END");
    await expect(writer.transact(op)).rejects.toThrow("task receipt unavailable");
    expect(new TaskRepo(db).get(THREAD_ID)).toBeNull();
    db.run("DROP TRIGGER fail_task_receipt");
    const receipt = await writer.transact(op);
    expect(receipt).toMatchObject({ kind: "committed", livePublication: [
      { publicationId: "lease-1:2:0", event: toolUse },
    ] });
    expect(new TaskRepo(db).get(THREAD_ID)).toEqual([
      { content: "Ship task", status: "pending", group: "Tasks" },
    ]);
    expect(await writer.transact(op)).toEqual(receipt);
  });

  it("acknowledges transient tool progress without inventing a durable tool row", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const event = { type: AgentEventType.ToolProgress, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
      toolCallId: "tool-1", toolName: "command_execution", elapsedSeconds: 1 };
    const op = { ...operation(2, { kind: "live-event", text: { kind: "unchanged" } }),
      livePublication: [{ after: "writer" as const, event }] };
    const receipt = await writer.transact(op);
    expect(receipt).toMatchObject({ kind: "committed", livePublication: [{ event }] });
    expect(await writer.transact(op)).toEqual(receipt);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE turn_id = ? AND id LIKE 'toolCall:%'")
      .get(TURN_ID)).toEqual({ count: 0 });
  });

  it("rejects an error publication before terminal durability", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const error: AgentEvent = { type: AgentEventType.Error, threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID, error: "failed" };
    const op = { ...operation(2, { kind: "append-events", phase: "running", nativeCursor: null,
      events: [runtimeEvent(2, error)] }), livePublication: [{ after: "writer" as const, event: error }] };
    expect(await writer.transact(op)).toEqual({ kind: "conflict", operationId: "lease-1:2" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "lease-1:2")).toEqual({ count: 0 });
  });

  it("rejects a compound live event that exceeds its shared row or byte budget", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const event = { type: AgentEventType.TextDelta, threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID, delta: "short text" };
    const text = { kind: "append" as const, inputs: [{ ...execution, sequence: 1, text: event.delta }] };
    const publication = [{ after: "writer" as const, event }];
    expect(await writer.transact({ ...operation(2, { kind: "live-event", text,
      narrative: { executionId: EXECUTION_ID, items: toolNarrative("", 62), discardedItemIds: [] },
    }), livePublication: publication })).toEqual({ kind: "conflict", operationId: "lease-1:2" });
    const largeItem = { ...toolNarrative("", 1)[0]!, record: {
      ...toolNarrative("", 1)[0]!.record, input_summary: "x".repeat(256 * 1024 - 900),
    } };
    expect(await writer.transact({ ...operation(2, { kind: "live-event", text,
      narrative: { executionId: EXECUTION_ID, items: [largeItem], discardedItemIds: [] },
    }), livePublication: publication })).toEqual({ kind: "conflict", operationId: "lease-1:2" });
    expect(await writer.transact({ ...operation(2, { kind: "live-event", text }),
      livePublication: [{ after: "writer", event: { ...event, delta: "different" } }],
    })).toEqual({ kind: "conflict", operationId: "lease-1:2" });
    expect(new ParentAssistantTextCheckpointService(db).restore(EXECUTION_ID)).toBe("");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE turn_id = ? AND id LIKE 'toolCall:%'")
      .get(TURN_ID)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "lease-1:2")).toEqual({ count: 0 });
  });

  it("rejects stale worker-loss leases without changing the unfinished turn", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    expect(writer.interruptWorkerLoss({ ...loss, lease: { ...lease, ownerEpoch: 2 } }))
      .toEqual({ kind: "conflict", operationId: "lease-1:worker-lost" });
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: null });
    expect(published).not.toContain(`${EXECUTION_ID}:recovery-interrupted`);
  });

  it("distinguishes a lost worker before start from one after a durable terminal", async () => {
    expect(writer.interruptWorkerLoss(loss)).toEqual({
      kind: "conflict", operationId: "lease-1:worker-lost", recoveryState: "not-started",
    });
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    expect((await send(2, { kind: "provider-outcome", outcome: "completed" })).kind).toBe("committed");
    expect((await send(3, { kind: "stage-terminal", input: {
      threadId: THREAD_ID, executionId: EXECUTION_ID, outcome: "completed", endedAt: NOW,
      assistant: { content: "Answer", model: null, attachments: [] }, narrative: [],
    } })).kind).toBe("committed");
    expect((await send(4, { kind: "finalize", outcome: "completed", input: {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
      providerId: "codex", providerIdentities: [], outcome: "completed",
      projection: { kind: "writer-staged" },
    } })).kind).toBe("committed");
    expect(writer.interruptWorkerLoss(loss)).toEqual({
      kind: "conflict", operationId: "lease-1:worker-lost", recoveryState: "already-terminal",
    });
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ terminal_outcome: "completed" });
  });

  it("rolls back worker-loss interruption and publication when its receipt cannot commit", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const text = new ParentAssistantTextCheckpointService(db);
    text.appendChunk([{ ...execution, sequence: 1, text: "Keep me" }]);
    text.recoveryJournal.append([{ ...execution, sequence: 2, text: " through failure" }]);
    db.run("CREATE TRIGGER fail_loss_receipt BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:worker-lost' BEGIN SELECT RAISE(ABORT, 'loss receipt unavailable'); END");
    expect(() => writer.interruptWorkerLoss(loss)).toThrow("loss receipt unavailable");
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: null });
    expect(new MessageRepo(db).listIncludingInternal(THREAD_ID).some((message) => message.role === "assistant")).toBe(false);
    expect(text.restore(EXECUTION_ID)).toBe("Keep me through failure");
    expect(published).not.toContain(`${EXECUTION_ID}:recovery-interrupted`);
    db.run("DROP TRIGGER fail_loss_receipt");
    expect(writer.interruptWorkerLoss(loss).kind).toBe("committed");
    expect(db.prepare("SELECT content FROM messages WHERE role = 'assistant'").get())
      .toEqual({ content: "Keep me through failure" });
  });

  it("commits start, event, and finalization with durable receipts across a database reload", async () => {
    const begin = operation(1, { kind: "begin", providerId: "codex", input: startInput() });
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [event()] })).kind).toBe("committed");
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

  it("retains terminal live publication behind a completed finalization and rejects invalid routing", async () => {
    const ended = { type: AgentEventType.Ended, threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID, outcome: "completed" as const };
    const invalidStart: ExecutionSemanticOperation = {
      ...operation(1, { kind: "begin", providerId: "codex", input: startInput() }),
      livePublication: [{ after: "terminal", event: ended }],
    };
    expect(await writer.transact(invalidStart)).toEqual({ kind: "conflict", operationId: "lease-1:1" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ count: 0 });
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");

    const staged = new MessageRepo(db).create(THREAD_ID, "assistant", "Answer", 2, undefined, undefined, undefined, "model", true);
    const input = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
      providerId: "codex", providerIdentities: [], outcome: "completed" as const,
      projection: { message: staged, narrative: [] } };
    const finish: ExecutionSemanticOperation = {
      ...operation(2, { kind: "finish", outcome: "completed", input }),
      livePublication: [{ after: "terminal", event: ended }],
    };
    db.run("CREATE TRIGGER fail_live_finish BEFORE UPDATE OF kind ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:finish' BEGIN SELECT RAISE(ABORT, 'finish unavailable'); END");
    await expect(writer.transact(finish)).rejects.toThrow("finish unavailable");
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ terminal_outcome: null });
    db.run("DROP TRIGGER fail_live_finish");

    const receipt = await writer.transact(finish);
    expect(receipt).toMatchObject({ kind: "committed", livePublication: [{
      publicationId: "lease-1:2:0", after: "terminal", event: ended,
    }] });
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ terminal_outcome: "completed" });
    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalExecutionSemanticWriter(db, () => {});
    expect(await writer.transact(finish)).toEqual(receipt);
    expect(await writer.transact({ ...finish, livePublication: [{ after: "terminal", event: {
      ...ended, threadId: "another-thread",
    } }] })).toEqual({ kind: "conflict", operationId: "lease-1:2" });
  });

  it("rejects oversized live intents before writes and oversized receipts before replay publication", async () => {
    const started = { type: AgentEventType.TurnStarted, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID };
    const begin: ExecutionSemanticOperation = {
      ...operation(1, { kind: "begin", providerId: "codex", input: startInput() }),
      livePublication: [{ after: "writer", event: started }],
    };
    expect(await writer.transact({ ...begin, livePublication: Array.from({ length: 65 }, () => ({
      after: "writer" as const, event: started,
    })) })).toEqual({ kind: "conflict", operationId: "lease-1:1" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual({ count: 0 });

    const beginReceipt = await writer.transact(begin);
    expect(beginReceipt.kind).toBe("committed");
    const before = db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE execution_id = ?")
      .get(EXECUTION_ID);
    published.length = 0;
    const largeDelta: ExecutionSemanticOperation = {
      ...operation(2, { kind: "append-events", phase: "running", nativeCursor: null, events: [event()] }),
      livePublication: [{ after: "writer", event: {
        type: AgentEventType.TextDelta, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
        delta: "x".repeat(256 * 1024),
      } }],
    };
    expect(await writer.transact(largeDelta)).toEqual({ kind: "conflict", operationId: "lease-1:2" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual(before);
    expect(published).toEqual([]);

    db.prepare("UPDATE canonical_writer_operation_receipts SET receipt_json = ? WHERE execution_id = ? AND operation_id = ?")
      .run("x".repeat(512 * 1024 + 1), EXECUTION_ID, begin.operationId);
    await expect(writer.transact(begin)).rejects.toThrow("Live publication receipt exceeds its size limit");
    expect(published).toEqual([]);

    db.prepare("UPDATE canonical_writer_operation_receipts SET receipt_json = ? WHERE execution_id = ? AND operation_id = ?")
      .run(JSON.stringify({ ...beginReceipt, publicationVersion: 1, livePublication: [{
        publicationId: "lease-1:1:0", after: "writer",
        event: { ...started, threadId: "another-thread" },
      }] }), EXECUTION_ID, begin.operationId);
    await expect(writer.transact(begin)).rejects.toThrow("Live publication receipt does not match its operation");
    expect(published).toEqual([]);
  });

  it("rejects stale leases and skipped ordinals while checkpointing without a new event", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const eventsBefore = db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE execution_id = ?").get(EXECUTION_ID);
    const append = operation(2, { kind: "append-events", phase: "running", nativeCursor: null, events: [event()] });
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
    await expect(send(2, { kind: "event", phase: "running", nativeCursor: null, events: [event()] })).rejects.toThrow("event receipt unavailable");
    expect(db.prepare("SELECT last_durable_sequence FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID)).toEqual(before);
    expect(db.prepare("SELECT id FROM canonical_agent_items WHERE id = ?").get("item-1")).toBeNull();
    expect(published).not.toContain(event().eventId);

    db.run("DROP TRIGGER fail_semantic_event_receipt");
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [event()] })).kind).toBe("committed");
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
    await expect(send(2, { kind: "event", phase: "running", nativeCursor: null, events: [event()] })).rejects.toThrow("publisher unavailable");
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
    expect(await writer.transact(operation(2, { kind: "append-events", phase: "running", nativeCursor: null, events: [event()] })))
      .toMatchObject({
        kind: "committed", operationId: "lease-1:2",
        providerCommit: { outcome: "committed", eventCount: 1 },
      });
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

  it("replays terminal publication across multiple bounded receipt pages", async () => {
    expect((await send(1, { kind: "start", providerId: "codex", input: startInput() })).kind).toBe("committed");
    const staged = new MessageRepo(db).create(
      THREAD_ID, "assistant", "Answer", 2, undefined, undefined, undefined, "model", true,
    );
    const input = {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, providerId: "codex",
      providerIdentities: [], outcome: "completed" as const,
      projection: { message: staged, narrative: toolNarrative(staged.id, 1_025) },
    };
    published = [];
    expect((await send(2, { kind: "finalize", outcome: "completed", input })).kind).toBe("committed");
    const firstPublication = [...published];
    expect(firstPublication).toContain(`${EXECUTION_ID}:turn.completed`);
    expect((db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND kind = 'semantic-publication'")
      .get(EXECUTION_ID) as { count: number }).count).toBeGreaterThan(16);

    db.close(true);
    db = openDatabase({ dbPath: path });
    published = [];
    writer = new CanonicalExecutionSemanticWriter(db, (events) => published.push(...events.map((item) => item.eventId)));
    expect(await writer.transact(operation(2, { kind: "finish", outcome: "completed", input })))
      .toMatchObject({ kind: "committed" });
    expect(published).toEqual(firstPublication);
  }, 30_000);
});
