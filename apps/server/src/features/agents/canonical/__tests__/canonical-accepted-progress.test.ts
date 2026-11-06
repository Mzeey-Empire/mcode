import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { AgentEventSchema, type AgentEvent } from "@mcode/contracts/events/agent-event";
import { CanonicalAgentProgressFrameSchema, type CanonicalAgentProgressFrame } from "@mcode/contracts/models/canonical-agent-progress";
import { ProviderRuntimeExtensionSchema, type ProviderRuntimeExtension } from "@mcode/contracts/events/provider-runtime-event";
import { MessageSchema } from "@mcode/contracts/models/message";
import { ParentNarrativeRecoveryItemSchema, type ParentNarrativeRecoveryItem } from "@mcode/contracts/models/narrative-recovery";
import { encodeCanonicalSubagentDetailTarget } from "@mcode/contracts/models/tool-call-record";
import { reduceAgentEventBatch, type AcceptedCanonicalAgentEventEnvelope, type AgentModelState } from "@mcode/contracts/compat/agent-model";
import { BoundedProgressRetention } from "../../execution/progress-retention-budget.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openMigratedTestDatabase } from "../../../../runtime/persistence/sqlite/testing/migrated-test-database.js";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { leaseWriterWorker } from "../../../../runtime/persistence/sqlite/testing/reusable-writer-worker.js";
import { ExecutionWorkerHandler, type ExecutionWorkCommand, type ExecutionSemanticOperation } from "../../execution/execution-worker-handler.js";
import { CanonicalAgentStore } from "../canonical-agent-store.js";
import { syntheticThreadExecutionId } from "../canonical-thread-execution.js";
import { CanonicalAgentStore as MainCanonicalAgentBoundary } from "../canonical-agent-boundary.js";
import { CanonicalAgentWriterClient, CanonicalWriterAcknowledgementCapacity } from "../canonical-agent-writer-client.js";
import { CanonicalAcceptedProgress, TurnVisualRejectedError } from "../canonical-accepted-progress.js";
import { MessageStore } from "../../conversation/persistence/message-store.js";
import { NarrativeReadStore } from "../../conversation/narrative/narrative-read-store.js";
import { ToolCallRecordStore } from "../../tools/persistence/tool-call-record-store.js";
import { HookExecutionStore } from "../../events/persistence/hook-execution-store.js";
import { PlanQuestionAnswersStore } from "../../planning/persistence/plan-question-answers-store.js";
import { loadConversationPage } from "../../conversation/read-model/conversation-page.js";
import { CanonicalExecutionWriterPort } from "../canonical-execution-writer-port.js";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { createDevinAcpTurnState, mapDevinAcpSessionNotification } from "../../../../../../../packages/providers/src/private/devin/devin-acp-event-mapper.js";
import { z } from "zod";
import { createCopilotProvider, type CopilotProviderBoundary, type ProviderEventBatch, type ProviderHostPorts } from "@mcode/providers";
import { providerRuntimeEvent, ProviderRuntimeEventSchema } from "@mcode/contracts/events/provider-runtime-event";
import { CanonicalLiveEventPublisher } from "../../../../../../../packages/providers/src/private/canonical-live-event-publisher.js";
import { type TurnOutcome } from "@mcode/contracts/models/turn-outcome";
import type { SessionEvent } from "../../../../../../../packages/providers/node_modules/@github/copilot-sdk/dist/index.js";
import { ThoughtSegmentStore } from "../../conversation/narrative/persistence/thought-segment-store.js";
import { deriveTurnAssistantMessageId } from "../../turns/turn-assistant-message-id.js";
import { ProgressAdmissionError } from "../../execution/execution-writer-failure.js";
import { persistTurnFailure } from "../turn-ending.js";
import { TurnSteerStore } from "../../steering/persistence/turn-steer-store.js";
import { TurnSavingStatusSchema, type TurnSavingStatus } from "@mcode/contracts/models/turn-runtime";
import { diag, parseDiagLine, threadRecordingFileId } from "@mcode/shared/diagnostics";

const copilotSdk = vi.hoisted(() => ({ session: undefined as CopilotPersistenceSession | undefined }));
vi.mock("../../../../../../../packages/providers/node_modules/@github/copilot-sdk/dist/index.js", () => ({
  approveAll: () => ({ kind: "approved" }),
  CopilotClient: class {
    start = async () => {};
    stop = async () => [];
    forceStop = async () => {};
    getState = () => "connected";
    createSession = async () => copilotSdk.session;
    listModels = async () => [{ id: "model", name: "Model", capabilities: { supports: { reasoningEffort: false } } }];
  },
}));
type CopilotNativeInput = { [K in SessionEvent["type"]]: Omit<Extract<SessionEvent, { type: K }>, "id" | "timestamp" | "parentId"> }[SessionEvent["type"]];
class CopilotPersistenceSession {
  readonly sessionId = "native-persistence-session";
  readonly handlers = new Set<(event: SessionEvent) => void>();
  sequence = 0;
  on = (handler: (event: SessionEvent) => void) => { this.handlers.add(handler); return () => { this.handlers.delete(handler); }; };
  rpc = { mode: { set: async () => {} } };
  send = async () => "native-message";
  disconnect = async () => {};
  abort = async () => { this.emit({ type: "abort", data: { reason: "user initiated" } }); this.emit({ type: "session.idle", ephemeral: true, data: { aborted: true } }); };
  emit(input: CopilotNativeInput, id?: string) {
    const sequence = ++this.sequence;
    const event: SessionEvent = { ...input, id: id ?? `native-${sequence}`, timestamp: "2026-10-02T10:00:00.000Z", parentId: sequence === 1 ? null : `native-${sequence - 1}` };
    this.handlers.forEach((handler) => handler(event));
  }
}
const copilotTerminalCases = {
  snapshot: { status: "Completed", content: "Final answer", outcome: "completed", finalMessages: 1, delta: "Final ", snapshot: true },
  "delta-only": { status: "Completed", content: "Final", outcome: "completed", finalMessages: 0, delta: "Final", snapshot: false },
  abort: { status: "Interrupted", content: "Final answer", outcome: "interrupted", finalMessages: 0, delta: "Final ", snapshot: true },
  error: { status: "Errored", content: "Final answer", outcome: "errored", finalMessages: 0, delta: "Final ", snapshot: true },
};
function copilotTerminalOutcome(event: AgentEvent): TurnOutcome | undefined {
  if (event.type === "turnComplete") return "completed";
  if (event.type === "error") return "errored";
  if (event.type === "ended") return event.outcome === "cancelled" ? "interrupted" : event.outcome;
  return undefined;
}
async function finishCopilotNativeTurn(provider: CopilotProviderBoundary, session: CopilotPersistenceSession, ending: keyof typeof copilotTerminalCases) {
  if (ending === "abort") await provider.stopSession("mcode-session");
  else if (ending === "error") session.emit({ type: "session.error", data: { errorType: "fixture", message: "Native failed" } });
  else session.emit({ type: "session.idle", ephemeral: true, data: {} });
}

function acceptedMessage(event: Pick<AcceptedCanonicalAgentEventEnvelope, "payload">) {
  const payload = event.payload;
  if (payload.type !== "item.recorded" || payload.item.payload.projection !== "message") return null;
  return MessageSchema().parse(payload.item.payload.message);
}

const pushes = vi.hoisted(() => {
  const saving: TurnSavingStatus[] = [];
  return { frames: [] as unknown[], turns: [] as { channel: string; data: unknown }[], saving, subscriptions: new Set<string>() };
});
vi.mock("../../../../application/transport/push.js", () => ({ broadcast: (channel: string, frame: unknown) => {
  if (channel === "agent.canonical") pushes.frames.push(frame);
  if (channel === "thread.status" || channel === "turn.persisted") pushes.turns.push({ channel, data: frame });
  if (channel === "turn.savingStatus") pushes.saving.push(TurnSavingStatusSchema().parse(frame));
},subscribedThreadIds: () => pushes.subscriptions }));
const NOW = "2026-09-30T10:00:00.000Z";
const execution = { threadId: "live-thread", turnId: "live-turn", executionId: "00000000-0000-4000-8000-000000000123" };
const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "live-lease" };

function start(providerId: string, identity = execution): Extract<ExecutionWorkCommand, { kind: "start" }> {
  return { kind: "start", providerId, publishParentStart: true,
    parentLive: { planFeature: "none", precedingMessageId: `${identity.turnId}:user` },
    input: { thread: { id: identity.threadId, workspaceId: "workspace", providerId, createdAt: NOW },
      turnId: identity.turnId, executionId: identity.executionId, permissionMode: "full", providerIdentities: [],
      userMessage: { kind: "create", messageId: `${identity.turnId}:user`, content: "Task", sequence: 1 } } };
}

function draft(providerId: string, sequence: number, type: AgentEvent["type"], fields: Record<string, unknown> = {}, identity = execution) {
  const event = AgentEventSchema().parse({ type, threadId: identity.threadId, turnExecutionId: identity.executionId,
    ...(type === "turnComplete" ? { reason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0 } : {}), ...fields });
  const itemId = `${identity.executionId}:raw:${sequence}`;
  return { eventId: itemId, routing: { ...identity, itemId }, sourceProviderId: providerId,
    sourceIdentities: [], sourceSequence: sequence, payload: { type: "item.recorded" as const,
      item: { id: itemId, threadId: identity.threadId, turnId: identity.turnId, kind: "system" as const,
        providerIdentities: [], payload: { projection: "providerRuntimeEvent", runtimeEvent: { event } }, createdAt: NOW, updatedAt: NOW } } };
}

function completedTool(index: number): ParentNarrativeRecoveryItem {
  return { kind: "toolCall", record: { id: `tool-${index}`, message_id: "", parent_tool_call_id: null,
    tool_name: "Read", display_name: null, provider_agent_key: null, subagent_identity_key: null,
    subagent_provider_name: null, subagent_prompt: null, subagent_type: null, subagent_agent_id: null,
    subagent_duration_ms: null, model: null, reasoning_effort: null, input_summary: "file.txt", output_summary: "Done",
    output_total_bytes: null, output_artifact_path: null, exit_code: null, status: "completed",
    started_at: NOW, completed_at: NOW, sort_order: index } };
}

function familyDraft(sequence: number, type: AgentEvent["type"], fields: Record<string, unknown>,
  extension: Omit<ProviderRuntimeExtension, "kind" | "providerId">, identity = execution) {
  const value = draft("codex", sequence, type, fields, identity);
  return { ...value, payload: { ...value.payload, item: { ...value.payload.item,
    payload: { ...value.payload.item.payload, runtimeEvent: { ...value.payload.item.payload.runtimeEvent,
      extension: ProviderRuntimeExtensionSchema().parse({ kind: "codex-collaboration", providerId: "codex", ...extension }) } } } } };
}

// Saves go through a real SQLite writer and retry transient failures after 1 s. On a loaded CI runner a
// correct save outlasts the 1 s poll and 5 s test defaults, so both bounds cover that latency here.
describe("accepted parent progress with the actual SQLite writer", { timeout: 30_000 }, () => {
  beforeAll(() => { vi.setConfig({ expect: { poll: { timeout: 10_000 } } }); });
  afterAll(() => { vi.resetConfig(); });

  let directory: string;
  let db: Database;
  let reader: Database;
  let writer: CanonicalAgentWriterClient;
  let databaseWriter: ApplicationDatabaseWriter;
  let progress: CanonicalAcceptedProgress;
  let port: CanonicalExecutionWriterPort;
  let handler: ExecutionWorkerHandler;
  let release: (() => void) | undefined;

  beforeEach(() => {
    pushes.frames.length = 0;
    pushes.turns.length = 0;
    pushes.saving.length = 0;
    pushes.subscriptions.clear();
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-live-progress-"));
    const dbPath = NodePath.join(directory, "app.sqlite");
    db = openMigratedTestDatabase(dbPath);
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("workspace", "Workspace", directory, NOW, NOW);
    insertThread(execution.threadId);
    databaseWriter = new ApplicationDatabaseWriter(dbPath, leaseWriterWorker);
    writer = new CanonicalAgentWriterClient(databaseWriter);
    reader = openReadOnlyDatabase(dbPath);
    progress = new CanonicalAcceptedProgress(new MainCanonicalAgentBoundary(reader, databaseWriter, writer, () => {}), writer);
    port = new CanonicalExecutionWriterPort(writer, () => {}, undefined, undefined, progress);
    handler = new ExecutionWorkerHandler(port);
  });

  afterEach(async () => {
    release?.();
    release = undefined;
    await progress.close();
    vi.useRealTimers();
    await writer.close();
    await databaseWriter.close();
    reader.close(true);
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function insertThread(threadId: string) {
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(threadId, "workspace", "Thread", "main", "codex", NOW, NOW);
  }
  it("saves 200 Claude text and 200 reasoning pieces as one checkpoint instead of rows per piece", async () => {
    // Inserts are counted by trigger because acknowledgement cleanup deletes receipt rows after a save.
    const tables = ["canonical_agent_events", "canonical_agent_items", "canonical_agent_item_content_appends",
      "canonical_writer_operation_receipts", "canonical_writer_thread_operation_receipts"];
    db.run("CREATE TABLE stream_write_counts (table_name TEXT PRIMARY KEY, writes INTEGER NOT NULL DEFAULT 0)");
    for (const table of tables) {
      db.prepare("INSERT INTO stream_write_counts (table_name) VALUES (?)").run(table);
      db.run(`CREATE TRIGGER count_stream_${table} AFTER INSERT ON ${table} BEGIN UPDATE stream_write_counts SET writes = writes + 1 WHERE table_name = '${table}'; END`);
    }
    const writes = () => Object.fromEntries((db.prepare("SELECT table_name, writes FROM stream_write_counts").all() as
      { table_name: string; writes: number }[]).map((row) => [row.table_name, row.writes]));
    await send(1, start("claude"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("claude", 1, "textDelta", { delta: "prefix", isFinalResponse: true })] });
    await progress.waitForSaved(execution.threadId);
    const before = writes();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let index = 0; index < 200; index++) {
      await send(index + 3, { kind: "event", phase: "running", nativeCursor: null,
        events: [{ ...draft("claude", index + 2, "textDelta", { delta: "x", isFinalResponse: true }), delivery: "live" }] });
    }
    for (let index = 0; index < 200; index++) {
      await send(index + 203, { kind: "event", phase: "running", nativeCursor: null,
        events: [{ ...draft("claude", index + 202, "reasoningDelta", { delta: "r", reasoningItemId: "reasoning-block" }), delivery: "live" }] });
    }
    expect(writes()).toEqual(before);
    await progress.waitForSaved(execution.threadId);
    const after = writes();
    expect(Object.fromEntries(tables.map((table) => [table, (after[table] ?? 0) - (before[table] ?? 0)]))).toEqual({
      canonical_agent_events: 2, canonical_agent_items: 1, canonical_agent_item_content_appends: 1,
      canonical_writer_operation_receipts: 1, canonical_writer_thread_operation_receipts: 0,
    });
    const cut = recovery();
    if (cut.durable.mode !== "snapshot") throw new Error("Expected saved snapshot");
    expect(cut.durable.snapshot.state.items[`assistant-response-text:${execution.executionId}`]?.payload.content)
      .toBe(`prefix${"x".repeat(200)}`);
    const thoughts = Object.values(cut.durable.snapshot.state.items).filter((item) => item.payload.projection === "narrativeRecovery");
    expect(thoughts.map((item) => item.payload.narrative)).toEqual([
      expect.objectContaining({ kind: "narrationSegment", record: expect.objectContaining({ text: "r".repeat(200) }) }),
    ]);
  });
  const send = (ordinal: number, command: ExecutionWorkCommand, identity = execution, activeLease = lease) =>
    handler.handle({ requestId: ordinal, execution: identity, lease: activeLease, ordinal, command });
  function holdWrites(onAppend?: () => void) {
    const append = writer.appendAccepted.bind(writer);
    const held = new Promise<void>((resolve) => { release = resolve; });
    const heldAppend: typeof writer.appendAccepted = async (...args) => { onAppend?.(); await held; return append(...args); };
    vi.spyOn(writer, "appendAccepted").mockImplementation(heldAppend);
    return heldAppend;
  }
  function recovery(identity = execution) {
    return progress.recover(identity.threadId, { conversationRevision: 0, rosterRevision: 0 });
  }
  function frames(): CanonicalAgentProgressFrame[] {
    return pushes.frames.map((frame) => CanonicalAgentProgressFrameSchema().parse(frame));
  }

  function acceptedEvents() {
    return frames().flatMap((frame) => frame.phase === "accepted" ? frame.events : []);
  }

  describe("Claude live checkpoint barriers", () => {
    let ordinal: number;
    async function piece(text: string, provider = "claude", live = true) {
      ordinal++;
      const value = draft(provider, ordinal - 1, "textDelta", { delta: text, isFinalResponse: true });
      return send(ordinal, { kind: "event", phase: "running", nativeCursor: null,
        events: [{ ...value, ...(live ? { delivery: "live" as const } : {}) }] });
    }
    async function begin(provider = "claude") {
      ordinal = 1;
      await send(1, start(provider));
      await piece("prefix", provider);
      await progress.waitForSaved(execution.threadId);
    }
    function savedText() {
      const boundary = new CanonicalAgentStore(db, () => {});
      const cut = boundary.recoverThread(execution.threadId, { conversationRevision: Number.MAX_SAFE_INTEGER, rosterRevision: Number.MAX_SAFE_INTEGER });
      if (cut.mode !== "snapshot") throw new Error("Expected saved snapshot");
      return cut.snapshot.state.items[`assistant-response-text:${execution.executionId}`]?.payload.content;
    }

    /** Waits for queued saves without the flush that `waitForSaved` performs, so only timers and thresholds save. */
    async function drainSaves() {
      while (progress.depth().pending > 0) await new Promise((resolve) => setImmediate(resolve));
    }
    function liveFrames() {
      return frames().filter((frame) => frame.phase === "live");
    }
    function rowCount(table: string, where = "") {
      return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as { count: number }).count;
    }

    it("saves a stalled stream one second after its first unsaved piece", async () => {
      await begin();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await piece("idle");
      await vi.advanceTimersByTimeAsync(999);
      await drainSaves();
      expect(savedText()).toBe("prefix");
      await vi.advanceTimersByTimeAsync(1);
      await drainSaves();
      expect(savedText()).toBe("prefixidle");
    });

    it("saves at 16 KiB of pending text without waiting for the timer", async () => {
      await begin();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const below = "x".repeat(16 * 1024 - 1);
      await piece(below);
      await drainSaves();
      expect(savedText()).toBe("prefix");
      await piece("y");
      await drainSaves();
      expect(savedText()).toBe(`prefix${below}y`);
    });

    it("flushes before a saved tool and publishes dense positions in that order", async () => {
      await begin();
      pushes.frames.length = 0;
      await piece("before tool");
      await send(++ordinal, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("claude", ordinal - 1, "toolUse", { toolCallId: "tool", toolName: "Read", toolInput: {} })] });
      const accepted = frames().filter((frame) => frame.phase === "accepted");
      expect(accepted[0]?.events.map((event) => event.payload.type)).toEqual(["item.content-appended"]);
      expect(accepted[1]?.from).toBe(accepted[0]?.through);
      expect(frames()[0]?.phase).toBe("live");
      await progress.waitForSaved(execution.threadId);
      expect(savedText()).toBe("prefixbefore tool");
    });

    it("saves a tool after live tool input that left nothing to checkpoint", async () => {
      await begin();
      const rows = rowCount("canonical_agent_events");
      for (const partialJson of ["{\"path\":", "\"file.txt\"}"]) {
        await send(++ordinal, { kind: "event", phase: "running", nativeCursor: null,
          events: [{ ...draft("claude", ordinal - 1, "toolInputDelta", { partialJson }), delivery: "live" as const }] });
      }
      expect(liveFrames().flatMap((frame) => frame.events.map((event) => event.type))).toEqual(["toolInputDelta", "toolInputDelta"]);
      await progress.waitForSaved(execution.threadId);
      expect(rowCount("canonical_agent_events")).toBe(rows);
      const tool = await send(++ordinal, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("claude", ordinal - 1, "toolUse", { toolCallId: "tool", toolName: "Read", toolInput: { path: "file.txt" } })] });
      expect(tool.result.kind).toBe("accepted");
      await progress.waitForSaved(execution.threadId);
      expect(rowCount("canonical_agent_events")).toBeGreaterThan(rows);
    });

    it("makes pending text available to reconnect and durable command barriers", async () => {
      await begin();
      await piece("reconnect");
      const cut = recovery();
      expect(cut.retained.map((event) => event.payload.type)).toContain("item.content-appended");
      await progress.beforeDurableCommand(execution.threadId);
      progress.cancelDurableCommand(execution.threadId);
      expect(savedText()).toBe("prefixreconnect");
    });

    it("loses at most the last unsaved second when the owner disappears", async () => {
      await begin();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // One piece every 100 ms: the timer saves pieces 1-10 and 11-20; 21-25 are still pending at the crash.
      for (let index = 0; index < 25; index++) {
        await piece("x");
        await vi.advanceTimersByTimeAsync(100);
      }
      await drainSaves();
      const abandoned = progress;
      progress = new CanonicalAcceptedProgress(new MainCanonicalAgentBoundary(reader, databaseWriter, writer, () => {}), writer);
      const cut = recovery();
      if (cut.durable.mode !== "snapshot") throw new Error("Expected crash recovery snapshot");
      expect(cut.durable.snapshot.state.items[`assistant-response-text:${execution.executionId}`]?.payload.content)
        .toBe(`prefix${"x".repeat(20)}`);
      await abandoned.close();
    });

    it("answers a resent live piece with its first receipt and refuses different content under its identity", async () => {
      await begin();
      const accept = vi.spyOn(progress, "acceptWhenReady");
      pushes.frames.length = 0;
      await piece("once");
      const operation = accept.mock.calls[0]?.[0];
      if (!operation || operation.mutation.kind !== "append-events") throw new Error("Expected the live operation");
      const first = await accept.mock.results[0]?.value;
      await progress.waitForSaved(execution.threadId);
      expect(progress.accept(operation)).toEqual(first);
      // A retried publish is the only way the server could send a live frame twice; it must not send one.
      expect(liveFrames()).toHaveLength(1);
      const changed = { ...operation, mutation: { ...operation.mutation,
        events: [{ ...draft("claude", ordinal - 1, "textDelta", { delta: "twice", isFinalResponse: true }), delivery: "live" as const }] } };
      expect(() => progress.accept(changed)).toThrow(expect.objectContaining({ admissionReason: "identity-conflict" }));
      await progress.waitForSaved(execution.threadId);
      expect(savedText()).toBe("prefixonce");
    });

    it("saves a non-fragment event whose draft is labelled live", async () => {
      await begin();
      pushes.frames.length = 0;
      const reply = await send(++ordinal, { kind: "event", phase: "running", nativeCursor: null,
        events: [{ ...draft("claude", ordinal - 1, "toolUse", { toolCallId: "tool", toolName: "Read", toolInput: {} }),
          delivery: "live" as const }] });
      expect(reply.result.kind).toBe("accepted");
      expect(pushes.frames.filter((frame) => (frame as { phase?: unknown }).phase === "live")).toEqual([]);
      await progress.waitForSaved(execution.threadId);
      expect(rowCount("canonical_agent_events", "WHERE json_extract(envelope_json, '$.payload.event.type') = 'toolUse'")).toBe(1);
    });

    it("saves a failed operation before any later one and retries it under the same identity", async () => {
      await begin();
      const toolRows = (id: string) =>
        rowCount("canonical_agent_events", `WHERE json_extract(envelope_json, '$.payload.event.toolCallId') = '${id}'`);
      const append = writer.appendAccepted.bind(writer);
      const attempts: { operationId: string; tool?: string; earlierSaved: number }[] = [];
      vi.spyOn(writer, "appendAccepted").mockImplementation(async (operationId, input) => {
        const tool = ["tool-a", "tool-b"].find((id) => JSON.stringify(input.events).includes(`"${id}"`));
        attempts.push({ operationId, tool, earlierSaved: toolRows("tool-a") });
        if (attempts.length === 1) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        return append(operationId, input);
      });
      const tool = (id: string) => send(++ordinal, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("claude", ordinal - 1, "toolUse", { toolCallId: id, toolName: "Read", toolInput: {} })] });
      await tool("tool-a");
      await vi.waitFor(() => expect(attempts).toHaveLength(1));
      await piece(" between");
      expect((await tool("tool-b")).result.kind).toBe("accepted");
      expect([toolRows("tool-a"), toolRows("tool-b")]).toEqual([0, 0]);
      await progress.waitForSaved(execution.threadId);
      expect([toolRows("tool-a"), toolRows("tool-b")]).toEqual([1, 1]);
      expect(attempts[1]?.operationId).toBe(attempts[0]?.operationId);
      expect(attempts.find((attempt) => attempt.tool === "tool-b")?.earlierSaved).toBe(1);
      expect(savedText()).toBe("prefix between");
    });

    it("retries a busy checkpoint save under one identity and saves its text once", async () => {
      await begin();
      await piece("retried");
      const appends = rowCount("canonical_agent_item_content_appends");
      const append = vi.spyOn(writer, "appendAccepted")
        .mockRejectedValueOnce(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
      await progress.waitForSaved(execution.threadId);
      const checkpoints = append.mock.calls.map(([operationId]) => operationId).filter((id) => id.startsWith("live:"));
      expect(checkpoints).toHaveLength(2);
      expect(new Set(checkpoints).size).toBe(1);
      expect(savedText()).toBe("prefixretried");
      expect(rowCount("canonical_agent_item_content_appends")).toBe(appends + 1);
    });

    it.each([
      { provider: "claude", live: 2, publications: 0 },
      { provider: "cursor", live: 0, publications: 2 },
    ] as const)("routes $provider pieces from the shared publisher end to end", async ({ provider, live, publications }) => {
      await begin(provider);
      const routing = { ...execution, deliveryAttempt: 1 };
      const publisher = new CanonicalLiveEventPublisher("unbounded", provider, { submit: async (batch) => {
        let accepted;
        for (const value of batch.events) {
          const reply = await send(++ordinal, { kind: "event", phase: batch.phase, nativeCursor: batch.nativeCursor ?? null, events: [value] });
          if (reply.result.kind !== "accepted") throw new Error(`Provider piece was not accepted: ${JSON.stringify(reply.result)}`);
          accepted = reply.result;
        }
        if (!accepted) throw new Error("Empty provider batch");
        return { commit: { outcome: "accepted", acceptedThrough: accepted.acceptedThrough,
          eventCount: batch.events.length, progressPosition: accepted.progressPosition }, delivery: { ingress: "not-required" } };
      } });
      const publicationRows = () => rowCount("canonical_agent_events", "WHERE json_extract(envelope_json, '$.payload.type') = 'publication.recorded'");
      const before = publicationRows();
      pushes.frames.length = 0;
      for (const delta of [" one", " two"]) {
        publisher.publish(routing, providerRuntimeEvent({ type: "textDelta", threadId: execution.threadId,
          turnExecutionId: execution.executionId, delta, isFinalResponse: true }), []);
      }
      await publisher.waitForExecution(routing);
      await drainSaves();
      expect(liveFrames()).toHaveLength(live);
      expect(publicationRows() - before).toBe(publications);
      await progress.waitForSaved(execution.threadId);
      expect(savedText()).toBe("prefix one two");
    });
  });

  function conversationPage() {
    return loadConversationPage({ messageRepo: new MessageStore(reader),
      narrativeStore: new NarrativeReadStore(new ToolCallRecordStore(reader), new ThoughtSegmentStore(reader), new HookExecutionStore(reader)),
      planQuestionAnswersRepo: new PlanQuestionAnswersStore(reader) }, { threadId: execution.threadId, limit: 20 });
  }

  describe("saving status publication", () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });

    async function settle(threadId = execution.threadId) {
      await progress.beforeDurableCommand(threadId);
      progress.cancelDurableCommand(threadId);
    }

    it("coalesces accepted and saved bursts while snapshots remain current", async () => {
      await send(1, start("codex"));
      await settle();
      for (let index = 1; index <= 10; index += 1) {
        holdWrites();
        await send(index + 1, { kind: "event", phase: "running", nativeCursor: null,
          events: [draft("codex", index, "textDelta", { delta: "text", isFinalResponse: true })] });
        expect(progress.savingStatuses(execution.threadId).map(({ mode }) => mode)).toEqual(["saving"]);
        release?.();
        await settle();
        vi.mocked(writer.appendAccepted).mockRestore();
        expect(progress.savingStatuses(execution.threadId)).toEqual([]);
        vi.advanceTimersByTime(20);
      }
      expect(pushes.saving).toEqual([]);
      vi.advanceTimersByTime(49);
      expect(pushes.saving).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(pushes.saving).toEqual([{ threadId: execution.threadId, executionId: execution.executionId, mode: "durable" }]);
    });

    it("sends failure and recovery immediately without a stale family durable", async () => {
      await send(1, start("codex"));
      await send(2, { kind: "event", phase: "running", nativeCursor: null,
        events: [familyDraft(1, "toolUse", { toolCallId: "spawn", toolName: "Agent", toolInput: {} },
          { collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-child"], prompt: "Child task" } })] });
      await send(3, { kind: "event", phase: "running", nativeCursor: null,
        events: [familyDraft(2, "turnStarted", {}, { child: { nativeThreadId: "native-child", nativeTurnId: "native-turn", parentCollaborationItemId: "spawn" } })] });
      await settle();
      const child = progress.loadSubagentRoster({ owningParentThreadId: execution.threadId, limit: 100 })?.active[0];
      if (!child) throw new Error("Expected accepted child");
      pushes.subscriptions.add(child.id);
      await send(4, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("codex", 3, "textDelta", { delta: "saved", isFinalResponse: true })] });
      await settle();
      vi.spyOn(writer, "appendAccepted").mockRejectedValueOnce(new Error("Disk full"));
      await send(5, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("codex", 4, "textDelta", { delta: "pending", isFinalResponse: true })] });
      await expect(settle()).rejects.toThrow();
      const ownerFailure = pushes.saving.filter((status) => status.executionId === execution.executionId);
      expect(ownerFailure.map(({ threadId, mode }) => ({ threadId, mode }))).toEqual([
        { threadId: execution.threadId, mode: "saving-failed" }, { threadId: child.id, mode: "saving-failed" },
      ]);
      vi.advanceTimersByTime(250);
      expect(pushes.saving.filter((status) => status.executionId === execution.executionId)).toEqual(ownerFailure);
      expect(progress.retry(execution.threadId)).toBe(true);
      expect(pushes.saving.filter((status) => status.executionId === execution.executionId).slice(-2).map(({ threadId, mode }) => ({ threadId, mode }))).toEqual([
        { threadId: execution.threadId, mode: "save-retrying" }, { threadId: child.id, mode: "save-retrying" },
      ]);
      await settle();
    });

    it("records which accepted events a failed save left unwritten", async () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "progress-save-failed-"));
      diag.configure({ dir, enabled: true });
      try {
        await send(1, start("codex"));
        await settle();
        vi.spyOn(writer, "appendAccepted").mockRejectedValueOnce(new Error("Disk full"));
        await send(2, { kind: "event", phase: "running", nativeCursor: null,
          events: [draft("codex", 1, "textDelta", { delta: "pending", isFinalResponse: true })] });
        await expect(settle()).rejects.toThrow();
        diag.flushSync();
        const file = NodePath.join(dir, "t", `${threadRecordingFileId(execution.threadId, diag.runId)}.jsonl`);
        const rows = NodeFS.readFileSync(file, "utf8").split("\n").map(parseDiagLine);
        expect(rows.filter((row) => row?.ch === "progress.save-failed").map((row) => row?.d)).toEqual([{
          turn: execution.turnId, execution: execution.executionId, source: "storage",
          error: "Disk full", exhausted: true, events: 4,
          types: ["turn.provider-started", "item.recorded", "publication.recorded"],
        }]);
      } finally {
        diag.configure({ enabled: false });
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each(["close", "discardThread", "release"])("flushes a final durable on %s", async (action) => {
      await send(1, start("codex"));
      await send(2, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("codex", 1, "turnComplete")], terminalInput: { ...execution, providerId: "codex", providerIdentities: [],
          outcome: "completed", projection: { kind: "writer-staged" } } });
      await settle();
      expect(pushes.saving).toEqual([]);
      if (action === "close") await progress.close();
      else if (action === "discardThread") await progress.discardThread(execution.threadId);
      else expect((await send(3, { kind: "release" })).result.kind).toBe("released");
      expect(pushes.saving).toEqual([{ threadId: execution.threadId, executionId: execution.executionId, mode: "durable" }]);
      vi.advanceTimersByTime(1_000);
      expect(pushes.saving).toHaveLength(1);
    });

    it("flushes a durable published by the in-flight save after close starts", async () => {
      await send(1, start("codex"));
      await settle();
      const started = new Promise<void>((resolve) => { holdWrites(resolve); });
      await send(2, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("codex", 1, "textDelta", { delta: "final save", isFinalResponse: true })] });
      await started;
      const closing = progress.close();
      expect(pushes.saving).toEqual([]);
      release?.();
      await closing;
      expect(pushes.saving).toEqual([{ threadId: execution.threadId, executionId: execution.executionId, mode: "durable" }]);
      vi.advanceTimersByTime(1_000);
      expect(pushes.saving).toHaveLength(1);
    });
  });

  it.each([true, false])("reloads a visual before the final reply with staged assistant = %s", async (staged) => {
    await send(1, start("codex"));
    const messageId = deriveTurnAssistantMessageId(execution.threadId, `${execution.turnId}:user`);
    if (staged) {
      await send(2, { kind: "live-event", text: { kind: "unchanged" },
        message: { precedingMessageId: `${execution.turnId}:user`, messageId, content: "Early answer", model: "fixture", attachments: [] },
        publication: { after: "writer", event: { type: "message", threadId: execution.threadId,
          turnExecutionId: execution.executionId, messageId, content: "Early answer", model: "fixture", tokens: 0 } } });
    }
    const visual = { title: "Latency", html: "<svg><rect/></svg>", maxHeight: 480 };
    const published = progress.acceptTurnVisual({ ...execution, visual });
    const visualItem = acceptedEvents().map(acceptedMessage)
      .find((message) => message?.id === published.messageId);
    expect(visualItem).toMatchObject({ role: "system", content: "Visual: Latency", visual });
    expect(visualItem?.systemNotice).toBeUndefined();
    const publication = acceptedEvents().find((event) =>
      event.payload.type === "publication.recorded" && event.payload.event.type === "system");
    expect(publication).toMatchObject({ payload: { event: { type: "system", messageId: published.messageId, visual } } });
    await send(staged ? 3 : 2, { kind: "finish-live-event", outcome: "completed",
      livePublication: [{ after: "terminal", event: { type: "turnComplete", threadId: execution.threadId,
        turnExecutionId: execution.executionId, reason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0 } }],
      projection: { ...execution, outcome: "completed", endedAt: NOW,
        assistant: { messageId, content: "Final answer", model: "fixture", attachments: [] }, narrative: [] },
      input: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged", messageId } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const messages = conversationPage().messages;
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Task"], ["system", "Visual: Latency"], ["assistant", "Final answer"],
    ]);
    const visualMessage = messages[1];
    const finalMessage = messages[2];
    if (!visualMessage || !finalMessage) throw new Error("Expected the reloaded visual and final reply");
    expect(visualMessage.sequence).toBeLessThan(finalMessage.sequence);
    const liveFinal = acceptedEvents().map(acceptedMessage)
      .filter((message) => message?.id === messageId).at(-1);
    expect(liveFinal).toMatchObject({ sequence: finalMessage.sequence });
    expect(pushes.turns.find((push) => push.channel === "turn.persisted")?.data)
      .toMatchObject({ messageId, settledMessage: { id: messageId, sequence: finalMessage.sequence } });
  });

  it("round trips a canonical visual through conversation-page", async () => {
    await send(1, start("codex"));
    const visual = { title: "Reload", html: "<p>Saved page</p>", maxHeight: 720 };
    const event = progress.acceptThreadSystemObservation({ type: "system", threadId: execution.threadId,
      turnExecutionId: execution.executionId, subtype: "mcode.visual", visual });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(conversationPage().messages.find((message) => message.id === event.messageId))
      .toMatchObject({ role: "system", content: "Visual: Reload", visual });
  });

  it("rejects visuals without the running head without consuming a message sequence", async () => {
    const visual = { title: "Chart", html: "<p/>", maxHeight: 720 };
    expect(() => progress.acceptTurnVisual({ ...execution, visual })).toThrow(TurnVisualRejectedError);
    await send(1, start("codex"));
    expect(() => progress.acceptTurnVisual({ ...execution, turnId: "wrong-turn", visual })).toThrow(TurnVisualRejectedError);
    const published = progress.acceptTurnVisual({ ...execution, visual });
    await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 1, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    expect(() => progress.acceptTurnVisual({ ...execution, visual })).toThrow(TurnVisualRejectedError);
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(conversationPage().messages.map((message) => [message.id, message.sequence])).toEqual([
      [`${execution.turnId}:user`, 1], [published.messageId, 2],
    ]);
  });

  it("rejects an invalid visual before consuming a sequence or publishing", async () => {
    await send(1, start("codex"));
    const before = frames().length;
    expect(() => progress.acceptTurnVisual({ ...execution,
      visual: { title: "Too tall", html: "<p/>", maxHeight: 5000 } })).toThrow();
    expect(frames()).toHaveLength(before);
    const published = progress.acceptTurnVisual({ ...execution, visual: { title: "Valid", html: "<p/>", maxHeight: 720 } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(conversationPage().messages.map((message) => [message.id, message.sequence])).toEqual([
      [`${execution.turnId}:user`, 1], [published.messageId, 2],
    ]);
  });

  it.each(["snapshot", "delta-only", "abort", "error"] as const)("persists Copilot model loops and their %s terminal through the public factory", async (ending) => {
    const expected = copilotTerminalCases[ending];
    await send(1, start("copilot"));
    let ordinal = 1;
    const batches: ProviderEventBatch[] = [];
    const submit: ProviderHostPorts["events"]["submit"] = async (batch) => {
      batches.push(batch);
      let accepted;
      for (const value of batch.events) {
        if (value.payload.type !== "item.recorded") throw new Error("Expected provider runtime draft");
        const event = ProviderRuntimeEventSchema().parse(value.payload.item.payload.runtimeEvent).event;
        const outcome = copilotTerminalOutcome(event);
        const reply = await send(++ordinal, { kind: "event", phase: batch.phase, nativeCursor: batch.nativeCursor ?? null,
          events: [value], ...(outcome ? { terminalInput: { ...execution, providerId: "copilot", providerIdentities: [], outcome,
            ...(event.type === "error" ? { ending: { failure: persistTurnFailure({ failure: event.failure, provider: "copilot",
              message: event.error, acceptedAt: Date.now() }) } } : {}),
            projection: { kind: "writer-staged" } } } : {}) });
        if (reply.result.kind !== "accepted") throw new Error(`Provider progress was not accepted: ${JSON.stringify(reply.result)}`);
        accepted = reply.result;
      }
      if (!accepted) throw new Error("Empty provider progress batch");
      return { commit: { outcome: "accepted", acceptedThrough: accepted.acceptedThrough,
        eventCount: batch.events.length, progressPosition: accepted.progressPosition }, delivery: { ingress: "not-required" } };
    };
    const host: ProviderHostPorts = {
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" }, environment: { snapshot: () => ({}) },
      processes: { attach: () => {}, terminateTree: async () => {} }, grants: { consume: () => false },
      browser: { stage: () => ({ leaseId: "lease", expiresAt: 1_000 }), releaseSession: () => 0, isConfigured: () => false,
        issue: () => null, refresh: (leaseId) => ({ ok: false, leaseId, reason: "not-found" }),
        release: (leaseId) => ({ leaseId, released: true }), revokeCredential: () => false },
      mcode: { attach: async () => null, close: async () => {} }, events: { submit },
    };
    const session = new CopilotPersistenceSession(); copilotSdk.session = session;
    const provider = createCopilotProvider({ configuration: { cliPath: "copilot", idleSessionTtlMs: 600_000 }, host,
      copilot: { launch: { resolve: async () => ({ cliPath: "/copilot", env: {} }) } } });
    try {
      await provider.sendTurn({ threadId: execution.threadId, turnId: execution.turnId, turnExecutionId: execution.executionId,
        sessionId: "mcode-session", workspaceId: "workspace", cwd: directory, message: "Task", model: "model",
        permissionMode: "full", interactionMode: "build", approvalReviewMode: "manual", providerOptions: {} });
      session.emit({ type: "assistant.turn_start", data: { turnId: "loop-1" } });
      session.emit({ type: "assistant.message", data: { messageId: "commentary-1", content: "Looking up the result." } });
      session.emit({ type: "assistant.turn_start", data: { turnId: "loop-2" } });
      session.emit({ type: "assistant.message", data: { messageId: "commentary-2", content: "Waiting for native child." } });
      session.emit({ type: "assistant.turn_start", data: { turnId: "loop-3" } });
      session.emit({ type: "assistant.message_delta", ephemeral: true, data: { messageId: "answer", deltaContent: expected.delta } });
      if (expected.snapshot) session.emit({ type: "assistant.message", data: { messageId: "answer", content: "Final answer" } }, "original-final-snapshot");
      await finishCopilotNativeTurn(provider, session, ending);
      const canonical = new CanonicalAgentStore(db, () => {});
      await expect.poll(() => canonical.loadTurn(execution.turnId)?.status).toBe(expected.status);
      await expect.poll(() => progress.depth().pending).toBe(0);
      const terminal = canonical.loadTerminalProjection(execution.turnId);
      expect(terminal.message).toMatchObject({ id: deriveTurnAssistantMessageId(execution.threadId, `${execution.turnId}:user`),
        content: expected.content, is_internal: false, outcome: expected.outcome });
      if (!terminal.message) throw new Error("Expected saved assistant response");
      expect(new ThoughtSegmentStore(db).listByMessage(terminal.message.id)
        .filter((item) => !item.is_final_response).map((item) => item.text)).toEqual(["Looking up the result.", "Waiting for native child."]);
      const finalMessages = batches.flatMap((batch) => batch.events).filter((value) => value.payload.type === "item.recorded"
        && ProviderRuntimeEventSchema().parse(value.payload.item.payload.runtimeEvent).event.type === "message");
      expect(finalMessages).toHaveLength(expected.finalMessages);
      if (ending === "snapshot") {
        expect(finalMessages[0]?.eventId).toContain("original-final-snapshot");
        expect(finalMessages[0]?.providerTimestamp).toBe("2026-10-02T10:00:00.000Z");
        const body = terminal.message?.content;
        const before = progress.recover(execution.threadId, { conversationRevision: 0, rosterRevision: 0 }).durable;
        const changed = draft("copilot", 10_000, "message", { content: "Changed replay", tokens: null });
        expect((await send(++ordinal, { kind: "event", phase: "running", nativeCursor: null, events: [changed] })).result.kind).toBe("rejected");
        expect(canonical.loadTerminalProjection(execution.turnId).message?.content).toBe(body);
        expect(progress.recover(execution.threadId, { conversationRevision: 0, rosterRevision: 0 }).durable).toEqual(before);
      }
    } finally { await provider.shutdown(); }
  });

  it("saves native completion in order after checkpointing a rejected live observation", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 1, "turnStarted")] });
    vi.spyOn(progress, "accept").mockImplementationOnce(() => { throw new Error("tool projection unavailable"); });
    const dropped = await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "toolUse", { toolCallId: "lost-tool", toolName: "Read", toolInput: {} })] });
    expect(dropped.result).toMatchObject({ kind: "dropped", reason: "acceptance-rejected", receipt: { kind: "accepted" } });
    await send(4, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 3, "textDelta", { delta: "Still completes", isFinalResponse: true })] });
    expect((await send(5, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 4, "ended", { outcome: "completed" })],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } })).result.kind).toBe("accepted");
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    expect(db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant'").get(execution.threadId)).toEqual({ content: "Still completes" });
    expect(new CanonicalAgentStore(db, () => {}).loadTurn(execution.turnId)?.status).toBe("Completed");
    expect((await send(6, { kind: "release" })).result.kind).toBe("released");
  });

  it("saves a steered message into the running turn and marks its steer delivered in the same write", async () => {
    await send(1, start("codex"));
    const steers = new TurnSteerStore(db);
    const onTime = "6f1c2b8e-3d4a-4c5b-9e7f-0a1b2c3d4e5f";
    const late = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    for (const [messageId, content] of [[onTime, "Use staging."], [late, "Also run lint."]] as const) {
      steers.insertPending({ messageId, threadId: execution.threadId, turnExecutionId: execution.executionId,
        inputsHash: "inputs", payload: { content } });
    }
    // A replay or restart already marked this one uncertain; the save still proves delivery.
    steers.settle(late, { state: "delivery_unknown" });

    await progress.acceptSteeredUserMessage({ threadId: execution.threadId, turnExecutionId: execution.executionId,
      messageId: onTime, content: "Use staging." });
    await progress.acceptSteeredUserMessage({ threadId: execution.threadId, turnExecutionId: execution.executionId,
      messageId: late, content: "Also run lint.", systemNotice: { kind: "delegated-task", presentation: "timeline",
        delegatedTasks: [{ taskId: "child-task", threadId: "child", title: "Review", providerId: "codex", status: "completed" }] } });

    expect(db.prepare("SELECT id, role, content, is_internal FROM messages WHERE id IN (?, ?) ORDER BY sequence")
      .all(onTime, late)).toEqual([
      { id: onTime, role: "user", content: "Use staging.", is_internal: 0 },
      { id: late, role: "user", content: "Also run lint.", is_internal: 0 },
    ]);
    expect([steers.find(onTime)?.state, steers.find(late)?.state]).toEqual(["delivered", "delivered"]);
    expect(db.prepare("SELECT system_notice FROM messages WHERE id = ?").get(late)).toEqual({
      system_notice: JSON.stringify({ kind: "delegated-task", presentation: "timeline",
        delegatedTasks: [{ taskId: "child-task", threadId: "child", title: "Review", providerId: "codex", status: "completed" }] }),
    });
    expect(() => progress.acceptSteeredUserMessage({ threadId: execution.threadId, turnExecutionId: "another-execution",
      messageId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", content: "Too late." }))
      .toThrow("Steered message has no matching accepted execution");
  });

  it("preserves the durable child roster revision across a parent follow-up and fresh recovery owner", async () => {
    await send(1, start("codex"));
    expect(recovery().durable).toMatchObject({ mode: "snapshot", snapshot: { revision: { rosterRevision: 0 } } });
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(1, "toolUse", { toolCallId: "spawn", toolName: "Agent", toolInput: {} },
        { collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-child"], prompt: "Child task" } })] });
    const child = { nativeThreadId: "native-child", nativeTurnId: "native-turn", parentCollaborationItemId: "spawn" };
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(2, "turnStarted", {}, { child })] });
    await send(4, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(3, "turnComplete", {}, { child })] });
    await send(5, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 4, "turnComplete")], terminalInput: { ...execution, providerId: "codex", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect((await send(6, { kind: "release" })).result.kind).toBe("released");
    const previous = recovery();
    if (previous.durable.mode !== "snapshot") throw new Error("Expected saved parent snapshot");
    const before = previous.durable.snapshot;
    expect(before.revision.rosterRevision).toBe(1);
    const childThread = Object.values(before.state.threads).find((thread) => thread.owningParentThreadId === execution.threadId);
    if (!childThread) throw new Error("Expected existing native child");
    expect(progress.loadSubagentRoster({ owningParentThreadId: execution.threadId, limit: 100 })?.done.map((thread) => thread.id)).toContain(childThread.id);
    const frameOffset = pushes.frames.length;
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000126" };
    const nextLease = { ...lease, ownerEpoch: 2, leaseId: "next-lease" };
    expect((await send(1, start("codex", next), next, nextLease)).result.kind).toBe("committed");
    const after = recovery(next);
    if (after.durable.mode !== "snapshot") throw new Error("Expected follow-up snapshot");
    expect(after.durable.snapshot.revision.rosterRevision).toBe(before.revision.rosterRevision);
    expect(after.durable.snapshot.revision.conversationRevision).toBeGreaterThan(before.revision.conversationRevision);
    expect(after.durable.snapshot.state.threads[childThread.id]).toEqual(childThread);
    const starts = frames().slice(frameOffset).filter((frame) => frame.phase === "saved" && frame.through === 0);
    expect(starts).toHaveLength(2);
    for (const frame of starts) {
      if (frame.phase !== "saved") throw new Error("Expected saved startup frame");
      expect(frame.revision.rosterRevision).toBe(before.revision.rosterRevision);
    }
    const recordedParent = starts.flatMap((frame) => frame.phase === "saved" ? frame.events : [])
      .find((event) => event.payload.type === "thread.recorded");
    expect(recordedParent?.payload).toMatchObject({ thread: { rosterRevision: before.revision.rosterRevision } });
    const restarted = new CanonicalAcceptedProgress(new MainCanonicalAgentBoundary(reader, databaseWriter, writer, () => {}), writer);
    try {
      const restored = restarted.recover(execution.threadId, before.revision);
      if (restored.durable.mode !== "snapshot") throw new Error("Expected restarted snapshot");
      expect(restored.durable.snapshot.revision).toEqual(after.durable.snapshot.revision);
      expect(restored.durable.snapshot.state.threads[childThread.id]).toEqual(childThread);
      expect(restored.durable.snapshot.state.threads[execution.threadId]?.rosterRevision).toBe(before.revision.rosterRevision);
    } finally {
      await restarted.close();
    }
  });

  it("retains a child roster, transcript and exact Stop without consuming the parent's next ordinal", async () => {
    await send(1, start("codex"));
    holdWrites();
    const spawn = familyDraft(1, "toolUse", { toolCallId: "spawn", toolName: "Agent", toolInput: {} },
      { collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-child"], prompt: "Child task" } });
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [spawn] })).result.kind).toBe("accepted");
    const evidence = { nativeThreadId: "native-child", nativeTurnId: "native-turn", parentCollaborationItemId: "spawn" };
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(2, "turnStarted", {}, { child: evidence })] })).result.kind).toBe("accepted");
    const roster = progress.loadSubagentRoster({ owningParentThreadId: execution.threadId, limit: 100 });
    const childId = roster?.active[0]?.id;
    if (!childId) throw new Error("Expected accepted child roster");
    expect(() => progress.assertThreadDeletionSupported(childId)).toThrow("Provider-owned child");
    expect(() => progress.assertThreadDeletionSupported(execution.threadId)).not.toThrow();
    expect(progress.loadSubagentStopTarget({ owningParentThreadId: execution.threadId, childThreadId: childId }))
      .toMatchObject({ nativeThreadId: "native-child", nativeTurnId: "native-turn", latestTurn: { status: "Running" } });
    expect(db.prepare("SELECT id FROM threads WHERE id = ?").get(childId)).toBeNull();
    expect((await send(4, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(3, "system", { subtype: "provider.notice.warning", message: "Child provider warning",
        systemNotice: { kind: "warning", presentation: "timeline", scope: "session", sessionId: "child-session" } },
      { child: evidence })] })).result.kind).toBe("accepted");
    const childTurn = recovery().retained.flatMap((event) => event.payload.type === "collaboration.observed" ? event.payload.changes : [])
      .find((change) => change.kind === "turn-started" && change.turn.threadId === childId);
    if (!childTurn) throw new Error("Accepted child turn identity is missing");
    const childNotice = recovery().retained.find((envelope) => envelope.payload.type === "publication.recorded"
      && envelope.payload.event.type === "system" && envelope.payload.event.message === "Child provider warning");
    expect(childNotice).toMatchObject({ payload: { event: { threadId: childId, turnExecutionId: childTurn.sourceExecution.executionId } } });
    expect((await send(5, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(4, "textDelta", { delta: "Child answer" }, { child: { ...evidence,
        nativeItemId: "child-message", itemEventKey: "delta" } })] })).result.kind).toBe("accepted");
    const beforeStop = progress.recover(childId, { conversationRevision: 0, rosterRevision: 0 });
    expect(beforeStop.ownerThreadId).toBe(execution.threadId);
    expect(beforeStop.retained.some((event) => event.payload.type === "collaboration.observed"
      && event.payload.changes.some((change) => change.kind === "item-recorded" && change.item.threadId === childId
        && JSON.stringify(change.item.payload).includes("Child answer")))).toBe(true);
    expect(progress.finishSubagentTurn({ childThreadId: childId, nativeTurnId: "native-turn",
      outcome: "interrupted", error: "Interrupted by user" })?.status).toBe("Interrupted");
    expect((await send(6, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 5, "textDelta", { delta: "Parent continues", isFinalResponse: true })] })).result.kind).toBe("accepted");
    expect((await send(7, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 6, "turnComplete")], terminalInput: { ...execution, providerId: "codex", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } })).result.kind).toBe("accepted");
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT id FROM threads WHERE id = ?").get(childId)).toEqual({ id: childId });
    expect(progress.loadSubagentStopTarget({ owningParentThreadId: execution.threadId, childThreadId: childId }))
      .toMatchObject({ latestTurn: { status: "Interrupted" } });
    const saved = new CanonicalAgentStore(db, () => {});
    expect(saved.loadSubagentStopTarget({ owningParentThreadId: execution.threadId, childThreadId: childId }))
      .toMatchObject({ latestTurn: { status: "Interrupted" } });
    expect(saved.loadTurn(execution.turnId)?.status).toBe("Completed");
    expect(saved.loadConversationProjection(childId, 20).messages.map((message) => message.content))
      .toEqual(["Child task", "Child answer"]);
    expect(db.prepare("SELECT role, content FROM messages WHERE thread_id = ? AND role <> 'system' ORDER BY sequence").all(childId))
      .toEqual([{ role: "user", content: "Child task" }, { role: "assistant", content: "Child answer" }]);
    const childPublication = db.prepare("SELECT envelope_json FROM canonical_agent_events WHERE event_id = ?")
      .get(`${lease.leaseId}:4:publication:0`);
    expect(childPublication).toBeTruthy();
    expect(saved.loadAcceptedFeatureSeed(execution.threadId).noticeSessionId).not.toBe("child-session");
    expect(progress.recover(childId, { conversationRevision: 0, rosterRevision: 0 }).retained).toEqual([]);
  });

  it("materializes a native child completion before the parent finishes without a child writer checkpoint", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(1, "toolUse", { toolCallId: "spawn", toolName: "Agent", toolInput: {} },
        { collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-child"], prompt: "Child task" } })] });
    const evidence = { nativeThreadId: "native-child", nativeTurnId: "native-turn", parentCollaborationItemId: "spawn" };
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(2, "turnStarted", {}, { child: evidence })] });
    const childId = progress.loadSubagentRoster({ owningParentThreadId: execution.threadId, limit: 100 })?.active[0]?.id;
    if (!childId) throw new Error("Expected accepted child roster");
    await send(4, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(3, "textDelta", { delta: "Child answer" }, { child: { ...evidence,
        nativeItemId: "child-message", itemEventKey: "delta" } })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const saved = new CanonicalAgentStore(db, () => {});
    expect(saved.loadConversationProjection(childId, 20).messages.map((message) => message.content)).toEqual(["Child task"]);
    expect(db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant'").all(childId)).toEqual([]);
    await send(5, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(4, "turnComplete", {}, { child: evidence })] });
    await expect.poll(() => progress.depth().pending).toBe(0);

    expect(saved.loadLatestTurn(childId)?.status).toBe("Completed");
    expect(saved.loadTurn(execution.turnId)?.status).toBe("Running");
    expect(db.prepare("SELECT turn_id FROM canonical_agent_ingest_checkpoints WHERE thread_id = ?").all(childId)).toEqual([]);
    expect(saved.loadConversationProjection(childId, 20).messages.map((message) => message.content))
      .toEqual(["Child task", "Child answer"]);
    expect(db.prepare("SELECT role, content FROM messages WHERE thread_id = ? ORDER BY sequence").all(childId))
      .toEqual([{ role: "user", content: "Child task" }, { role: "assistant", content: "Child answer" }]);

    await send(6, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 5, "toolResult", { toolCallId: "spawn", output: "Child answer", isError: false })] });
    await send(7, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 6, "textDelta", { delta: "Parent answer", isFinalResponse: true })] });
    await send(8, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 7, "turnComplete")], terminalInput: { ...execution, providerId: "codex", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const detailTarget = encodeCanonicalSubagentDetailTarget(childId);
    expect(saved.loadItem("toolCall:spawn")?.payload).toMatchObject({
      childThreadId: childId, record: { subagent_identity_key: detailTarget },
    });
    expect(db.prepare("SELECT subagent_identity_key FROM tool_call_records WHERE id = 'spawn'").get())
      .toEqual({ subagent_identity_key: detailTarget });
    const parentPage = saved.loadConversationProjection(execution.threadId, 20);
    expect(Object.values(parentPage.narrativeByMessage).flatMap((batch) => batch.tools).find((tool) => tool.id === "spawn"))
      .toMatchObject({ subagent_identity_key: detailTarget });
  });

  it("saves native ACP thought and unknown assistant channels as distinct narration before the next thought", async () => {
    await send(1, start("devin"));
    const append = vi.spyOn(writer, "appendAccepted");
    const state = createDevinAcpTurnState();
    const notifications: SessionNotification[] = [
      { sessionId: "devin-session", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "THOUGHT" } } },
      { sessionId: "devin-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "UNKNOWN" } } },
      { sessionId: "devin-session", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "NEXT" } } },
    ];
    let ordinal = 1;
    let sequence = 0;
    for (const notification of notifications) {
      for (const event of mapDevinAcpSessionNotification(notification, execution.threadId, state)) {
        const { type, ...fields } = event;
        expect((await send(++ordinal, { kind: "event", phase: "running", nativeCursor: null,
          events: [draft("devin", ++sequence, type, fields)] })).result.kind).toBe("accepted");
      }
    }
    await expect.poll(() => append.mock.results.length).toBeGreaterThanOrEqual(3);
    await expect(append.mock.results[2]?.value).resolves.toHaveProperty("receipt");
    await expect.poll(() => progress.depth().pending).toBe(0);
    const canonical = new CanonicalAgentStore(db, () => {});
    expect(canonical.loadParentNarrativeForBinding(execution.threadId, execution.turnId)
      .flatMap((item) => item.kind === "narrationSegment" ? [item.record.text] : [])).toEqual(["THOUGHT", "UNKNOWN", "NEXT"]);
    expect(db.prepare("SELECT retained_bytes FROM parent_assistant_text_checkpoints WHERE execution_id = ?")
      .get(execution.executionId)).toBeNull();
    await send(++ordinal, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", ++sequence, "turnComplete")], terminalInput: { ...execution,
        providerId: "devin", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(canonical.loadTurn(execution.turnId)?.status).toBe("Completed");
  });

  it("accepts the native Devin final-prefix, later unknown narration and final completion sequence while saving is held", async () => {
    await send(1, start("devin"));
    let ordinal = 1;
    let sequence = 0;
    const event = async (type: AgentEvent["type"], fields: Record<string, unknown> = {}) => {
      const value = draft("devin", ++sequence, type, fields);
      const terminalInput = type === "turnComplete" ? { ...execution, providerId: "devin", providerIdentities: [],
        outcome: "completed" as const, projection: { kind: "writer-staged" as const } } : undefined;
      expect((await send(++ordinal, { kind: "event", phase: "running", nativeCursor: null, events: [value],
        ...(terminalInput ? { terminalInput } : {}) })).result.kind).toBe("accepted");
    };
    await event("textDelta", { delta: "INITIAL_THOUGHT", isFinalResponse: false });
    await event("toolUse", { toolCallId: "prefix", toolName: "Read", toolInput: {} });
    await event("toolResult", { toolCallId: "prefix", output: "Done", isError: false });
    await event("textDelta", { delta: "PREFIX\n", isFinalResponse: true });
    await expect.poll(() => progress.depth().pending).toBe(0);
    holdWrites();
    await event("assistantMessageBoundary", { isFinalResponse: true });
    await event("toolUse", { toolCallId: "later", toolName: "Read", toolInput: {} });
    await event("textDelta", { delta: "AFTER_TOOL\n" });
    await event("toolResult", { toolCallId: "later", output: "Done", isError: false });
    await event("assistantMessageBoundary", { isFinalResponse: false });
    await event("textDelta", { delta: "COMPLETE", isFinalResponse: true });
    await event("message", { content: "PREFIX\nCOMPLETE", tokens: null });
    await event("turnComplete");
    expect(progress.latestAssistantMessage(execution.threadId)?.content).toBe("PREFIX\nCOMPLETE");
    const before = recovery().retained.map((value) => ({ id: value.eventId, position: value.progressPosition }));
    const reclassification = recovery().retained.filter((value) => value.payload.type === "item.recorded"
      && value.payload.item.payload.projection === "narrativeRecovery");
    expect(JSON.stringify(reclassification)).toContain("AFTER_TOOL");
    expect(JSON.stringify(reclassification)).not.toContain("PREFIX");
    expect(recovery().retained.some((value) => value.payload.type === "turn.completed")).toBe(true);
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(new CanonicalAgentStore(db, () => {}).loadTerminalProjection(execution.turnId).message?.content).toBe("PREFIX\nCOMPLETE");
    const saved = frames().flatMap((frame) => frame.phase === "saved" ? frame.events : [])
      .filter((value) => before.some((event) => event.id === value.eventId));
    expect(saved.map((value) => ({ id: value.eventId, position: value.progressPosition }))).toEqual(before);
  });

  it("cancels an ACP turn when its terminal snapshot restores an earlier accepted tool record", async () => {
    await send(1, start("devin"));
    holdWrites();
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", 1, "toolUse", { toolCallId: "agent", toolName: "Agent",
        toolInput: { name: "Original", agentId: "child-agent" } })] })).result.kind).toBe("accepted");
    const source = recovery().retained.find((event) => event.payload.type === "item.recorded"
      && event.payload.item.id === "toolCall:agent");
    if (source?.payload.type !== "item.recorded") throw new Error("Expected accepted ACP tool narrative");
    const narrative = ParentNarrativeRecoveryItemSchema().parse(source.payload.item.payload.narrative);
    if (narrative.kind !== "toolCall") throw new Error("Expected tool recovery record");
    expect((await send(3, { kind: "narrative-delta", input: { executionId: execution.executionId,
      items: [{ ...narrative, record: { ...narrative.record, display_name: "Enriched display identity" } }] } })).result.kind)
      .toBe("accepted");

    expect((await handler.handle({ requestId: 4, execution, lease, ordinal: 4, stopWatermark: 3,
      command: { kind: "stop", requestId: "user-stop" } })).result.kind).toBe("accepted");
    await expect(send(5, { kind: "finish-from-state", outcome: "cancelled", input: { ...execution,
      providerId: "devin", providerIdentities: [], outcome: "cancelled", projection: { kind: "writer-staged" } } }))
      .resolves.toMatchObject({ result: { kind: "accepted" } });
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);

    const saved = new CanonicalAgentStore(db, () => {});
    expect(saved.loadTurn(execution.turnId)?.status).toBe("Cancelled");
    expect(db.prepare("SELECT id, status FROM tool_call_records").all())
      .toEqual([{ id: "agent", status: "cancelled" }]);
    expect(Object.values(saved.loadConversationProjection(execution.threadId, 20).narrativeByMessage)
      .flatMap((batch) => batch.tools).map((tool) => tool.id)).toEqual(["agent"]);
  });

  it("publishes and saves thread-scoped synthesized observations without a turn", async () => {
    await writer.whenReady();
    const boundary = new MainCanonicalAgentBoundary(reader, databaseWriter, writer, () => {});
    boundary.bindAcceptedSynthesizedPublications((threadId, events) => progress.acceptSynthesizedPublications(threadId, events));
    const observed = boundary.recordSynthesizedPublications(execution.threadId, [{
      type: "system", threadId: execution.threadId, subtype: "goal.paused", message: "Paused",
    }]);

    expect(observed).toHaveLength(2);
    expect(observed.map((event) => event.payload)).toContainEqual({
      type: "publication.recorded", publicationId: "1", event: {
        type: "system", threadId: execution.threadId, subtype: "goal.paused", message: "Paused", publicationId: "1",
      },
    });
    for (const event of observed) {
      expect(event.routing).toEqual({ threadId: execution.threadId, executionId: syntheticThreadExecutionId(execution.threadId) });
    }
    expect(frames().flatMap((frame) => frame.phase === "accepted" ? frame.events : [])).toEqual(observed);
    await expect.poll(() => progress.depth().pending).toBe(0);
    const saved = frames().flatMap((frame) => frame.phase === "saved" ? frame.events : []);
    expect(saved.map((event) => ({ eventId: event.eventId, routing: event.routing, payload: event.payload })))
      .toEqual(observed.map((event) => ({ eventId: event.eventId, routing: event.routing, payload: event.payload })));
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_ingest_checkpoints").get()).toEqual({ count: 0 });
  });

  it("keeps headless conversation sequences separate across an accepted-owner restart", async () => {
    await writer.whenReady();
    const otherThreadId = "second-headless-thread";
    const threadIds = [execution.threadId, otherThreadId];
    insertThread(otherThreadId);
    holdWrites();
    for (const threadId of threadIds) {
      const accepted = progress.acceptSynthesizedPublications(threadId, [{ type: "system", threadId,
        subtype: "goal.paused", message: "Paused" }]);
      expect(accepted.map((event) => event.acceptedSequence)).toEqual([1, 2]);
      expect(accepted.map((event) => event.routing)).toEqual([
        { threadId, executionId: syntheticThreadExecutionId(threadId) },
        { threadId, executionId: syntheticThreadExecutionId(threadId) },
      ]);
    }
    expect(syntheticThreadExecutionId(execution.threadId)).not.toBe(syntheticThreadExecutionId(otherThreadId));
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    await progress.close();
    progress = new CanonicalAcceptedProgress(new MainCanonicalAgentBoundary(reader, databaseWriter, writer, () => {}), writer);

    for (const threadId of threadIds) {
      const accepted = progress.acceptSynthesizedPublications(threadId, [{ type: "system", threadId,
        subtype: "goal.resumed", message: "Resumed" }]);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ acceptedSequence: 3,
        routing: { threadId, executionId: syntheticThreadExecutionId(threadId) },
        payload: { type: "publication.recorded", publicationId: "2", event: { subtype: "goal.resumed", message: "Resumed" } } });
    }
    await expect.poll(() => progress.depth().pending).toBe(0);
    for (const threadId of threadIds) {
      const saved = frames().flatMap((frame) => frame.phase === "saved" && frame.threadId === threadId ? frame.events : []);
      expect(saved.map((event) => event.acceptedSequence)).toEqual([1, 2, 3]);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_ingest_checkpoints").get()).toEqual({ count: 0 });
  });

  it("keeps a higher saved publication head when an older assigned batch commits", async () => {
    await writer.whenReady();
    holdWrites();
    const accepted = progress.acceptSynthesizedPublications(execution.threadId, [{ type: "system", threadId: execution.threadId,
      subtype: "goal.paused", message: "Paused" }]);
    expect(accepted.at(-1)?.payload).toMatchObject({ type: "publication.recorded", publicationId: "1" });
    db.prepare("INSERT INTO canonical_writer_live_publication_heads (thread_id, last_sequence) VALUES (?, ?)")
      .run(execution.threadId, 50);
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT last_sequence FROM canonical_writer_live_publication_heads WHERE thread_id = ?").get(execution.threadId))
      .toEqual({ last_sequence: 50 });
    await progress.close();
    progress = new CanonicalAcceptedProgress(new MainCanonicalAgentBoundary(reader, databaseWriter, writer, () => {}), writer);
    const resumed = progress.acceptSynthesizedPublications(execution.threadId, [{ type: "system", threadId: execution.threadId,
      subtype: "goal.resumed", message: "Resumed" }]);
    expect(resumed.at(-1)?.payload).toMatchObject({ type: "publication.recorded", publicationId: "51" });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT last_sequence FROM canonical_writer_live_publication_heads WHERE thread_id = ?").get(execution.threadId))
      .toEqual({ last_sequence: 51 });
  });

  it.each([
    { publicationId: "01", failureName: "ZodError", failureMessage: expect.stringContaining('"publicationId"') },
    { publicationId: "9007199254740992", failureName: "Error",
      failureMessage: "Canonical writer write-failed: Accepted publication requires a positive safe sequence" },
  ])("rolls back events and the publication head for invalid assigned ID $publicationId", async ({ publicationId, failureName, failureMessage }) => {
    await writer.whenReady();
    const append = writer.appendAccepted.bind(writer);
    vi.spyOn(writer, "appendAccepted").mockImplementationOnce((operationId, input) => append(operationId, { ...input,
      events: input.events.map((event) => event.payload.type === "publication.recorded"
        ? { ...event, payload: { ...event.payload, publicationId } } : event),
    }));
    progress.acceptSynthesizedPublications(execution.threadId, [{ type: "system", threadId: execution.threadId,
      subtype: "goal.paused", message: "Paused" }]);
    await expect.poll(() => progress.savingStatuses(execution.threadId)[0]).toMatchObject({ mode: "saving-failed",
      failure: { name: failureName, message: failureMessage } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_live_publication_heads").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_thread_operation_receipts").get()).toEqual({ count: 0 });
    expect(progress.retry(execution.threadId)).toBe(true);
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT last_sequence FROM canonical_writer_live_publication_heads WHERE thread_id = ?").get(execution.threadId))
      .toEqual({ last_sequence: 1 });
  });

  it("orders synthesized observations behind a held provider suffix without consuming its next ordinal", async () => {
    await send(1, start("codex"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Held", isFinalResponse: true })] });
    const boundary = new CanonicalAgentStore(db, () => {});
    boundary.bindAcceptedSynthesizedPublications((threadId, events) => progress.acceptSynthesizedPublications(threadId, events));
    const observed = boundary.recordSynthesizedPublications(execution.threadId, [{ type: "system", threadId: execution.threadId,
      subtype: "goal.paused", message: "Paused" }]);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.routing.executionId).toBe(execution.executionId);
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "textDelta", { delta: " continues", isFinalResponse: true })] })).result.kind).toBe("accepted");
    const before = recovery();
    expect(before.retained.map((event) => event.progressPosition.sequence)).toEqual(
      Array.from({ length: before.retained.length }, (_, index) => index + 1));
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(recovery().savedThrough).toBe(before.acceptedThrough);
    const publications = frames().flatMap((frame) => frame.phase === "accepted" ? frame.events : [])
      .filter((event) => event.payload.type === "publication.recorded");
    const latest = publications.at(-1);
    if (latest?.payload.type !== "publication.recorded") throw new Error("Expected accepted publication head");
    expect(db.prepare("SELECT last_sequence FROM canonical_writer_live_publication_heads WHERE thread_id = ?").get(execution.threadId))
      .toEqual({ last_sequence: Number(latest.payload.publicationId) });
  });

  it("admits an external late hook behind its unsaved terminal and preserves that original correlation on a later turn", async () => {
    await send(1, start("codex"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Original answer", isFinalResponse: true })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "turnComplete")], terminalInput: { ...execution, providerId: "codex", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } });
    const original = progress.latestAssistantMessage(execution.threadId);
    if (!original) throw new Error("Expected original accepted assistant");
    const hook = { id: "external-hook", hookName: "Stop", toolName: null, phase: "stop", payload: "{}", durationMs: 12,
      didBlock: false, startedAt: NOW, endedAt: NOW, sortOrder: 9 };
    progress.acceptLateHook(execution.threadId, execution.executionId, hook);
    const acceptedCount = recovery().acceptedThrough;
    progress.acceptLateHook(execution.threadId, execution.executionId, hook);
    expect(recovery().acceptedThrough).toBe(acceptedCount);
    expect(db.prepare("SELECT id FROM hook_executions WHERE id = ?").get(hook.id)).toBeNull();
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    await send(4, { kind: "release" });
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000125" };
    await send(1, start("codex", next), next, { ...lease, leaseId: "next-lease" });
    progress.acceptLateHook(execution.threadId, execution.executionId, { ...hook, id: "later-external-hook" });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT message_id FROM hook_executions WHERE id = ?").get("later-external-hook")).toEqual({ message_id: original.id });
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(next.turnId)).toEqual({ status: "Running" });
  });

  it.each([
    ["completes", 5, async () => send(5, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("claude", 4, "turnComplete")], terminalInput: { ...execution, providerId: "claude", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } })],
    ["is stopped", 6, async () => {
      await handler.handle({ requestId: 5, execution, lease, ordinal: 5, stopWatermark: 4, command: { kind: "stop", requestId: "user-stop" } });
      return send(6, { kind: "finish-from-state", outcome: "cancelled", input: { ...execution, providerId: "claude",
        providerIdentities: [], outcome: "cancelled", projection: { kind: "writer-staged" } } });
    }],
  ] as const)("keeps a background call running after its turn %s and settles it once from its late result", async (_ending, releaseOrdinal, finish) => {
    await send(1, start("claude"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("claude", 1, "toolUse", { toolCallId: "agent", toolName: "Agent", toolInput: { prompt: "Look around" } })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("claude", 2, "toolBackgrounded", { toolCallId: "agent" })] });
    await send(4, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("claude", 3, "textDelta", { delta: "Started a background agent", isFinalResponse: true })] });
    expect((await finish()).result.kind).toBe("accepted");
    await expect.poll(() => progress.depth().pending).toBe(0);
    await send(releaseOrdinal + 1, { kind: "release" });
    const saved = new CanonicalAgentStore(db, () => {});
    expect(db.prepare("SELECT status, completed_at, background FROM tool_call_records WHERE id = 'agent'").get())
      .toEqual({ status: "running", completed_at: null, background: 1 });
    expect(saved.listHeldBackgroundToolCalls())
      .toEqual([{ threadId: execution.threadId, executionId: execution.executionId, toolCallId: "agent" }]);
    const original = progress.latestAssistantMessage(execution.threadId);
    if (!original) throw new Error("Expected original accepted assistant");

    const result = { toolCallId: "agent", status: "completed", output: "Found the bug" } as const;
    progress.acceptLateToolResult(execution.threadId, execution.executionId, result);
    const acceptedCount = recovery().acceptedThrough;
    progress.acceptLateToolResult(execution.threadId, execution.executionId, result);
    expect(recovery().acceptedThrough).toBe(acceptedCount);
    expect(() => progress.acceptLateToolResult(execution.threadId, execution.executionId, { ...result, status: "failed" }))
      .toThrow("conflicts");
    await expect.poll(() => progress.depth().pending).toBe(0);

    expect(db.prepare("SELECT message_id, status, output_summary, background FROM tool_call_records WHERE id = 'agent'").get())
      .toEqual({ message_id: original.id, status: "completed", output_summary: "Found the bug", background: 1 });
    expect(saved.listHeldBackgroundToolCalls()).toEqual([]);
    const publication = frames().flatMap((frame) => frame.phase === "accepted" ? frame.events : [])
      .flatMap((event) => event.payload.type === "publication.recorded" ? [event.payload.event] : [])
      .find((event) => event.type === "toolResult" && event.toolCallId === "agent" && "persistedMessageId" in event);
    expect(publication).toMatchObject({ output: "Found the bug", isError: false, persistedMessageId: original.id });
    expect(publication).not.toHaveProperty("turnExecutionId");
  });

  it("leaves a background call's running step for the call's late result instead of the turn end", async () => {
    await send(1, start("claude"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("claude", 1, "toolUse", { toolCallId: "agent", toolName: "Agent", toolInput: { prompt: "Look around" } })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("claude", 2, "toolBackgrounded", { toolCallId: "agent" })] });
    await send(4, { kind: "event", phase: "running", nativeCursor: null, events: [draft("claude", 3, "toolUse",
      { toolCallId: "agent-step", toolName: "Bash", toolInput: { command: "ls" }, parentToolCallId: "agent" })] });
    await send(5, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("claude", 4, "textDelta", { delta: "Started a background agent", isFinalResponse: true })] });
    expect((await send(6, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("claude", 5, "turnComplete")], terminalInput: { ...execution, providerId: "claude", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } })).result.kind).toBe("accepted");
    await expect.poll(() => progress.depth().pending).toBe(0);
    await send(7, { kind: "release" });
    const step = () => db.prepare("SELECT parent_tool_call_id, message_id, status, completed_at FROM tool_call_records WHERE id = 'agent-step'").get();
    expect(step()).toEqual({ parent_tool_call_id: "agent", message_id: expect.any(String), status: "running", completed_at: null });
    const original = progress.latestAssistantMessage(execution.threadId);
    if (!original) throw new Error("Expected original accepted assistant");

    progress.acceptLateToolResult(execution.threadId, execution.executionId, { toolCallId: "agent", status: "completed", output: "Found it" });
    await expect.poll(() => progress.depth().pending).toBe(0);

    const agent = db.prepare("SELECT completed_at FROM tool_call_records WHERE id = 'agent'").get();
    expect(step()).toEqual({ parent_tool_call_id: "agent", message_id: original.id, status: "completed", ...agent });
  });

  it("assigns live plan, task and notice projections before storage and persists those same identities", async () => {
    const admission = start("codex");
    await send(1, { ...admission, parentLive: { ...admission.parentLive, precedingMessageId: `${execution.turnId}:user`, planFeature: "output" } });
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 1, "toolUse", {
      toolCallId: "tasks", toolName: "TodoWrite", toolInput: { todos: [{ content: "Build", status: "in_progress", activeForm: "Building" }] } })] });
    expect(progress.getTasks(execution.threadId)).toMatchObject([{ content: "Build", status: "in_progress" }]);
    const content = '````mcode-plan\n# Plan\n\n## Build\nBuild it\n````';
    await send(3, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 2, "textDelta", { delta: content, isFinalResponse: true })] });
    await send(4, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 3, "message", { content, tokens: null })] });
    const plan = progress.reloadPlans(execution.threadId)?.[0];
    if (!plan) throw new Error("Expected accepted plan before saving");
    expect(progress.reloadPlans(execution.threadId)).toEqual([plan]);
    await send(5, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 4, "system", {
      subtype: "provider.notice.test", message: "Notice", systemNotice: { kind: "diagnostic", presentation: "timeline", scope: "turn", sessionId: "session" } })] });
    const notice = frames().flatMap((frame) => frame.phase === "accepted" ? frame.events : []).map(acceptedMessage)
      .find((message) => message?.role === "system");
    if (!notice) throw new Error("Expected accepted notice");
    expect(db.prepare("SELECT id FROM plans WHERE id = ?").get(plan.id)).toBeNull();
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT id, message_id, version, status, created_at FROM plans WHERE id = ?").get(plan.id))
      .toEqual({ id: plan.id, message_id: plan.messageId, version: plan.version, status: "ready", created_at: plan.createdAt });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get(notice.id)).toEqual({ id: notice.id });
    expect(progress.getTasks(execution.threadId)).toEqual(new (await import("../../orchestration/persistence/task-repo.js")).TaskRepo(db, databaseWriter).get(execution.threadId));
  });

  it("reloads saved versions without a canonical assistant owner", async () => {
    const { PlanRepo } = await import("../../planning/persistence/plan-repo.js");
    db.prepare("INSERT INTO messages (id, thread_id, role, content, sequence, timestamp) VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy-plan-message", execution.threadId, "assistant", "Legacy plan", 1, NOW);
    const plans = new PlanRepo(reader, databaseWriter);
    await progress.beforeDurableCommand(execution.threadId);
    progress.cancelDurableCommand(execution.threadId);
    const plan = await plans.create(execution.threadId, "legacy-plan-message",
      { title: "Legacy plan", contentMd: "# Legacy plan", captureSource: "fence" }, null);
    expect(progress.reloadPlans(execution.threadId)).toEqual([plan]);
    expect(progress.depth().pending).toBe(0);
    expect(plans.getById(plan.id)?.status).toBe("ready");
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_turns").get()).toEqual({ count: 0 });
  });

  it("retains a rejected older late hook while the current execution continues on its bounded owner", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Original", isFinalResponse: true })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 2, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    await send(4, { kind: "release" });
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000125" };
    const nextLease = { ...lease, leaseId: "next-lease" };
    await send(1, start("codex", next), next, nextLease);
    db.run("CREATE TRIGGER fail_late_hook BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.operation_id = 'late-hook:blocked-hook' BEGIN SELECT RAISE(ABORT, 'late hook save unavailable'); END");
    const affected: string[] = [];
    progress.bindPermanentFailure(async (active, error) => {
      affected.push(active.executionId);
      progress.interruptWorkerLoss({ execution: active, lease: nextLease, reason: error.message, recoveryIncidentId: "old-hook-failure" });
    });
    progress.acceptLateHook(execution.threadId, execution.executionId, { id: "blocked-hook", hookName: "Stop", toolName: null,
      phase: "stop", payload: "{}", durationMs: 10, didBlock: false, startedAt: NOW, endedAt: NOW, sortOrder: 1 });
    await expect.poll(() => progress.savingStatuses(execution.threadId).find((status) => status.executionId === execution.executionId)?.mode).toBe("saving-failed");
    expect(affected).toEqual([]);
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Current turn continues", isFinalResponse: true }, next)] }, next, nextLease)).result.kind).toBe("accepted");
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "turnComplete", {}, next)], terminalInput: { ...next, providerId: "codex",
        providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } }, next, nextLease)).result.kind).toBe("accepted");
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    db.run("DROP TRIGGER fail_late_hook");
    expect(progress.retry(execution.threadId)).toBe(true);
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT id FROM hook_executions WHERE id = 'blocked-hook'").get()).toEqual({ id: "blocked-hook" });
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(next.turnId)).toEqual({ status: "Completed" });
    expect(affected).toEqual([]);
  });

  it("rejects an empty terminal hook without attaching it to a prior assistant response", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 1, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    expect(() => progress.acceptLateHook(execution.threadId, execution.executionId, { id: "empty-hook", hookName: "Stop", toolName: null,
      phase: "stop", payload: "{}", durationMs: 0, didBlock: false, startedAt: NOW, endedAt: NOW, sortOrder: 1 })).toThrow("no assistant message");
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT id FROM hook_executions WHERE id = 'empty-hook'").get()).toBeNull();
  });

  it("discards the queued suffix only after the in-flight save settles and releases its retention budget", async () => {
    await send(1, start("codex"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "In flight", isFinalResponse: true })] });
    await expect.poll(() => writer.appendAccepted).toHaveBeenCalledTimes(1);
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "textDelta", { delta: "Discard", isFinalResponse: true })] });
    let disposed = false;
    const deleting = progress.discardThread(execution.threadId).then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release?.();
    await deleting;
    expect(writer.appendAccepted).toHaveBeenCalledTimes(1);
    expect(progress.depth().retained).toMatchObject({ events: 0, bytes: 0 });
    expect(db.prepare("SELECT event_id FROM canonical_agent_events WHERE event_id = ?").get(`${execution.executionId}:raw:2`)).toBeNull();
    expect(() => progress.acceptSynthesizedPublications(execution.threadId,
      [{ type: "system", threadId: execution.threadId, subtype: "late" }])).toThrow("deletion is in progress");
    progress.finishThreadDeletion(execution.threadId);
  });

  it("interrupts a fully saved family child on restart even after its parent has completed", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(1, "toolUse", { toolCallId: "spawn", toolName: "Agent", toolInput: {} },
        { collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-child"], prompt: "Child" } })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [familyDraft(2, "turnStarted", {}, { child: { nativeThreadId: "native-child", nativeTurnId: "native-turn",
        parentCollaborationItemId: "spawn" } })] });
    const childId = progress.loadSubagentRoster({ owningParentThreadId: execution.threadId, limit: 100 })?.active[0]?.id;
    if (!childId) throw new Error("Expected accepted child");
    await send(4, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 3, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const boundary = new CanonicalAgentStore(db, () => {});
    expect(boundary.interruptSavedFamilyChildren("Server restarted")).toEqual([childId]);
    expect(boundary.loadSubagentStopTarget({ owningParentThreadId: execution.threadId, childThreadId: childId })?.latestTurn?.status).toBe("Interrupted");
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    expect(boundary.interruptSavedFamilyChildren("Server restarted")).toEqual([]);
  });

  it.each(["codex", "devin"])("accepts %s text, tools and terminal while storage is held, retaining them after worker release", async (providerId) => {
    expect((await send(1, start(providerId))).result.kind).toBe("committed");
    holdWrites();
    const event = (ordinal: number, sequence: number, type: AgentEvent["type"], fields: Record<string, unknown> = {}) =>
      send(ordinal, { kind: "event", phase: "running", nativeCursor: null, events: [draft(providerId, sequence, type, fields)] });
    expect((await event(2, 1, "textDelta", { delta: "Checking", isFinalResponse: false })).result.kind).toBe("accepted");
    expect((await event(3, 2, "toolUse", { toolCallId: "read", toolName: "Read", toolInput: { file_path: "file.txt" } })).result.kind).toBe("accepted");
    expect((await event(4, 3, "toolResult", { toolCallId: "read", output: "Done", isError: false })).result.kind).toBe("accepted");
    expect((await event(5, 4, "textDelta", { delta: "Answer", isFinalResponse: true })).result.kind).toBe("accepted");
    expect((await send(6, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft(providerId, 5, "turnComplete")], terminalInput: { ...execution, providerId,
        providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } })).result).toMatchObject({ kind: "accepted" });
    expect((await send(7, { kind: "release" })).result.kind).toBe("released");
    const cut = recovery();
    expect(cut.retained.some((event) => event.payload.type === "turn.completed")).toBe(true);
    expect(cut.retained.some((event) => event.payload.type === "item.recorded" && event.payload.item.kind === "tool-call")).toBe(true);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Running" });
    const ids = cut.retained.map((event) => event.eventId);
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(recovery().retained).toHaveLength(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    const savedIds = frames().flatMap((frame) => frame.phase === "saved" ? frame.events.map((event) => event.eventId) : []);
    expect(savedIds.filter((id) => ids.includes(id))).toEqual(ids);
    expect(new Set(savedIds).size).toBe(savedIds.length);
  });

  it("fences a later durable start before it can overtake the previous save acknowledgement", async () => {
    await send(1, start("codex"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 1, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await send(3, { kind: "release" });
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000124" };
    const nextLease = { ...lease, leaseId: "next-lease" };
    let started = false;
    const pending = send(1, start("codex", next), next, nextLease).then((reply) => { started = true; return reply; });
    await Promise.resolve();
    expect(started).toBe(false);
    expect(db.prepare("SELECT id FROM canonical_agent_turns WHERE id = ?").get(next.turnId)).toBeNull();
    release?.();
    expect((await pending).result.kind).toBe("committed");
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Next", isFinalResponse: true }, next)] }, next, nextLease)).result.kind).toBe("accepted");
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(recovery().loss).toBe("none");
  });

  it("replays the original full-port acceptance receipt before and after saving without regenerating identities", async () => {
    await send(1, start("codex"));
    holdWrites();
    const operation: ExecutionSemanticOperation = { operationId: "live-lease:2", execution, lease, ordinal: 2,
      livePublication: [{ after: "terminal", event: { type: "turnComplete", threadId: execution.threadId,
        turnExecutionId: execution.executionId, reason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0 } }],
      mutation: { kind: "finish-live-event", outcome: "completed", projection: { ...execution, outcome: "completed", endedAt: NOW,
        assistant: { content: "Stable answer", model: "fixture", attachments: [] }, narrative: [completedTool(0)] },
        input: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } } };
    const first = await port.transact(operation);
    const admitted = recovery();
    const acceptedFrames = frames().filter((frame) => frame.phase === "accepted");
    expect(await port.transact(structuredClone(operation))).toEqual(first);
    const conflicting = structuredClone(operation);
    if (conflicting.mutation.kind !== "finish-live-event") throw new Error("Expected terminal operation");
    conflicting.mutation.projection.assistant.content = "Changed answer";
    await expect(port.transact(conflicting)).rejects.toThrow("identity-conflict");
    expect(recovery()).toEqual(admitted);
    expect(frames().filter((frame) => frame.phase === "accepted")).toEqual(acceptedFrames);
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    await expect.poll(() => db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND kind = 'append-accepted'")
      .get(execution.executionId)).toEqual({ count: 0 });
    expect(await port.transact(structuredClone(operation))).toEqual(first);
    expect(frames().filter((frame) => frame.phase === "accepted")).toEqual(acceptedFrames);
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000126" };
    expect((await port.transact({ operationId: "next-lease:1", execution: next, lease: { ...lease, leaseId: "next-lease" }, ordinal: 1,
      mutation: { kind: "begin", providerId: "codex", input: start("codex", next).input } })).kind).toBe("committed");
    const nextCut = recovery();
    await expect(port.transact(operation)).rejects.toThrow("matching execution lease");
    expect(recovery()).toEqual(nextCut);
  });

  it("keeps a committed prefix durable when receipt cleanup fails, and retires it before the next append", async () => {
    await send(1, start("codex"));
    db.run("CREATE TRIGGER fail_cleanup BEFORE DELETE ON canonical_writer_operation_receipts WHEN OLD.kind = 'append-accepted' BEGIN SELECT RAISE(FAIL, 'receipt cleanup unavailable'); END");
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "First", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    await expect.poll(() => writer.pendingAcknowledgementCount).toBe(1);
    expect(recovery().savedThrough).toBe(recovery().acceptedThrough);
    expect(progress.savingStatuses(execution.threadId)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND kind = 'append-accepted'")
      .get(execution.executionId)).toEqual({ count: 1 });
    db.run("DROP TRIGGER fail_cleanup");
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "textDelta", { delta: "Second", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    await expect.poll(() => writer.pendingAcknowledgementCount).toBe(0);
    await expect.poll(() => db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND kind = 'append-accepted'")
      .get(execution.executionId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT event_id FROM canonical_agent_events WHERE event_id IN (?, ?)")
      .all(`${execution.executionId}:raw:1`, `${execution.executionId}:raw:2`)).toHaveLength(2);
  });

  it("stops the exact active owner when receipt cleanup cannot fit its bounded retry queue without replaying saved events", async () => {
    await send(1, start("codex"));
    const error = new CanonicalWriterAcknowledgementCapacity("Receipt cleanup retention exhausted");
    vi.spyOn(writer, "enqueueAcknowledgement").mockImplementationOnce(() => { throw error; });
    const failures: string[] = [];
    progress.bindPermanentFailure(async (active, cause) => {
      expect(cause).toBe(error);
      failures.push(active.executionId);
      progress.interruptWorkerLoss({ execution: active, lease, reason: cause.message, recoveryIncidentId: "cleanup-capacity" });
    });
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Already saved", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(failures).toEqual([execution.executionId]);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Interrupted" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE event_id = ?")
      .get(`${execution.executionId}:raw:1`)).toEqual({ count: 1 });
  });

  it("saves multiple pages across the cleanup threshold without stopping its owner", async () => {
    await send(1, start("codex"));
    await expect.poll(() => progress.depth().pending).toBe(0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const cleanupStarted = Promise.withResolvers<void>();
    const original = databaseWriter.sendCanonical.bind(databaseWriter);
    vi.spyOn(databaseWriter, "sendCanonical").mockImplementation(async (...args) => {
      if (args[0].kind === "ack-operations") {
        cleanupStarted.resolve();
        await held;
      }
      return original(...args);
    });
    for (let index = 0; index < 63; index++) writer.enqueueAcknowledgement(execution.executionId, `previous-${index}`);
    const failures: string[] = [];
    progress.bindPermanentFailure(async (active) => { failures.push(active.executionId); });
    expect(progress.accept({ operationId: "live-lease:2", execution, lease, ordinal: 2,
      mutation: { kind: "append-events", phase: "running", nativeCursor: null,
        events: Array.from({ length: 300 }, (_, index) => draft("codex", index + 1, "textDelta", { delta: "x", isFinalResponse: true })) } }).kind).toBe("accepted");
    await cleanupStarted.promise;
    expect(failures).toEqual([]);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Running" });
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(recovery().savedThrough).toBe(recovery().acceptedThrough);
    expect(failures).toEqual([]);
    await progress.close();
    await writer.close();
    expect(db.prepare("SELECT operation_id FROM canonical_writer_operation_receipts WHERE kind = 'append-accepted'").all()).toEqual([]);
  });

  it("rejects all admission while a durable command is fenced or the service is closing", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Question", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const assistant = progress.latestAssistantMessage(execution.threadId);
    if (!assistant) throw new Error("Expected accepted question");
    const before = recovery();
    const publications = frames();
    await progress.beforeDurableCommand(execution.threadId);
    expect(() => progress.markPlanAnswered(execution.threadId, assistant.id)).toThrow("fenced");
    const operation: ExecutionSemanticOperation = { operationId: "live-lease:3", execution, lease, ordinal: 3,
      mutation: { kind: "append-events", phase: "running", nativeCursor: null,
        events: [draft("codex", 2, "textDelta", { delta: "Later", isFinalResponse: true })] } };
    expect(() => progress.accept(operation)).toThrow("fenced");
    progress.cancelDurableCommand(execution.threadId);
    const closing = progress.close();
    expect(() => progress.accept(operation)).toThrow("closed");
    expect(() => progress.markPlanAnswered(execution.threadId, assistant.id)).toThrow("closed");
    await expect(progress.beforeDurableCommand(execution.threadId)).rejects.toThrow("closed");
    await closing;
    expect(() => progress.accept(operation)).toThrow("closed");
    expect(recovery()).toEqual(before);
    expect(frames()).toEqual(publications);
  });

  it("accepts a Devin session cursor and empty native completion through the execution writer", async () => {
    // The legacy column mirrors a cursor only for the thread's own provider, so the thread must run on Devin.
    db.prepare("UPDATE threads SET provider = 'devin' WHERE id = ?").run(execution.threadId);
    await send(1, start("devin"));
    holdWrites();
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", 1, "system", { subtype: "sdk_session_id:devin-native-session" })] })).result.kind).toBe("accepted");
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", 2, "turnComplete")], terminalInput: { ...execution, providerId: "devin", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } })).result.kind).toBe("accepted");
    expect(recovery().retained.some((event) => event.payload.type === "turn.completed")).toBe(true);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Running" });
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    expect(db.prepare("SELECT sdk_session_id FROM threads WHERE id = ?").get(execution.threadId)).toEqual({ sdk_session_id: "devin-native-session" });
    expect(db.prepare("SELECT provider_id, session_id, last_seen_sequence FROM thread_provider_sessions WHERE thread_id = ?").all(execution.threadId))
      .toEqual([{ provider_id: "devin", session_id: "devin-native-session", last_seen_sequence: 0 }]);
  });

  it("accepts a generic full assistant message after narration and tools before the terminal event", async () => {
    await send(1, start("devin"));
    holdWrites();
    const events = [draft("devin", 1, "textDelta", { delta: "PREFIX" }),
      draft("devin", 2, "assistantMessageBoundary", { isFinalResponse: false }),
      draft("devin", 3, "toolUse", { toolCallId: "tool", toolName: "Read", toolInput: { file_path: "file.txt" } }),
      draft("devin", 4, "toolResult", { toolCallId: "tool", output: "Read", isError: false }),
      draft("devin", 5, "textDelta", { delta: "AFTER_TOOL", isFinalResponse: true }),
      draft("devin", 6, "textDelta", { delta: "COMPLETE", isFinalResponse: true }),
      draft("devin", 7, "message", { content: "AFTER_TOOLCOMPLETE", tokens: null })];
    for (const [index, event] of events.entries()) {
      const reply = await send(index + 2, { kind: "event", phase: "running", nativeCursor: null, events: [event] });
      expect(reply.result.kind, JSON.stringify({ index, result: reply.result })).toBe("accepted");
    }
    expect((await send(9, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", 8, "turnComplete")], terminalInput: { ...execution, providerId: "devin", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } })).result.kind).toBe("accepted");
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
  });

  it("keeps the acknowledged recovery base unchanged when page2 fails, then retries without duplicate reduction or insert", async () => {
    await send(1, start("codex"));
    db.run("CREATE TRIGGER fail_page2 BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.operation_id LIKE '%:page:1' BEGIN SELECT RAISE(ABORT, 'page2 unavailable'); END");
    const operation: ExecutionSemanticOperation = { operationId: "live-lease:2", execution, lease, ordinal: 2,
      livePublication: [{ after: "terminal", event: { type: "turnComplete", threadId: execution.threadId,
        turnExecutionId: execution.executionId, reason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0 } }],
      mutation: { kind: "finish-live-event", outcome: "completed", projection: { ...execution, outcome: "completed", endedAt: NOW,
        assistant: { content: "Answer", model: "fixture", attachments: [] }, narrative: Array.from({ length: 300 }, (_, i) => completedTool(i)) },
        input: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } } };
    const before = recovery();
    expect(progress.accept(operation).kind).toBe("accepted");
    await expect.poll(() => progress.savingStatuses(execution.threadId)[0]?.mode).toBe("saving-failed");
    const failed = recovery();
    expect(failed.savedThrough).toBe(0);
    expect(failed.durable).toEqual(before.durable);
    expect(failed.retained.length).toBeGreaterThan(256);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE envelope_json LIKE '%progressPosition%'").get()).toEqual({ count: 256 });
    db.run("DROP TRIGGER fail_page2");
    expect(progress.retry(execution.threadId)).toBe(true);
    await expect.poll(() => progress.depth().pending).toBe(0);
    const saved = recovery();
    expect(saved.retained).toHaveLength(0);
    expect(saved.savedThrough).toBe(failed.acceptedThrough);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE envelope_json LIKE '%progressPosition%'").get())
      .toEqual({ count: failed.retained.length });
  });

  it("leaves accepted state and recovery unchanged when retention rejects an admission after it validated", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Kept", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const finish: ExecutionSemanticOperation = { operationId: "live-lease:3", execution, lease, ordinal: 3,
      livePublication: [{ after: "terminal", event: { type: "turnComplete", threadId: execution.threadId,
        turnExecutionId: execution.executionId, reason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0 } }],
      mutation: { kind: "finish-live-event", outcome: "completed", projection: { ...execution, outcome: "completed", endedAt: NOW,
        assistant: { content: "Answer", model: "fixture", attachments: [] }, narrative: [completedTool(0)] },
        input: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } } };
    const before = recovery();
    vi.spyOn(BoundedProgressRetention.prototype, "reserve").mockReturnValueOnce(undefined);

    expect(() => progress.accept(finish)).toThrow(expect.objectContaining({ admissionReason: "retention-exhausted" }));

    expect(recovery()).toEqual(before);
    // A finish that leaked into accepted state would make the turn terminal and this a conflict.
    expect(progress.interruptWorkerLoss({ execution, lease, reason: "worker unavailable", recoveryIncidentId: "loss" }).kind)
      .toBe("accepted");
  });

  it("recovers the durable state its saved events reduce to, isolated from the object recover returns", async () => {
    const durableState = () => {
      const durable = recovery().durable;
      if (durable.mode !== "snapshot") throw new Error("Expected a durable snapshot");
      return durable.snapshot.state;
    };
    const savedEvents = (from: number) => pushes.frames.slice(from).map((frame) => CanonicalAgentProgressFrameSchema().parse(frame))
      .flatMap((frame) => frame.phase === "saved" && frame.threadId === execution.threadId ? [frame.events] : []);
    const reduceSaved = (base: AgentModelState, batches: readonly (readonly AcceptedCanonicalAgentEventEnvelope[])[]) =>
      batches.reduce((state, events) => {
        const reduction = reduceAgentEventBatch(state, events);
        if (reduction.outcome !== "applied") throw new Error(`Saved events rejected at ${reduction.eventId}`);
        return { ...reduction.state, appliedEventIds: {}, acceptedInputEventIds: {} };
      }, base);
    const stream = async (ordinal: number, sequence: number) => {
      await send(ordinal, { kind: "event", phase: "running", nativeCursor: null, events: [
        draft("codex", sequence, "toolUse", { toolCallId: `tool-${sequence}`, toolName: "Read", toolInput: { file_path: "file.txt" } })] });
      await send(ordinal + 1, { kind: "event", phase: "running", nativeCursor: null, events: [
        draft("codex", sequence + 1, "textDelta", { delta: `text ${sequence}`, isFinalResponse: true })] });
      await expect.poll(() => progress.depth().pending).toBe(0);
    };
    await send(1, start("codex"));
    await expect.poll(() => progress.depth().pending).toBe(0);
    const base = structuredClone(durableState());
    const savedFrom = pushes.frames.length;

    await stream(2, 1);
    expect(durableState()).toEqual(reduceSaved(base, savedEvents(savedFrom)));

    const handedOut = durableState();
    handedOut.items = {};
    for (const turnId of Object.keys(handedOut.turns)) delete handedOut.turns[turnId];
    await stream(4, 3);

    expect(durableState()).toEqual(reduceSaved(base, savedEvents(savedFrom)));
    expect(Object.keys(durableState().items)).not.toHaveLength(0);
  });

  it("releases each turn's owner on a long thread once its worker releases and reconnects with full history", async () => {
    const turnIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const identity = { ...execution, turnId: `history-turn-${index}`,
        executionId: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}` };
      const activeLease = { ...lease, leaseId: `history-lease-${index}` };
      turnIds.push(identity.turnId);
      await send(1, start("codex", identity), identity, activeLease);
      expect(progress.depth().owners).toBe(1);
      holdWrites();
      await send(2, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("codex", 1, "textDelta", { delta: `Answer ${index}`, isFinalResponse: true }, identity)] }, identity, activeLease);
      await send(3, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("codex", 2, "turnComplete", {}, identity)], terminalInput: { ...identity, providerId: "codex",
          providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } }, identity, activeLease);
      const unsaved = recovery();
      expect(unsaved.retained.some((event) => event.payload.type === "turn.completed")).toBe(true);
      release?.();
      await expect.poll(() => progress.depth().pending).toBe(0);
      expect(progress.depth().owners).toBe(1);
      const restored = progress.recover(identity.threadId, { conversationRevision: 0, rosterRevision: 0 },
        { epoch: unsaved.epoch, sequence: unsaved.acceptedThrough });
      expect(restored.loss).toBe("none");
      expect(restored.savedThrough).toBe(unsaved.acceptedThrough);
      expect(restored.retained).toEqual([]);
      if (restored.durable.mode !== "snapshot") throw new Error("Expected full durable history");
      expect(Object.keys(restored.durable.snapshot.state.turns).sort()).toEqual([...turnIds].sort());
      expect(Object.values(restored.durable.snapshot.state.items).filter((item) => item.payload.projection === "message"
        && item.payload.message && typeof item.payload.message === "object" && "role" in item.payload.message
        && item.payload.message.role === "assistant")).toHaveLength(index + 1);
      await send(4, { kind: "release" }, identity, activeLease);
      expect(progress.depth()).toMatchObject({ owners: 0, ownedTurns: 0 });
      vi.mocked(writer.appendAccepted).mockRestore();
    }
  });

  it("accepts a post-terminal event after the terminal save until the worker releases the execution", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Answer", isFinalResponse: true })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 2, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });

    const late = await send(4, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 3, "ended", { outcome: "completed" })] });
    expect(late.result.kind).toBe("accepted");
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT count(*) AS count FROM canonical_agent_items WHERE id = ?")
      .get(`${execution.executionId}:raw:3`)).toEqual({ count: 1 });
    expect(progress.depth().owners).toBe(1);
    expect((await send(5, { kind: "release" })).result.kind).toBe("released");
    expect(progress.depth().owners).toBe(0);
  });

  it("starts a ninth thread while eight finished turns wait for release, and keeps their owners until release", async () => {
    const finished = Array.from({ length: 8 }, (_, index) => ({
      identity: { threadId: `finished-thread-${index}`, turnId: `finished-turn-${index}`,
        executionId: `00000000-0000-4000-8000-${String(index + 2000).padStart(12, "0")}` },
      lease: { ...lease, leaseId: `finished-lease-${index}` } }));
    for (const turn of finished) {
      insertThread(turn.identity.threadId);
      await send(1, start("codex", turn.identity), turn.identity, turn.lease);
      await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 1, "turnComplete", {}, turn.identity)],
        terminalInput: { ...turn.identity, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } },
      turn.identity, turn.lease);
    }
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(progress.depth().owners).toBe(8);

    expect((await send(1, start("codex"))).result.kind).toBe("committed");
    expect(progress.depth().owners).toBe(9);

    for (const turn of finished) {
      const late = await send(3, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("codex", 2, "ended", { outcome: "completed" }, turn.identity)] }, turn.identity, turn.lease);
      expect(late.result.kind).toBe("accepted");
    }
    await expect.poll(() => progress.depth().pending).toBe(0);
    for (const turn of finished) expect((await send(4, { kind: "release" }, turn.identity, turn.lease)).result.kind).toBe("released");
    expect(progress.depth().owners).toBe(1);
  });

  it("caps owners that no execution will release at the owner limit", async () => {
    for (let index = 0; index < 12; index += 1) {
      const threadId = `command-thread-${index}`;
      insertThread(threadId);
      await progress.beforeDurableCommand(threadId);
      progress.cancelDurableCommand(threadId);
    }
    expect(progress.depth().owners).toBe(8);
  });

  it("keeps owners at the hard ceiling when 40 saved terminals never get their release, without evicting a running turn", async () => {
    const turnOf = (index: number) => ({
      identity: { threadId: `unreleased-thread-${index}`, turnId: `unreleased-turn-${index}`,
        executionId: `00000000-0000-4000-8000-${String(index + 3000).padStart(12, "0")}` },
      lease: { ...lease, leaseId: `unreleased-lease-${index}` } });
    const running = turnOf(0);
    insertThread(running.identity.threadId);
    await send(1, start("codex", running.identity), running.identity, running.lease);
    for (let index = 1; index <= 40; index += 1) {
      const turn = turnOf(index);
      insertThread(turn.identity.threadId);
      await send(1, start("codex", turn.identity), turn.identity, turn.lease);
      await send(2, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 1, "turnComplete", {}, turn.identity)],
        terminalInput: { ...turn.identity, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } },
      turn.identity, turn.lease);
      await expect.poll(() => progress.depth().pending).toBe(0);
    }

    expect((await send(1, start("codex"))).result.kind).toBe("committed");
    expect(progress.depth().owners).toBeLessThanOrEqual(32);
    const stillRunning = await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "still here", isFinalResponse: true }, running.identity)] },
    running.identity, running.lease);
    expect(stillRunning.result.kind).toBe("accepted");
  });

  describe("when a start's reply is lost after its begin is saved", () => {
    function loseNextBeginReply() {
      const transact = writer.transactSemantic.bind(writer);
      vi.spyOn(writer, "transactSemantic").mockImplementationOnce(async (...args) => {
        await transact(...args);
        throw new Error("reply lost after durable begin");
      });
    }
    const turnStatus = () => db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId);

    it("interrupts and releases twelve such starts once their leases are abandoned", async () => {
      const failed = Array.from({ length: 12 }, (_, index) => ({
        identity: { threadId: `failed-start-thread-${index}`, turnId: `failed-start-turn-${index}`,
          executionId: `00000000-0000-4000-8000-${String(index + 4000).padStart(12, "0")}` },
        lease: { ...lease, leaseId: `failed-start-lease-${index}` } }));
      for (const turn of failed) {
        insertThread(turn.identity.threadId);
        loseNextBeginReply();
        await expect(send(1, start("codex", turn.identity), turn.identity, turn.lease)).rejects.toThrow("reply lost after durable begin");
        await port.abandonStart(turn.identity, turn.lease);
      }

      await expect.poll(() => progress.depth().owners).toBe(0);
      for (const turn of failed) {
        expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(turn.identity.turnId)).toEqual({ status: "Interrupted" });
      }
      const next = { ...execution, turnId: "after-failed-begin", executionId: "00000000-0000-4000-8000-000000000301" };
      const nextLease = { ...lease, ownerEpoch: 2, leaseId: "after-failed-begin-lease" };
      expect((await send(1, start("codex", next), next, nextLease)).result.kind).toBe("committed");
    });

    it("keeps the turn saving when that exact start is retried", async () => {
      loseNextBeginReply();
      await expect(send(1, start("codex"))).rejects.toThrow("reply lost after durable begin");

      expect((await send(1, start("codex"))).result.kind).toBe("committed");
      const text = await send(2, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("codex", 1, "textDelta", { delta: "after retry", isFinalResponse: true })] });
      expect(text.result.kind).toBe("accepted");
      await expect.poll(() => progress.depth().pending).toBe(0);
      expect(turnStatus()).toEqual({ status: "Running" });
    });

    it("keeps a running turn when a duplicate start for it loses its reply", async () => {
      expect((await send(1, start("codex"))).result.kind).toBe("committed");
      loseNextBeginReply();
      const duplicate = new ExecutionWorkerHandler(port);
      await expect(duplicate.handle({ requestId: 1, execution, lease, ordinal: 1, command: start("codex") }))
        .rejects.toThrow("reply lost after durable begin");

      await progress.waitForSaved(execution.threadId);
      expect(turnStatus()).toEqual({ status: "Running" });
      const text = await send(2, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("codex", 1, "textDelta", { delta: "still live", isFinalResponse: true })] });
      expect(text.result.kind).toBe("accepted");
      await progress.waitForSaved(execution.threadId);
      expect(turnStatus()).toEqual({ status: "Running" });
    });
  });

  describe("after a released turn", () => {
    const retry = { ...execution, turnId: "retry-turn", executionId: "00000000-0000-4000-8000-000000000127" };
    const retryLease = { ...lease, ownerEpoch: 2, leaseId: "retry-lease" };

    async function finishReleasedTurn(answer?: string) {
      await send(1, start("codex"));
      let ordinal = 2;
      if (answer) {
        expect((await send(ordinal++, { kind: "event", phase: "running", nativeCursor: null,
          events: [draft("codex", 1, "textDelta", { delta: answer, isFinalResponse: true })] })).result.kind).toBe("accepted");
      }
      expect((await send(ordinal++, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", ordinal - 1, "turnComplete")],
        terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } }))
        .result.kind).toBe("accepted");
      await expect.poll(() => progress.depth().pending).toBe(0);
      await send(ordinal, { kind: "release" });
      expect(progress.depth().owners).toBe(0);
    }

    function startReusingPrompt() {
      const fresh = start("codex", retry);
      return send(1, { ...fresh, parentLive: { ...fresh.parentLive, precedingMessageId: `${execution.turnId}:user` },
        input: { ...fresh.input, userMessage: { kind: "existing", messageId: `${execution.turnId}:user` } } }, retry, retryLease);
    }

    it("starts a retry that reuses the user message of the finished turn", async () => {
      await finishReleasedTurn();
      expect((await startReusingPrompt()).result.kind).toBe("committed");
      await send(2, { kind: "event", phase: "running", nativeCursor: null,
        events: [draft("codex", 1, "textDelta", { delta: "Fresh answer", isFinalResponse: true }, retry)] }, retry, retryLease);
      await send(3, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 2, "turnComplete", {}, retry)],
        terminalInput: { ...retry, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } }, retry, retryLease);
      await expect.poll(() => progress.depth().pending).toBe(0);
      expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(retry.turnId)).toEqual({ status: "Completed" });
      expect(db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY sequence DESC")
        .get(execution.threadId)).toEqual({ content: "Fresh answer" });
    });

    it("attaches a late hook to the finished turn's answer while a retry reuses its prompt", async () => {
      await finishReleasedTurn("Earlier answer");
      expect((await startReusingPrompt()).result.kind).toBe("committed");
      progress.acceptLateHook(execution.threadId, execution.executionId, { id: "late-hook", hookName: "Stop", toolName: null,
        phase: "stop", payload: "{}", durationMs: 10, didBlock: false, startedAt: NOW, endedAt: NOW, sortOrder: 1 });
      await expect.poll(() => progress.depth().pending).toBe(0);
      const answer = db.prepare("SELECT id FROM messages WHERE thread_id = ? AND role = 'assistant' AND content = 'Earlier answer'")
        .get(execution.threadId);
      expect(db.prepare("SELECT message_id FROM hook_executions WHERE id = 'late-hook'").get())
        .toEqual({ message_id: (answer as { id: string }).id });
    });
  });

  describe("after an earlier turn ran a subagent", () => {
    const evidence = { nativeThreadId: "native-child", nativeTurnId: "native-turn", parentCollaborationItemId: "spawn" };
    const childMessage = { child: { ...evidence, nativeItemId: "child-message", itemEventKey: "delta" } };
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000126" };
    const nextLease = { ...lease, ownerEpoch: 2, leaseId: "next-lease" };
    const event = (events: ReturnType<typeof draft>[]) => ({ kind: "event", phase: "running", nativeCursor: null, events }) as const;

    async function finishSubagentTurn() {
      await send(1, start("codex"));
      await send(2, event([familyDraft(1, "toolUse", { toolCallId: "spawn", toolName: "Agent", toolInput: {} },
        { collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-child"], prompt: "Child task" } })]));
      await send(3, event([familyDraft(2, "turnStarted", {}, { child: evidence })]));
      await send(4, event([familyDraft(3, "textDelta", { delta: "Child answer" }, childMessage)]));
      await send(5, event([familyDraft(4, "turnComplete", {}, { child: evidence })]));
      await send(6, event([draft("codex", 5, "toolResult", { toolCallId: "spawn", output: "Child answer", isError: false })]));
      await send(7, event([draft("codex", 6, "textDelta", { delta: "Parent answer one", isFinalResponse: true })]));
      await send(8, { ...event([draft("codex", 7, "turnComplete")]),
        terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
      await expect.poll(() => progress.depth().pending).toBe(0);
      await send(9, { kind: "release" });
      expect(progress.depth().owners).toBe(0);
    }

    it("recovers every saved item mid-turn", async () => {
      await finishSubagentTurn();
      const saved = new CanonicalAgentStore(db, () => {}).recoverThread(execution.threadId,
        { conversationRevision: Number.MAX_SAFE_INTEGER, rosterRevision: Number.MAX_SAFE_INTEGER });
      if (saved.mode !== "snapshot") throw new Error("Expected saved history");
      const savedItems = Object.keys(saved.snapshot.state.items);
      expect(savedItems.length).toBeGreaterThan(1);

      await send(1, start("codex", next), next, nextLease);
      await expect.poll(() => progress.depth().pending).toBe(0);
      expect(progress.depth().owners).toBe(1);
      const restored = recovery(next);
      if (restored.durable.mode !== "snapshot") throw new Error("Expected recovery snapshot");
      const restoredItems = restored.durable.snapshot.state.items;
      expect(savedItems.filter((id) => !(id in restoredItems))).toEqual([]);
    });

    it("accepts an identical replay of the saved child message during a later parent turn", async () => {
      await finishSubagentTurn();
      await send(1, start("codex", next), next, nextLease);
      const replayed = familyDraft(1, "textDelta", { delta: "Child answer" }, childMessage, next);
      expect((await send(2, event([replayed]), next, nextLease)).result.kind).toBe("accepted");
      await expect.poll(() => progress.depth().pending).toBe(0);
      expect(db.prepare("SELECT count(*) AS count FROM canonical_agent_items WHERE id = ?").get(replayed.eventId)).toEqual({ count: 1 });
      // A rejected replay would save an action-required child routing failure on the later turn.
      expect(db.prepare("SELECT count(*) AS count FROM canonical_agent_items WHERE turn_id = ? AND kind = 'error'")
        .get(next.turnId)).toEqual({ count: 0 });
    });
  });

  it("does not allocate live owners for completed history or report loss after same-runtime saved rehydration", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Saved running turn", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const running = recovery();
    for (let i = 0; i < 12; i += 1) {
      const threadId = `history-${i}`;
      insertThread(threadId);
      const history = progress.recover(threadId, { conversationRevision: 0, rosterRevision: 0 });
      expect(history.retained).toHaveLength(0);
    }
    const restored = progress.recover(execution.threadId, { conversationRevision: 0, rosterRevision: 0 },
      { epoch: running.epoch, sequence: running.acceptedThrough });
    expect(restored.loss).toBe("none");
    expect(restored.epoch).toBe(running.epoch);
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "textDelta", { delta: "More", isFinalResponse: true })] })).result.kind).toBe("accepted");
    await expect.poll(() => progress.depth().pending).toBe(0);
  });

  it("accepts an exact worker-loss interruption and releases the worker while its text is still unsaved", async () => {
    await send(1, start("devin"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", 1, "textDelta", { delta: "Retained answer", isFinalResponse: true })] });
    const interrupted = progress.interruptWorkerLoss({ execution, lease, reason: "worker unavailable", recoveryIncidentId: "loss" });
    expect(interrupted.kind).toBe("accepted");
    expect((await send(3, { kind: "release", recovery: interrupted })).result.kind).toBe("released");
    const cut = recovery();
    expect(cut.retained.some((event) => event.payload.type === "turn.interrupted")).toBe(true);
    expect(cut.retained.some((event) => acceptedMessage(event)?.content === "Retained answer")).toBe(true);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Running" });
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Interrupted" });
    expect(pushes.turns.filter((push) => push.channel === "thread.status")).toEqual([
      { channel: "thread.status", data: { threadId: execution.threadId, status: "interrupted" } }]);
  });

  it("publishes the finished turn's status and persistence once, only after its terminal batch is saved", async () => {
    await send(1, start("devin"));
    holdWrites();
    const events = [draft("devin", 1, "toolUse", { toolCallId: "tool", toolName: "Read", toolInput: { file_path: "file.txt" } }),
      draft("devin", 2, "toolResult", { toolCallId: "tool", output: "Read", isError: false }),
      draft("devin", 3, "textDelta", { delta: "DONE", isFinalResponse: true })];
    for (const [index, event] of events.entries()) {
      expect((await send(index + 2, { kind: "event", phase: "running", nativeCursor: null, events: [event] })).result.kind).toBe("accepted");
    }
    expect((await send(5, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", 4, "turnComplete")], terminalInput: { ...execution, providerId: "devin", providerIdentities: [],
        outcome: "completed", projection: { kind: "writer-staged" } } })).result.kind).toBe("accepted");
    expect(pushes.turns).toEqual([]);
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    const saved = new CanonicalAgentStore(db, () => {}).loadTerminalProjection(execution.turnId).message;
    if (!saved) throw new Error("Expected saved assistant response");
    expect(pushes.turns).toEqual([
      { channel: "thread.status", data: { threadId: execution.threadId, status: "completed" } },
      { channel: "turn.persisted", data: { threadId: execution.threadId, turnId: execution.turnId, executionId: execution.executionId,
        messageId: saved.id, settledMessage: { id: saved.id, sequence: saved.sequence }, toolCallCount: 1, filesChanged: [],
        outcome: "completed" } },
    ]);
  });

  it("waits for accepted save capacity instead of rejecting a long provider stream", async () => {
    await send(1, start("codex"));
    holdWrites();
    const toolOutput = "export const example = 'fixture source';\n".repeat(800);
    let blocked: Promise<Awaited<ReturnType<typeof send>>> | undefined;
    let blockedOrdinal = 0;
    for (let ordinal = 2; ordinal < 2_500; ordinal += 1) {
      const index = ordinal - 2;
      const pair = Math.floor(index / 2);
      const toolCallId = `tool-${pair}`;
      const event = index % 2 === 0
        ? draft("codex", index + 1, "toolUse", { toolCallId, toolName: "Read", toolInput: { file_path: "file.txt" } })
        : draft("codex", index + 1, "toolResult", { toolCallId, output: toolOutput, isError: false });
      const pending = send(ordinal, { kind: "event", phase: "running", nativeCursor: null, events: [event] });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([pending.then(() => true, () => true),
        new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), 500); })]);
      if (deadline) clearTimeout(deadline);
      if (!settled) {
        blocked = pending;
        blockedOrdinal = ordinal;
        break;
      }
      const reply = await pending;
      expect(reply.result.kind, JSON.stringify(reply.result)).toBe("accepted");
    }
    if (!blocked) throw new Error("Expected retained accepted progress to fill before ordinal 2500");
    expect(progress.depth().retained.bytes).toBeGreaterThan(7 * 1024 * 1024);
    release?.();
    await expect(blocked).resolves.toMatchObject({ result: { kind: "accepted" } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const terminal = await send(blockedOrdinal + 1, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 10_000, "turnComplete")], terminalInput: { ...execution, providerId: "codex",
        providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    expect(terminal.result.kind).toBe("accepted");
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
  }, 30_000);

  it("replaces a batch whose live publication the writer rejects, so the turn end still saves", async () => {
    await send(1, start("codex"));
    const oversized = "x".repeat(300 * 1024);
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: oversized, isFinalResponse: true })] })).result.kind).toBe("accepted");
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "turnComplete")], terminalInput: { ...execution, providerId: "codex",
        providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } })).result.kind).toBe("accepted");
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    expect(progress.savingStatuses(execution.threadId)).toEqual([]);
    await expect(progress.waitForSaved(execution.threadId)).resolves.toBeUndefined();
    const markers = db.prepare("SELECT envelope_json FROM canonical_agent_events WHERE envelope_json LIKE '%ingest.content-replaced%'").all() as { envelope_json: string }[];
    expect(markers.map((row) => JSON.parse(row.envelope_json).payload)).toEqual([
      { type: "ingest.content-replaced", operationId: "live-lease:2", reason: expect.any(String) },
    ]);
  });

  it("reports a permanent save failure while the provider continues and retries its retained completion", async () => {
    await send(1, start("codex"));
    const previousPublicationHead = db.prepare("SELECT last_sequence FROM canonical_writer_live_publication_heads WHERE thread_id = ?")
      .get(execution.threadId);
    db.run("CREATE TRIGGER fail_progress BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.operation_id = 'live-lease:2' BEGIN SELECT RAISE(ABORT, 'disk checkpoint unavailable'); END");
    const failures: string[] = [];
    progress.bindPermanentFailure(async (failed, error) => {
      failures.push(`${failed.executionId}:${error.message}`);
      progress.interruptWorkerLoss({ execution: failed, lease, reason: error.message, recoveryIncidentId: "save-failure" });
    });
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Before failed save", isFinalResponse: true })] });
    await expect.poll(() => progress.savingStatuses(execution.threadId)[0]?.mode).toBe("saving-failed");
    expect(db.prepare("SELECT last_sequence FROM canonical_writer_live_publication_heads WHERE thread_id = ?").get(execution.threadId))
      .toEqual(previousPublicationHead);
    expect(failures).toEqual([]);
    await expect(progress.beforeDurableCommand(execution.threadId)).rejects.toThrow("disk checkpoint unavailable");
    vi.spyOn(progress, "accept").mockImplementationOnce(() => { throw new ProgressAdmissionError("retention-exhausted"); });
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "toolUse", { toolCallId: "blocked-tool", toolName: "Read", toolInput: {} })] })).result)
      .toMatchObject({ kind: "dropped", reason: "acceptance-rejected" });
    expect((await send(4, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 3, "textDelta", { delta: " and after failed save", isFinalResponse: true })] })).result.kind).toBe("accepted");
    expect((await send(5, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 4, "turnComplete")], terminalInput: { ...execution, providerId: "codex",
        providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } })).result.kind).toBe("accepted");
    expect(recovery().retained.some((event) => event.payload.type === "turn.interrupted")).toBe(false);
    db.run("DROP TRIGGER fail_progress");
    expect(progress.retry(execution.threadId)).toBe(true);
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    expect(db.prepare("SELECT content FROM messages WHERE role = 'assistant' AND is_internal = 0").all())
      .toEqual([{ content: "Before failed save and after failed save" }]);
    expect(failures).toEqual([]);
  });

  it("keeps both providers running after a notice save failure and retries the original notice ID", async () => {
    await send(1, start("codex"));
    const other = { threadId: "devin-thread", turnId: "devin-turn", executionId: "00000000-0000-4000-8000-000000000155" };
    const otherLease = { ...lease, workerIndex: 1, leaseId: "devin-lease" };
    insertThread(other.threadId);
    await send(1, start("devin", other), other, otherLease);
    db.run("CREATE TRIGGER fail_notice BEFORE INSERT ON messages WHEN NEW.role = 'system' AND NEW.content = 'Session save fails' BEGIN SELECT RAISE(ABORT, 'notice storage unavailable'); END");
    const affected: string[] = [];
    progress.bindPermanentFailure(async (failed, error) => {
      affected.push(failed.executionId);
      progress.interruptWorkerLoss({ execution: failed, lease, reason: error.message, recoveryIncidentId: "notice-save-failure" });
    });
    const notice = progress.acceptThreadSystemObservation({ type: "system", threadId: execution.threadId,
      subtype: "provider.notice.warning", message: "Session save fails",
      systemNotice: { kind: "diagnostic", presentation: "timeline", scope: "session", sessionId: "session" } });
    expect(notice.turnExecutionId).toBeUndefined();
    expect(notice.messageId).toBeDefined();
    await expect.poll(() => progress.savingStatuses(execution.threadId).find((status) => status.executionId === execution.executionId)?.mode).toBe("saving-failed");
    expect(affected).toEqual([]);
    expect(progress.savingStatuses(execution.threadId).find((status) => status.executionId === execution.executionId)?.mode).toBe("saving-failed");
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get(notice.messageId!)).toBeNull();
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Affected provider continues", isFinalResponse: true })] })).result.kind).toBe("accepted");
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "turnComplete")], terminalInput: { ...execution, providerId: "codex",
        providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } })).result.kind).toBe("accepted");
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", 1, "textDelta", { delta: "Other provider continues", isFinalResponse: true }, other)] }, other, otherLease)).result.kind).toBe("accepted");
    expect((await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("devin", 2, "turnComplete", {}, other)], terminalInput: { ...other, providerId: "devin",
        providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } }, other, otherLease)).result.kind).toBe("accepted");
    await expect.poll(() => db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(other.turnId))
      .toEqual({ status: "Completed" });
    const retained = recovery().retained.filter((event) => acceptedMessage(event)?.id === notice.messageId);
    expect(retained).toHaveLength(1);
    db.run("DROP TRIGGER fail_notice");
    expect(progress.retry(execution.threadId)).toBe(true);
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT id, content FROM messages WHERE id = ?").all(notice.messageId!))
      .toEqual([{ id: notice.messageId, content: "Session save fails" }]);
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(other.turnId)).toEqual({ status: "Completed" });
    expect(db.prepare("SELECT status FROM canonical_agent_turns WHERE id = ?").get(execution.turnId)).toEqual({ status: "Completed" });
    expect(recovery().retained.some((event) => event.payload.type === "turn.interrupted")).toBe(false);
    expect(affected).toEqual([]);
  });

  it("rejects headless thread notices without writing a main-connection message", () => {
    expect(() => progress.acceptThreadSystemObservation({ type: "system", threadId: execution.threadId,
      subtype: "provider.notice.warning", message: "No canonical turn" })).toThrow("existing canonical turn");
    expect(db.prepare("SELECT id FROM messages WHERE thread_id = ?").all(execution.threadId)).toEqual([]);
    expect(progress.depth().pending).toBe(0);
  });

  it("accepts notice deduplication and session expiry before saving without consuming a provider ordinal", async () => {
    await send(1, start("codex"));
    holdWrites();
    progress.acceptThreadSystemObservation({ type: "system", threadId: execution.threadId,
      subtype: "provider.session.started", systemNotice: { kind: "diagnostic", presentation: "timeline", scope: "session", sessionId: "old" } });
    const warning = { type: "system" as const, threadId: execution.threadId, subtype: "provider.notice.warning", message: "First warning",
      systemNotice: { kind: "diagnostic" as const, presentation: "timeline" as const, scope: "session" as const, sessionId: "old", noticeKey: "warning" } };
    const first = progress.acceptThreadSystemObservation(warning);
    const update = progress.acceptThreadSystemObservation({ ...warning, turnExecutionId: execution.executionId, message: "Updated warning" });
    expect(update.messageId).toBe(first.messageId);
    progress.acceptThreadSystemObservation({ type: "system", threadId: execution.threadId,
      subtype: "provider.session.started", systemNotice: { kind: "diagnostic", presentation: "timeline", scope: "session", sessionId: "new" } });
    const next = progress.acceptThreadSystemObservation({ ...warning, message: "Next session warning", systemNotice: { ...warning.systemNotice, sessionId: "new" } });
    expect(next.messageId).not.toBe(first.messageId);
    expect(db.prepare("SELECT id FROM messages WHERE role = 'system'").all()).toEqual([]);
    expect(recovery().retained.some((event) => event.payload.type === "item.recorded"
      && event.payload.item.payload.projection === "noticeStatus"
      && z.array(z.string()).parse(event.payload.item.payload.expiredNoticeMessageIds).includes(first.messageId!))).toBe(true);
    expect((await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Provider continues", isFinalResponse: true })] })).result.kind).toBe("accepted");
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT id, content FROM messages WHERE role = 'system'").all())
      .toEqual([{ id: next.messageId, content: "Next session warning" }]);
    expect(db.prepare("SELECT current_notice_session_id FROM threads WHERE id = ?").get(execution.threadId))
      .toEqual({ current_notice_session_id: "new" });
    const restarted = new CanonicalAcceptedProgress(new MainCanonicalAgentBoundary(reader, databaseWriter, writer, () => {}), writer);
    try {
      const restored = restarted.acceptThreadSystemObservation({ type: "system", threadId: execution.threadId,
        subtype: "provider.notice.warning", message: "After restart" });
      expect(restored.turnExecutionId).toBeUndefined();
      expect(restarted.recover(execution.threadId, { conversationRevision: 0, rosterRevision: 0 }).retained
        .every((event) => event.routing.executionId === execution.executionId)).toBe(true);
      await expect.poll(() => restarted.depth().pending).toBe(0);
      expect(db.prepare("SELECT id FROM messages WHERE id = ?").get(restored.messageId!)).toEqual({ id: restored.messageId });
    } finally {
      await restarted.close();
    }
  });

  it("rejects durable command waiters after receipt processing fails without replaying the committed disk write", async () => {
    await send(1, start("codex"));
    const heldAppend = holdWrites();
    vi.spyOn(writer, "appendAccepted").mockImplementation(async (...args) => {
      const saved = await heldAppend(...args);
      return { ...saved, receipt: { ...saved.receipt, contentHash: "0".repeat(64) } };
    });
    const failures: string[] = [];
    progress.bindPermanentFailure(async (failed, error) => { failures.push(`${failed.executionId}:${error.message}`); });
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Committed on disk", isFinalResponse: true })] });
    const waiter = progress.beforeDurableCommand(execution.threadId);
    const rejected = expect(waiter).rejects.toThrow("Saved receipt does not match");
    release?.();
    await rejected;
    await expect.poll(() => failures.length).toBe(1);
    expect(recovery().savedThrough).toBe(0);
    const count = db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE envelope_json LIKE '%progressPosition%'").get();
    expect(count).not.toEqual({ count: 0 });
    vi.restoreAllMocks();
    expect(progress.retry(execution.threadId)).toBe(true);
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_events WHERE envelope_json LIKE '%progressPosition%'").get()).toEqual(count);
    expect(recovery().retained).toHaveLength(0);
  });

  it("keeps an unsaved plan answer identity internal and publishes the complete terminal body with the same ID", async () => {
    await send(1, start("codex"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Question", isFinalResponse: true })] });
    const question = progress.latestAssistantMessage(execution.threadId);
    expect(question?.content).toBe("Question");
    if (!question) throw new Error("Accepted question must have a stable assistant identity");
    expect(progress.markPlanAnswered(execution.threadId, question.id)).toBe(true);
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get(question.id)).toBeNull();
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT content, is_internal, provider FROM messages WHERE id = ?").get(question.id)).toEqual({ content: "Question", is_internal: 1, provider: "codex" });
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "textDelta", { delta: " answered", isFinalResponse: true })] });
    await send(4, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 3, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(db.prepare("SELECT content, is_internal FROM messages WHERE id = ?").get(question.id)).toEqual({ content: "Question answered", is_internal: 0 });
  });

  it("certifies saved old generations across restart and reports only an actual missing accepted suffix", async () => {
    await send(1, start("codex"));
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "Saved prefix", isFinalResponse: true })] });
    await expect.poll(() => progress.depth().pending).toBe(0);
    const saved = recovery();
    const restarted = new CanonicalAcceptedProgress(new MainCanonicalAgentBoundary(reader, databaseWriter, writer, () => {}), writer);
    expect(restarted.recover(execution.threadId, { conversationRevision: 0, rosterRevision: 0 },
      { epoch: saved.epoch, sequence: saved.acceptedThrough }).loss).toBe("none");
    holdWrites();
    await send(3, { kind: "event", phase: "running", nativeCursor: null, events: [draft("codex", 2, "turnComplete")],
      terminalInput: { ...execution, providerId: "codex", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    const unsaved = recovery();
    expect(restarted.recover(execution.threadId, { conversationRevision: 0, rosterRevision: 0 },
      { epoch: unsaved.epoch, sequence: unsaved.acceptedThrough }).loss).toBe("runtime-restarted");
    release?.();
    await expect.poll(() => progress.depth().pending).toBe(0);
    await send(4, { kind: "release" });
    const next = { ...execution, turnId: "next-turn", executionId: "00000000-0000-4000-8000-000000000125" };
    await send(1, start("codex", next), next, { ...lease, leaseId: "next-lease" });
    expect(restarted.recover(execution.threadId, { conversationRevision: 0, rosterRevision: 0 },
      { epoch: unsaved.epoch, sequence: unsaved.acceptedThrough }).loss).toBe("none");
    await restarted.close();
  });

  it("rejects existing durable command waiters on close and still writes the queued suffix", async () => {
    await send(1, start("codex"));
    holdWrites();
    await send(2, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 1, "textDelta", { delta: "First", isFinalResponse: true })] });
    await send(3, { kind: "event", phase: "running", nativeCursor: null,
      events: [draft("codex", 2, "textDelta", { delta: "Second", isFinalResponse: true })] });
    const waiting = progress.beforeDurableCommand(execution.threadId);
    const rejected = expect(waiting).rejects.toThrow("closing");
    const closing = progress.close();
    await rejected;
    release?.();
    await closing;
    // The queued suffix is already on screen, so close writes it instead of dropping it.
    expect(progress.depth().pending).toBe(0);
    expect(recovery().retained.some((event) => event.eventId === `${execution.executionId}:raw:2`)).toBe(false);
    expect(writer.appendAccepted).toHaveBeenCalledTimes(2);
  });
});
