import "reflect-metadata";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentModelState, type AgentThread, type AgentTurn } from "@mcode/contracts/compat/agent-model";
import { MessageSchema } from "@mcode/contracts/models/message";
import { ProviderRuntimeEventSchema, providerRuntimeEvent, type ChildThreadEvidence } from "@mcode/contracts/events/provider-runtime-event";
import { SUBAGENT_REPORTING } from "@mcode/contracts/providers/interfaces";
import { type AgentEvent } from "@mcode/contracts/events/agent-event";
import { loadProviderFixtureManifest } from "../../../../../../../packages/providers/src/conformance/fixture-safety.js";
import { mapCopilotEvent, type CopilotMappedEvent, type CopilotTurnState } from "../../../../../../../packages/providers/src/private/copilot/copilot-event-mapper.js";
import { AcceptedCodexCollaboration } from "../accepted-codex-collaboration.js";
import { CanonicalAcceptedProgress } from "../canonical-accepted-progress.js";
import { CanonicalAgentBoundary } from "../canonical-agent-boundary.js";
import { CanonicalAgentStore } from "../canonical-agent-store.js";
import { CanonicalAgentWriterClient } from "../canonical-agent-writer-client.js";
import { CanonicalExecutionWriterPort } from "../canonical-execution-writer-port.js";
import { ExecutionWorkerHandler, type ExecutionWorkCommand } from "../../execution/execution-worker-handler.js";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";

const NOW = "2026-10-13T10:00:00.000Z";
const execution = { threadId: "parent", turnId: "parent-turn", executionId: "00000000-0000-4000-8000-000000000001" };
const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "copilot-lease" };
type NativeEvent = Parameters<typeof mapCopilotEvent>[0];

function turnState(): CopilotTurnState {
  return { turnExecutionId: execution.executionId, invocations: new Map(), tools: new Map(), nativeIdleObserved: false,
    tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, pendingPermissions: new Map(), completed: Promise.resolve(), settle: () => {} };
}

function capturedTrace(): NativeEvent[] {
  const fixture = loadProviderFixtureManifest(NodePath.resolve(import.meta.dirname,
    "../../../../../../../packages/providers/src/conformance/fixtures/copilot-core.captured.json"));
  const events = fixture.input.copilotNativeEvents;
  if (!events) throw new Error("Captured Copilot events are missing");
  const selected = events.filter((event) => ["EVENT_7", "EVENT_10", "EVENT_12", "EVENT_13", "EVENT_14"].includes(event.id));
  const metadata = { parentId: "EVENT_10", timestamp: NOW };
  selected.splice(2, 0,
    { ...metadata, id: "SYNTHETIC_TOOL_START", type: "tool.execution_start", data: { toolCallId: "CHILD_READ", toolName: "Read", arguments: { path: "README.md" }, parentToolCallId: "TOOL_6" } },
    { ...metadata, id: "SYNTHETIC_TOOL_RESULT", type: "tool.execution_complete", data: { toolCallId: "CHILD_READ", success: true, result: { content: "File contents" }, parentToolCallId: "TOOL_6" } });
  return selected;
}

// Event order transcribed from a live CLI 1.0.25 run where a background sub-agent started its own sub-agent.
function nestedLiveTrace(): NativeEvent[] {
  let index = 0;
  const meta = () => ({ id: `EVENT_${index++}`, parentId: null, timestamp: NOW });
  const outer = { parentToolCallId: "OUTER" };
  const inner = { parentToolCallId: "INNER" };
  const agent = { agentName: "general-purpose", agentDisplayName: "General Purpose Agent" };
  return [
    { ...meta(), type: "tool.execution_start", data: { toolCallId: "OUTER", toolName: "task", arguments: { description: "Delegate", mode: "background" } } },
    { ...meta(), type: "subagent.started", data: { toolCallId: "OUTER", ...agent, agentDescription: "OUTER_PROMPT" } },
    { ...meta(), type: "tool.execution_complete", data: { toolCallId: "OUTER", success: true, result: { content: "Agent started in background" } } },
    { ...meta(), type: "assistant.message", data: { messageId: "OUTER_M1", content: "", ...outer } },
    { ...meta(), type: "tool.execution_start", data: { toolCallId: "INNER", toolName: "task", arguments: { description: "Read" }, ...outer } },
    { ...meta(), type: "subagent.started", data: { toolCallId: "INNER", ...agent, agentDescription: "INNER_PROMPT" } },
    { ...meta(), type: "tool.execution_start", data: { toolCallId: "VIEW", toolName: "view", arguments: { path: "alpha.txt" }, ...inner } },
    { ...meta(), type: "tool.execution_complete", data: { toolCallId: "VIEW", success: true, result: { content: "secret" }, ...inner } },
    { ...meta(), type: "assistant.message", data: { messageId: "INNER_M1", content: "INNER_ANSWER", ...inner } },
    { ...meta(), type: "subagent.completed", data: { toolCallId: "INNER", ...agent } },
    { ...meta(), type: "tool.execution_complete", data: { toolCallId: "INNER", success: true, result: { content: "INNER_ANSWER" }, ...outer } },
    { ...meta(), type: "assistant.message", data: { messageId: "OUTER_M2", content: "OUTER_ANSWER", ...outer } },
    { ...meta(), type: "subagent.completed", data: { toolCallId: "OUTER", ...agent } },
  ];
}

function initial(terminal = false) {
  const thread: AgentThread = { id: "parent", workspaceId: "workspace", rootThreadId: "parent", providerId: "copilot",
    providerIdentities: [], activityState: "Active", conversationRevision: 0, rosterRevision: 0, createdAt: NOW, updatedAt: NOW };
  const turn: AgentTurn = { id: execution.turnId, threadId: thread.id, executionId: execution.executionId,
    status: terminal ? "Completed" : "Running", trigger: { kind: "user" }, permissionMode: "full",
    approvalReviewMode: "manual", approvalReviewReason: "default", providerIdentities: [], startedAt: NOW,
    endedAt: terminal ? NOW : null, createdAt: NOW, updatedAt: NOW };
  return { ...createAgentModelState(), threads: { [thread.id]: thread }, turns: { [turn.id]: turn } };
}

function ingress(mapped: CopilotMappedEvent) {
  const runtime = runtimeEvent(mapped);
  return { providerId: "copilot" as const, sourceKind: "provider-runtime" as const,
    event: runtime.event, runtimeExtension: runtime.extension };
}

function runtimeEvent(mapped: CopilotMappedEvent) {
  return ProviderRuntimeEventSchema().parse(providerRuntimeEvent({ ...mapped.event, turnExecutionId: execution.executionId },
    mapped.childThread ? { providerId: "copilot", kind: "child-thread", childThread: mapped.childThread } : undefined));
}

function replay(port: AcceptedCodexCollaboration) {
  const turn = turnState();
  return capturedTrace().flatMap((event) => mapCopilotEvent(event, "parent", turn)).map((mapped) => port.prepare(ingress(mapped)));
}

function child(port: AcceptedCodexCollaboration) {
  const handle = port.findDelegation("parent", "toolCall:TOOL_6");
  if (!handle) throw new Error("Expected TOOL_6 delegation");
  return handle;
}

function observation(event: AgentEvent, detail: Partial<Extract<ChildThreadEvidence, { role: "child" }>> = {}) {
  return ingress({ event, childThread: { role: "child", path: ["TOOL_6"], ...detail } });
}

function delegate() {
  return ingress({ event: { type: "toolUse", threadId: "parent", toolCallId: "TOOL_6", toolName: "Agent", toolInput: { prompt: "AGENT_9" } },
    childThread: { role: "delegate", path: ["TOOL_6"], prompt: "AGENT_9" } });
}

afterEach(async () => { vi.restoreAllMocks(); await closeAgentStorageTestDatabases(); });

describe("accepted Copilot collaboration", () => {
  it("records the captured child prompt, answer and tools and forwards only the parent card", () => {
    const port = new AcceptedCodexCollaboration(initial());
    const prepared = replay(port);
    const handle = child(port);
    expect(port.loadThread(handle.childThreadId)).toMatchObject({ parentThreadId: "parent", providerId: "copilot", providerIdentities: [] });
    expect(port.loadTurn(handle.turnId)).toMatchObject({ status: "Completed", providerIdentities: [
      { providerId: "copilot", scope: "turn", value: "TOOL_6", provenance: "derived" },
    ] });
    const items = prepared.flatMap((result) => result.changes.flatMap((change) => change.kind === "item-recorded" ? [change.item] : []));
    expect(items.filter((item) => item.payload.projection === "message").map((item) => {
      const message = MessageSchema().parse(item.payload.message);
      return [message.role, message.content];
    })).toEqual([["user", "AGENT_9"], ["assistant", "REDACTED_CHILD_CONTENT"]]);
    expect(items.filter((item) => item.threadId === handle.childThreadId && item.kind.startsWith("tool")).map((item) => item.payload)).toEqual([
      { projection: "codexChildToolCall", nativeItemId: "CHILD_READ", eventKey: "started", toolName: "Read", toolInput: { path: "README.md" } },
      { projection: "codexChildToolResult", nativeItemId: "CHILD_READ", eventKey: "completed", output: "File contents", isError: false },
    ]);
    const forwarded = prepared.flatMap((result) => result.projection.status === "forward" ? [result.projection.event] : []);
    expect(forwarded.map((event) => event.type)).toEqual(["toolUse", "toolUse", "toolResult"]);
    expect(forwarded[1]).toMatchObject({ toolCallId: "TOOL_6", subagentPresentation: {
      detail: { kind: "canonical-child", threadId: handle.childThreadId },
    } });
    expect(port.loadTurn(execution.turnId)?.status).toBe("Running");
  });

  it("replays the trace without extra records and derives the same identities in a fresh owner", () => {
    const port = new AcceptedCodexCollaboration(initial());
    const first = replay(port);
    const second = replay(port);
    const fresh = new AcceptedCodexCollaboration(initial());
    const freshResults = replay(fresh);
    expect(second.flatMap((result) => result.changes)).toEqual([]);
    expect(child(fresh)).toEqual(child(port));
    expect(port.loadTurn(child(port).turnId)?.executionId).toBe(fresh.loadTurn(child(fresh).turnId)?.executionId);
    const itemIds = (results: typeof first) => results.flatMap((result) => result.changes.flatMap((change) => change.kind === "item-recorded" ? [change.item.id] : []));
    expect(itemIds(freshResults)).toEqual(itemIds(first));
    expect(first.flatMap((result) => result.changes).filter((change) => change.kind === "turn-started")).toHaveLength(1);
  });

  it("replaces streamed text with the full message and keeps the first terminal outcome", () => {
    const port = new AcceptedCodexCollaboration(initial());
    port.prepare(delegate());
    port.prepare(observation({ type: "textDelta", threadId: "parent", delta: "Partial" }, { nativeItemId: "message" }));
    const final = port.prepare(observation({ type: "textDelta", threadId: "parent", delta: "Full answer" }, { nativeItemId: "message", final: true }));
    expect(final.changes).toMatchObject([{ kind: "item-recorded", item: { payload: { message: { content: "Full answer" } } } }]);
    port.prepare(observation({ type: "error", threadId: "parent", error: "Child failed", failure: { kind: "fatal" } }));
    expect(port.prepare(observation({ type: "turnComplete", threadId: "parent", reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 })).changes).toEqual([]);
    expect(port.loadTurn(child(port).turnId)?.status).toBe("Errored");
    expect(port.loadTurn(execution.turnId)?.status).toBe("Running");
  });

  it("keeps the final child answer when a delta arrives afterward", () => {
    const port = new AcceptedCodexCollaboration(initial());
    port.prepare(delegate());
    const final = port.prepare(observation({ type: "textDelta", threadId: "parent", delta: "Full answer" },
      { nativeItemId: "message", final: true }));
    expect(final.changes).toMatchObject([{ kind: "item-recorded", item: { payload: {
      eventKey: "stream-complete", message: { content: "Full answer" },
    } } }]);
    expect(port.prepare(observation({ type: "textDelta", threadId: "parent", delta: "Full answer" },
      { nativeItemId: "message" }))).toEqual({ projection: { status: "consumed" }, changes: [] });
    expect(port.recordChildItem(child(port), { kind: "message", nativeItemId: "message", text: "Late", mode: "append" }).payload)
      .toMatchObject({ eventKey: "stream-complete", message: { content: "Full answer" } });
  });

  it.each([
    { event: { type: "textDelta", threadId: "parent", delta: "Missing identity" }, reason: "missing-native-item-id" },
    { event: { type: "system", threadId: "parent", subtype: "unsupported" }, reason: "unsupported-event-type" },
  ] satisfies { event: AgentEvent; reason: string }[])("diagnoses $reason separately from an unknown delegation", ({ event, reason }) => {
    const port = new AcceptedCodexCollaboration(initial());
    port.prepare(delegate());
    const result = port.prepare({ providerId: "copilot", sourceKind: "provider-runtime",
      event: { ...event, turnExecutionId: execution.executionId },
      runtimeExtension: { providerId: "copilot", kind: "child-thread", childThread: { role: "child", path: ["TOOL_6"] } } });
    expect(result.projection).toMatchObject({ status: "rejected", diagnostic: { reason } });
    expect(port.loadTurn(execution.turnId)?.status).toBe("Running");
  });

  it("records diagnostics for unknown children, mismatched duplicates and new items after close", () => {
    const port = new AcceptedCodexCollaboration(initial());
    const tool = observation({ type: "toolUse", threadId: "parent", toolName: "Read", toolCallId: "read", toolInput: { path: "one" } });
    expect(port.prepare(tool)).toMatchObject({ projection: { status: "rejected", diagnostic: { reason: "unknown-delegation" } },
      changes: [{ kind: "diagnostic" }] });
    port.prepare(delegate());
    port.prepare(tool);
    expect(port.prepare(tool).changes).toEqual([]);
    expect(port.prepare(observation({ type: "toolUse", threadId: "parent", toolName: "Read", toolCallId: "read", toolInput: { path: "two" } })))
      .toMatchObject({ projection: { status: "rejected", diagnostic: { reason: "duplicate-mismatch" } }, changes: [{ kind: "diagnostic" }] });
    port.prepare(observation({ type: "ended", threadId: "parent", turnExecutionId: execution.executionId, outcome: "cancelled" }));
    expect(port.prepare(observation({ type: "textDelta", threadId: "parent", delta: "Late" }, { nativeItemId: "late" })))
      .toMatchObject({ projection: { status: "rejected", diagnostic: { reason: "child-turn-terminal" } }, changes: [{ kind: "diagnostic" }] });
    expect(port.loadTurn(execution.turnId)?.status).toBe("Running");
  });

  it("rejects undeclared transcripts and delegation under a completed parent", () => {
    const reporting = SUBAGENT_REPORTING.copilot;
    try {
      SUBAGENT_REPORTING.copilot = { childTranscript: false, childSteps: false };
      const port = new AcceptedCodexCollaboration(initial());
      expect(port.prepare(delegate())).toMatchObject({ projection: { status: "rejected", diagnostic: { reason: "child-transcript-not-declared" } }, changes: [{ kind: "diagnostic" }] });
      expect(port.findDelegation("parent", "toolCall:TOOL_6")).toBeNull();
    } finally { SUBAGENT_REPORTING.copilot = reporting; }
    expect(new AcceptedCodexCollaboration(initial(true)).prepare(delegate())).toMatchObject({
      projection: { status: "rejected", diagnostic: { reason: "parent-turn-not-running" } }, changes: [{ kind: "diagnostic" }],
    });
  });

  it("delegates a nested task under its child owner and consumes grandchild content", () => {
    const port = new AcceptedCodexCollaboration(initial());
    port.prepare(delegate());
    const outer = child(port);
    const nested = port.prepare(ingress({ event: { type: "toolUse", threadId: "parent", toolCallId: "inner", toolName: "Agent", toolInput: { prompt: "Nested task" } },
      childThread: { role: "delegate", path: ["TOOL_6", "inner"], prompt: "Nested task" } }));
    expect(nested.projection).toEqual({ status: "consumed" });
    const inner = port.findDelegation(outer.childThreadId, "toolCall:inner");
    if (!inner) throw new Error("Expected nested delegation");
    expect(port.loadThread(inner.childThreadId)?.parentThreadId).toBe(outer.childThreadId);
    expect(port.prepare(observation({ type: "textDelta", threadId: "parent", delta: "Grandchild answer" },
      { path: ["TOOL_6", "inner"], nativeItemId: "nested-message", final: true }))).toMatchObject({
      projection: { status: "consumed" }, changes: [{ kind: "item-recorded", item: { threadId: inner.childThreadId,
        payload: { message: { content: "Grandchild answer" } } } }],
    });
    expect(port.findDelegation("parent", "toolCall:inner")).toBeNull();
  });

  it("records the live nested order as an inner transcript under the outer child", () => {
    const port = new AcceptedCodexCollaboration(initial());
    const turn = turnState();
    const prepared = nestedLiveTrace().flatMap((event) => mapCopilotEvent(event, "parent", turn)).map((mapped) => port.prepare(ingress(mapped)));
    expect(prepared.filter((result) => result.projection.status === "rejected")).toEqual([]);
    const outer = port.findDelegation("parent", "toolCall:OUTER");
    const inner = outer && port.findDelegation(outer.childThreadId, "toolCall:INNER");
    if (!outer || !inner) throw new Error("Expected outer and inner delegations");
    const items = prepared.flatMap((result) => result.changes.flatMap((change) => change.kind === "item-recorded" ? [change.item] : []));
    const transcript = (threadId: string) => items.filter((item) => item.threadId === threadId).map((item) => item.payload.projection === "message"
      ? MessageSchema().parse(item.payload.message).content : [item.payload.projection, item.payload.nativeItemId].filter(Boolean).join(":"));
    expect(transcript(outer.childThreadId)).toEqual(["OUTER_PROMPT", "codexChildToolCall:INNER", "codexSubagent",
      "codexChildToolResult:INNER", "OUTER_ANSWER"]);
    expect(transcript(inner.childThreadId)).toEqual(["INNER_PROMPT", "codexChildToolCall:VIEW", "codexChildToolResult:VIEW", "INNER_ANSWER"]);
    expect([port.loadTurn(outer.turnId)?.status, port.loadTurn(inner.turnId)?.status]).toEqual(["Completed", "Completed"]);
    expect(port.loadTurn(execution.turnId)?.status).toBe("Running");
  });
});

function draft(mapped: CopilotMappedEvent, sequence: number) {
  const itemId = `copilot-runtime-${sequence}`;
  return { eventId: itemId, routing: { ...execution, itemId }, sourceProviderId: "copilot", sourceIdentities: [],
    payload: { type: "item.recorded" as const, item: { id: itemId, threadId: execution.threadId, turnId: execution.turnId,
      kind: "system" as const, providerIdentities: [], createdAt: NOW, updatedAt: NOW,
      payload: { projection: "providerRuntimeEvent", runtimeEvent: runtimeEvent(mapped) } } } };
}

it("persists the captured transcript through accepted preparation and keeps one parent item after narrative recovery", async () => {
  const db = openAgentStorageTestDatabase();
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES ('workspace', 'Fixture', '.dev/fixture-repo', ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES ('parent', 'workspace', 'Fixture', 'main', 'copilot', ?, ?)").run(NOW, NOW);
  const databaseWriter = agentStorageTestWriter(db);
  const writer = new CanonicalAgentWriterClient(databaseWriter);
  const progress = new CanonicalAcceptedProgress(new CanonicalAgentBoundary(db, databaseWriter, writer, () => {}), writer);
  const handler = new ExecutionWorkerHandler(new CanonicalExecutionWriterPort(writer, () => {}, undefined, undefined, progress));
  let ordinal = 0;
  const send = async (command: ExecutionWorkCommand) => {
    const result = await handler.handle({ requestId: ++ordinal, ordinal, execution, lease, command });
    expect(result.result.kind, JSON.stringify(result.result)).toBe(command.kind === "start" ? "committed" : "accepted");
    return result;
  };
  try {
    await send({ kind: "start", providerId: "copilot", publishParentStart: true,
      parentLive: { planFeature: "none", precedingMessageId: "parent-user" },
      input: { thread: { id: "parent", workspaceId: "workspace", providerId: "copilot", createdAt: NOW },
        turnId: execution.turnId, executionId: execution.executionId, permissionMode: "full", providerIdentities: [],
        userMessage: { kind: "create", messageId: "parent-user", content: "Parent task", sequence: 1 } } });
    const turn = turnState();
    for (const native of capturedTrace()) {
      for (const mapped of mapCopilotEvent(native, "parent", turn)) {
        await send({ kind: "event", phase: "running", nativeCursor: null, events: [draft(mapped, ordinal)] });
      }
    }
    const roster = progress.loadSubagentRoster({ owningParentThreadId: "parent", limit: 100 });
    expect(roster?.done).toMatchObject([{ provider: "copilot", sourceItemId: "toolCall:TOOL_6", latestTurnStatus: "Completed", canStop: false }]);
    expect(roster?.active).toEqual([]);
    const childId = roster?.done[0]?.id;
    if (!childId) throw new Error("Expected accepted child roster");
    await expect.poll(() => progress.depth().pending).toBe(0);
    const saved = new CanonicalAgentStore(db, () => {});
    expect(saved.loadItem("toolCall:TOOL_6")?.payload).toMatchObject({ projection: "narrativeRecovery", childThreadId: childId });
    await send({ kind: "event", phase: "running", nativeCursor: null,
      events: [draft({ event: { type: "textDelta", threadId: "parent", delta: "Parent answer" } }, ordinal)] });
    await send({ kind: "event", phase: "running", nativeCursor: null,
      events: [draft({ event: { type: "assistantMessageBoundary", threadId: "parent", isFinalResponse: true } }, ordinal)] });
    await send({ kind: "event", phase: "running", nativeCursor: null,
      events: [draft({ event: { type: "turnComplete", threadId: "parent", reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 } }, ordinal)],
      terminalInput: { ...execution, providerId: "copilot", providerIdentities: [], outcome: "completed", projection: { kind: "writer-staged" } } });
    await expect.poll(() => progress.depth().pending).toBe(0);
    expect(saved.loadConversationProjection(childId, 20).messages.map((message) => [message.role, message.content]))
      .toEqual([["user", "AGENT_9"], ["assistant", "REDACTED_CHILD_CONTENT"]]);
    expect(db.prepare("SELECT role, content FROM messages WHERE thread_id = ? ORDER BY sequence").all(childId))
      .toEqual([{ role: "user", content: "AGENT_9" }, { role: "assistant", content: "REDACTED_CHILD_CONTENT" }]);
    expect(saved.loadConversationProjection("parent", 20).messages.map((message) => message.content)).toEqual(["Parent task", "Parent answer"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_items WHERE id = 'toolCall:TOOL_6'").get()).toEqual({ count: 1 });
    expect(saved.loadItem("toolCall:TOOL_6")?.payload).toMatchObject({ childThreadId: childId });
    const childTools = Object.values(saved.loadConversationProjection(childId, 20).narrativeByMessage).flatMap((batch) => batch.tools);
    expect(childTools).toMatchObject([{ tool_name: "Read", status: "completed", output_summary: "File contents" }]);
  } finally { await progress.close(); await writer.close(); }
}, 30_000);
