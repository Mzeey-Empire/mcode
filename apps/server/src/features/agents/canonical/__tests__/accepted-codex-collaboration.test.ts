import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentEventSchema, AgentEventType, MessageSchema, ProviderRuntimeExtensionSchema, createAgentModelState,
  type AgentEvent, type AgentItem, type AgentModelState, type AgentThread, type AgentTurn, type CodexChildEvidence,
  type ProviderRuntimeExtension,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { ProviderEventIngressEvent } from "../../../providers/composition/provider-event-ingress.js";
import { AcceptedCodexCollaboration } from "../accepted-codex-collaboration.js";

const NOW = "2026-09-30T18:00:00.000Z";
const PARENT_EXECUTION = "00000000-0000-4000-8000-000000000001";
const CONTINUATION_EXECUTION = "00000000-0000-4000-8000-000000000002";
const parentIdentity = { providerId: "codex", scope: "thread", value: "native-parent", provenance: "native" } as const;

function initial(terminal = false): AgentModelState {
  const thread: AgentThread = { id: "parent", workspaceId: "workspace", rootThreadId: "parent", providerId: "codex",
    providerIdentities: [parentIdentity], activityState: terminal ? "Idle" : "Active", conversationRevision: 1,
    rosterRevision: 0, createdAt: NOW, updatedAt: NOW };
  const turn: AgentTurn = { id: "parent-turn", threadId: thread.id, executionId: PARENT_EXECUTION,
    status: terminal ? "Completed" : "Running", trigger: { kind: "user" }, permissionMode: "supervised",
    approvalReviewMode: "manual", approvalReviewReason: "default", providerIdentities: [parentIdentity],
    startedAt: NOW, endedAt: terminal ? NOW : null, createdAt: NOW, updatedAt: NOW };
  return { ...createAgentModelState(), threads: { [thread.id]: thread }, turns: { [turn.id]: turn } };
}

function ingress(event: AgentEvent, extension?: Omit<ProviderRuntimeExtension, "kind" | "providerId">): ProviderEventIngressEvent {
  return { providerId: "codex", sourceKind: "provider-runtime", event: AgentEventSchema().parse(event),
    ...(extension ? { runtimeExtension: ProviderRuntimeExtensionSchema().parse({ providerId: "codex", kind: "codex-collaboration", ...extension }) } : {}) };
}

function spawn(toolCallId = "spawn-1", nativeThread = "native-child") {
  return ingress({ type: AgentEventType.ToolUse, threadId: "parent", turnExecutionId: PARENT_EXECUTION,
    toolCallId, toolName: "Agent", toolInput: {} }, { collaboration: { kind: "spawnAgent",
    receiverThreadIds: [nativeThread], prompt: "Private child task", agentName: "Explorer", model: "fixture-model", reasoningEffort: "high" } });
}

function child(event: AgentEvent, evidence: Partial<CodexChildEvidence> = {}) {
  return ingress(event, { child: { nativeThreadId: "native-child", nativeTurnId: "native-turn",
    parentCollaborationItemId: "spawn-1", ...evidence } });
}

function childStart() {
  return child({ type: AgentEventType.TurnStarted, threadId: "parent", turnExecutionId: PARENT_EXECUTION });
}

function delegation(port: AcceptedCodexCollaboration, itemId = "toolCall:spawn-1") {
  const value = port.loadCodexChildDelegation("parent", itemId);
  if (!value) throw new Error("Expected accepted delegation");
  return value;
}

function runningChild(port: AcceptedCodexCollaboration) {
  port.prepare(spawn());
  port.prepare(childStart());
  const value = delegation(port);
  const turn = port.loadTurnByProviderIdentity(value.childThread.id,
    { providerId: "codex", scope: "turn", value: "native-turn", provenance: "native" });
  if (!turn) throw new Error("Expected accepted child turn");
  return { ...value, turn };
}

function textDelta(delta: string) {
  return child({ type: AgentEventType.TextDelta, threadId: "parent", turnExecutionId: PARENT_EXECUTION, delta },
    { nativeItemId: "native-message", itemEventKey: "stream" });
}

function actionInput(isResult = false, isError = false, toolCallId = "send-back") {
  const common = { threadId: "parent", turnExecutionId: PARENT_EXECUTION, toolCallId };
  const event: AgentEvent = isResult
    ? { ...common, type: AgentEventType.ToolResult, output: "Delivered", isError }
    : { ...common, type: AgentEventType.ToolUse, toolName: "send_message", toolInput: {} };
  return ingress(event, { child: { nativeThreadId: "native-child", nativeTurnId: "native-turn",
    parentCollaborationItemId: "spawn-1", nativeItemId: `native-${toolCallId}`, itemEventKey: isResult ? "completed" : "started" },
    collaboration: { kind: "returnResult", senderThreadId: "native-child", receiverThreadIds: ["native-parent"], prompt: "Child result" } });
}

function continuation(executionId = CONTINUATION_EXECUTION, targetNativeThreadId = "native-parent") {
  return ingress({ type: AgentEventType.TurnStarted, threadId: "parent", turnExecutionId: executionId }, { continuation: {
    sourceNativeThreadId: "native-child", sourceNativeTurnId: "native-turn", sourceNativeItemId: "native-send-back", targetNativeThreadId,
  } });
}

describe("AcceptedCodexCollaboration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("assigns a provisional child once, indexes its receiver immediately, and scrubs the parent projection", () => {
    const state = initial();
    const port = new AcceptedCodexCollaboration(state);
    const result = port.prepare(spawn());
    const value = delegation(port);
    expect(value.childThread.id).toMatch(/^thread:codex-child:/);
    expect(value.childThread).toMatchObject({ parentThreadId: "parent", owningParentThreadId: "parent", activityState: "Starting" });
    expect(port.loadCodexChildDelegationByReceiverThreadId("native-child")?.childThread.id).toBe(value.childThread.id);
    expect(value.parentItem).toMatchObject({ id: "toolCall:spawn-1", turnId: "parent-turn", payload: {
      identity: "Explorer", model: "fixture-model", reasoningEffort: "high", childThreadId: value.childThread.id,
    } });
    expect(result.projection).toMatchObject({ status: "forward", event: { toolInput: {}, subagentPresentation: {
      detail: { kind: "canonical-child", threadId: value.childThread.id },
    } } });
    expect(result.projection).toMatchObject({ status: "forward", event: { subagentPresentation: { task: "Private child task" } } });
    expect(JSON.stringify(result.projection)).not.toContain("codexCollabKind");
    expect(result.changes.map((change) => change.kind)).toEqual(["thread-recorded", "thread-recorded", "item-recorded", "action-recorded"]);
    expect(result.changes.every((change) => change.sourceExecution.executionId === PARENT_EXECUTION)).toBe(true);
    expect(port.prepare(spawn()).changes).toEqual([]);
    expect(Object.keys(state.threads)).toEqual(["parent"]);
    expect(state.collaborationActions).toEqual({});
  });

  it("binds and starts an unsaved child with exact native and parent Stop ownership", () => {
    const port = new AcceptedCodexCollaboration(initial());
    port.prepare(spawn());
    const assigned = delegation(port).childThread.id;
    const result = port.prepare(childStart());
    const value = delegation(port);
    const started = result.changes.find((change) => change.kind === "turn-started");
    if (started?.kind !== "turn-started") throw new Error("Expected child start");
    expect(result.projection).toEqual({ status: "consumed" });
    expect(started.turn).toMatchObject({ threadId: assigned, status: "Running", permissionMode: "full",
      trigger: { kind: "child", sourceThreadId: "parent", sourceTurnId: "parent-turn", sourceItemId: "toolCall:spawn-1" } });
    expect(started.turn.executionId).toBe(started.sourceExecution.executionId);
    expect(started.turn.executionId).not.toBe(PARENT_EXECUTION);
    expect(started.parentExecution).toEqual({ threadId: "parent", turnId: "parent-turn", executionId: PARENT_EXECUTION });
    expect(value.childThread.id).toBe(assigned);
    expect(value.childThread.providerIdentities).toContainEqual({ providerId: "codex", scope: "thread", value: "native-child", provenance: "native" });
    expect(value.collaborationAction).toMatchObject({ status: "Acknowledged", target: { threadId: assigned, turnId: started.turn.id } });
    const prompt = result.changes.find((change) => change.kind === "item-recorded");
    if (prompt?.kind !== "item-recorded") throw new Error("Expected delegated prompt");
    expect(MessageSchema().parse(prompt.item.payload.message)).toMatchObject({ role: "user", content: "Private child task",
      thread_id: assigned, parentAgentProvenance: { parentThreadId: "parent", parentItemId: "toolCall:spawn-1" } });
    expect(port.prepare(childStart()).changes).toEqual([]);
  });

  it("routes unsaved text, full message, tool use, result and terminal to the assigned child", () => {
    const port = new AcceptedCodexCollaboration(initial());
    const value = runningChild(port);
    const first = port.prepare(textDelta("Before "));
    const second = port.prepare(textDelta("after"));
    const firstItem = first.changes.find((change) => change.kind === "item-recorded");
    const secondItem = second.changes.find((change) => change.kind === "item-recorded");
    if (firstItem?.kind !== "item-recorded" || secondItem?.kind !== "item-recorded") throw new Error("Expected streamed messages");
    expect(secondItem.item.id).toBe(firstItem.item.id);
    expect(secondItem.item.payload.message).toMatchObject({ content: "Before after", thread_id: value.childThread.id });
    const full = port.prepare(child({ type: AgentEventType.Message, threadId: "parent", turnExecutionId: PARENT_EXECUTION,
      content: "Final child answer", tokens: 12 }, { nativeItemId: "native-message", itemEventKey: "stream-complete" }));
    expect(full.changes).toContainEqual(expect.objectContaining({ kind: "item-recorded", item: expect.objectContaining({
      id: firstItem.item.id, payload: expect.objectContaining({ message: expect.objectContaining({ content: "Final child answer" }) }),
    }) }));
    const tool = port.prepare(child({ type: AgentEventType.ToolUse, threadId: "parent", turnExecutionId: PARENT_EXECUTION,
      toolCallId: "write", toolName: "Write", toolInput: { file_path: "child.txt", content: "private file bytes" } }, { nativeItemId: "write" }));
    expect(JSON.stringify(tool.changes)).not.toContain("private file bytes");
    expect(tool.changes).toContainEqual(expect.objectContaining({ kind: "item-recorded", sourceExecution: {
      threadId: value.childThread.id, turnId: value.turn.id, executionId: value.turn.executionId,
    }, item: expect.objectContaining({ payload: expect.objectContaining({ toolInput: { file_path: "child.txt" } }) }) }));
    const output = port.prepare(child({ type: AgentEventType.ToolResult, threadId: "parent", turnExecutionId: PARENT_EXECUTION,
      toolCallId: "write", output: "Wrote child.txt", isError: false }, { nativeItemId: "write" }));
    expect(output.changes).toContainEqual(expect.objectContaining({ kind: "item-recorded", item: expect.objectContaining({
      threadId: value.childThread.id, kind: "tool-result", payload: expect.objectContaining({ output: "Wrote child.txt", isError: false }),
    }) }));
    const terminal = port.prepare(child({ type: AgentEventType.Ended, threadId: "parent", turnExecutionId: PARENT_EXECUTION, outcome: "cancelled" }));
    expect(terminal.changes).toContainEqual(expect.objectContaining({ kind: "turn-terminal", outcome: "cancelled",
      turn: expect.objectContaining({ id: value.turn.id, executionId: value.turn.executionId, status: "Cancelled" }) }));
    expect(port.prepare(child({ type: AgentEventType.TurnComplete, threadId: "parent", turnExecutionId: PARENT_EXECUTION,
      reason: "completed", costUsd: null, tokensIn: 0, tokensOut: 0 })).changes).toEqual([]);
    expect(port.loadTurn(value.turn.id)?.status).toBe("Cancelled");
    expect(port.prepare(textDelta("Late bytes")).changes).toEqual([]);
  });

  it("keeps discarded spawn and text candidates out of accepted indexes and bodies", () => {
    const port = new AcceptedCodexCollaboration(initial());
    const discarded = port.fork();
    discarded.prepare(spawn());
    expect(port.loadCodexChildDelegationByReceiverThreadId("native-child")).toBeNull();
    expect(discarded.loadCodexChildDelegationByReceiverThreadId("native-child")).not.toBeNull();
    runningChild(port);
    port.prepare(textDelta("Accepted"));
    const rejected = port.fork();
    rejected.prepare(textDelta(" rejected"));
    const accepted = port.prepare(textDelta(" tail"));
    const message = accepted.changes.find((change) => change.kind === "item-recorded");
    if (message?.kind !== "item-recorded") throw new Error("Expected accepted text");
    expect(message.item.payload.message).toMatchObject({ content: "Accepted tail" });
  });

  it("forks large accepted history without enumerating record maps and copies each touched map only once", () => {
    const base = initial();
    const history: Record<string, AgentItem> = {};
    for (let index = 0; index < 5_000; index++) {
      const id = `ordinary-tool-${index}`;
      history[id] = { id, threadId: "parent", turnId: "parent-turn", kind: "tool-call", providerIdentities: [],
        payload: { projection: "toolCall", completed: true }, createdAt: NOW, updatedAt: NOW };
    }
    const threadKeys = vi.fn((target: AgentModelState["threads"]) => Reflect.ownKeys(target));
    const turnKeys = vi.fn((target: AgentModelState["turns"]) => Reflect.ownKeys(target));
    const itemKeys = vi.fn((target: AgentModelState["items"]) => Reflect.ownKeys(target));
    const state = { ...base, threads: new Proxy(base.threads, { ownKeys: threadKeys }),
      turns: new Proxy(base.turns, { ownKeys: turnKeys }), items: new Proxy(history, { ownKeys: itemKeys }) };
    const accepted = new AcceptedCodexCollaboration(state);
    threadKeys.mockClear();
    turnKeys.mockClear();
    const candidate = accepted.fork(state);
    accepted.fork();
    expect(candidate.loadThreadByProviderIdentity(parentIdentity)?.id).toBe("parent");
    expect(candidate.loadTurnByExecution(PARENT_EXECUTION)?.id).toBe("parent-turn");
    expect(threadKeys).not.toHaveBeenCalled();
    expect(turnKeys).not.toHaveBeenCalled();
    expect(itemKeys).not.toHaveBeenCalled();
    const prepared = candidate.prepare(spawn());
    expect(prepared.projection.status).toBe("forward");
    expect(threadKeys).toHaveBeenCalledTimes(1);
    expect(itemKeys).toHaveBeenCalledTimes(1);
    expect(turnKeys).not.toHaveBeenCalled();
    expect(Object.keys(history)).toHaveLength(5_000);
    expect(accepted.loadCodexChildDelegationByReceiverThreadId("native-child")).toBeNull();
    expect(candidate.loadCodexChildDelegationByReceiverThreadId("native-child")).not.toBeNull();
  });

  it("refreshes accepted parent records on fork while keeping child indexes and source ownership", () => {
    const base = initial();
    const accepted = new AcceptedCodexCollaboration(base);
    const value = runningChild(accepted);
    const oldParent = base.turns["parent-turn"];
    if (!oldParent) throw new Error("Expected parent turn");
    const newer: AgentTurn = { ...oldParent, id: "new-parent-turn", executionId: CONTINUATION_EXECUTION };
    const current: AgentModelState = { ...base, threads: { ...base.threads, [value.childThread.id]: value.childThread },
      turns: { ...base.turns, [oldParent.id]: { ...oldParent, status: "Completed", endedAt: NOW },
        [value.turn.id]: value.turn, [newer.id]: newer },
      items: { [value.parentItem.id]: value.parentItem }, collaborationActions: { [value.collaborationAction.id]: value.collaborationAction } };
    const candidate = accepted.fork(current);
    expect(candidate.loadTurnByExecution(CONTINUATION_EXECUTION)).toEqual(newer);
    expect(accepted.loadTurnByExecution(CONTINUATION_EXECUTION)).toBeNull();
    const prepared = candidate.prepare(child({ type: "textDelta", threadId: "parent", turnExecutionId: CONTINUATION_EXECUTION,
      delta: "Original child" }, { nativeItemId: "new-text", itemEventKey: "stream" }));
    expect(prepared.projection.status).toBe("consumed");
    expect(prepared.changes).toContainEqual(expect.objectContaining({ kind: "item-recorded",
      parentExecution: { threadId: "parent", turnId: "parent-turn", executionId: PARENT_EXECUTION },
      sourceExecution: { threadId: value.childThread.id, turnId: value.turn.id, executionId: value.turn.executionId },
    }));
  });

  it("rehydrates native routing and preserves the original child owner after a newer parent turn", () => {
    const original = new AcceptedCodexCollaboration(initial());
    const value = runningChild(original);
    const state = initial(true);
    const newer: AgentTurn = { ...value.turn, id: "new-parent-turn", threadId: "parent",
      executionId: CONTINUATION_EXECUTION, trigger: { kind: "user" }, providerIdentities: [parentIdentity] };
    const hydrated = new AcceptedCodexCollaboration({ ...state,
      threads: { ...state.threads, [value.childThread.id]: value.childThread },
      turns: { ...state.turns, [value.turn.id]: value.turn, [newer.id]: newer },
      items: { [value.parentItem.id]: value.parentItem },
      collaborationActions: { [value.collaborationAction.id]: value.collaborationAction } });
    const result = hydrated.prepare(child({ type: AgentEventType.TextDelta, threadId: "parent",
      turnExecutionId: CONTINUATION_EXECUTION, delta: "Original child" }, { nativeItemId: "new-text", itemEventKey: "stream" }));
    expect(result.projection).toEqual({ status: "consumed" });
    expect(result.changes).toContainEqual(expect.objectContaining({ kind: "item-recorded",
      sourceExecution: { threadId: value.childThread.id, turnId: value.turn.id, executionId: value.turn.executionId },
      parentExecution: { threadId: "parent", turnId: "parent-turn", executionId: PARENT_EXECUTION },
      item: expect.objectContaining({ threadId: value.childThread.id, turnId: value.turn.id }),
    }));
  });

  it("routes nested native spawn and child turn records to their immediate accepted parent", () => {
    const port = new AcceptedCodexCollaboration(initial());
    const value = runningChild(port);
    const spawned = port.prepare(ingress({ type: AgentEventType.ToolUse, threadId: "parent", turnExecutionId: PARENT_EXECUTION,
      toolCallId: "nested-spawn", toolName: "Agent", toolInput: {} }, {
      child: { nativeThreadId: "native-child", nativeTurnId: "native-turn", parentCollaborationItemId: "spawn-1", nativeItemId: "nested-spawn" },
      collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-grandchild"], prompt: "Nested work" },
    }));
    expect(spawned.projection).toEqual({ status: "consumed" });
    const nested = port.loadCodexChildDelegation(value.childThread.id, "toolCall:nested-spawn");
    if (!nested) throw new Error("Expected accepted nested child");
    expect(nested.childThread).toMatchObject({ parentThreadId: value.childThread.id, owningParentThreadId: "parent" });
    expect(nested.parentItem.turnId).toBe(value.turn.id);
    const started = port.prepare(child({ type: AgentEventType.TurnStarted, threadId: "parent", turnExecutionId: PARENT_EXECUTION },
      { nativeThreadId: "native-grandchild", nativeTurnId: "native-grandchild-turn", parentCollaborationItemId: "nested-spawn" }));
    expect(started.changes).toContainEqual(expect.objectContaining({ kind: "turn-started",
      parentExecution: { threadId: value.childThread.id, turnId: value.turn.id, executionId: value.turn.executionId },
      turn: expect.objectContaining({ threadId: nested.childThread.id, trigger: expect.objectContaining({ sourceItemId: "toolCall:nested-spawn" }) }),
    }));
  });

  it("rejects oversized preparation atomically and keeps the accepted sibling usable", () => {
    const port = new AcceptedCodexCollaboration(initial());
    runningChild(port);
    const candidate = port.fork();
    const result = (output: string) => child({ type: AgentEventType.ToolResult, threadId: "parent", turnExecutionId: PARENT_EXECUTION,
      toolCallId: "large-tool", output, isError: false }, { nativeItemId: "large-tool" });
    expect(() => candidate.prepare(result("x".repeat(2 * 1024 * 1024)))).toThrow("exceeds its change limit");
    expect(candidate.prepare(result("Small result")).projection).toEqual({ status: "consumed" });
    const admitted = port.prepare(result("Accepted result"));
    expect(admitted.changes).toContainEqual(expect.objectContaining({ kind: "item-recorded", item: expect.objectContaining({
      payload: expect.objectContaining({ output: "Accepted result" }),
    }) }));
  });

  it("drops contradictory receivers and rolls back partial binding when a child turn is missing", () => {
    const port = new AcceptedCodexCollaboration(initial());
    port.prepare(spawn());
    const missing = port.prepare(textDelta("Cannot route yet"));
    expect(missing.projection).toMatchObject({ status: "rejected", diagnostic: { reason: "Codex child turn not found: native-turn" } });
    expect(missing.changes.every((change) => change.kind === "diagnostic")).toBe(true);
    expect(delegation(port).childThread.providerIdentities).toEqual([]);
    expect(delegation(port).collaborationAction.status).toBe("Dispatched");
    const mismatch = port.prepare(child({ type: AgentEventType.TurnStarted, threadId: "parent", turnExecutionId: PARENT_EXECUTION },
      { parentCollaborationItemId: "another-spawn" }));
    expect(mismatch.projection).toMatchObject({ status: "rejected", diagnostic: { reason: "receiver-parent-item-mismatch" } });
    expect(mismatch.changes).toContainEqual(expect.objectContaining({ kind: "diagnostic", item: expect.objectContaining({
      payload: expect.objectContaining({ projection: "codexChildRoutingFailure", recovery: "retry-child-routing" }),
    }) }));
    expect(port.prepare(childStart()).projection).toEqual({ status: "consumed" });
  });

  it("records a real rejected delivery and creates a distinct linked retry without reusing its child", () => {
    const port = new AcceptedCodexCollaboration(initial());
    port.prepare(spawn());
    const previous = delegation(port);
    const result = port.prepare(child({ type: AgentEventType.ToolResult, threadId: "parent", turnExecutionId: PARENT_EXECUTION,
      toolCallId: "spawn-1", output: "Rejected", isError: true }, { nativeTurnId: undefined }));
    expect(result.projection).toEqual({ status: "consumed" });
    expect(delegation(port).collaborationAction).toMatchObject({ status: "Failed", deliveryUnknown: false });
    expect(delegation(port).childThread.activityState).toBe("Unavailable");
    const late = port.prepare(childStart());
    expect(late.projection.status).toBe("rejected");
    const candidate = port.fork();
    const replacement = candidate.retryCodexChildDelegation({ parentThreadId: "parent", parentTurnId: "parent-turn",
      parentExecutionId: PARENT_EXECUTION, parentItemId: "toolCall:spawn-retry", previousActionId: previous.collaborationAction.id,
      receiverThreadIds: ["native-retry"], providerIdentities: [parentIdentity], prompt: "Retry exact task" });
    expect(replacement.childThread.id).not.toBe(previous.childThread.id);
    expect(replacement.parentItem.payload.replacementForActionId).toBe(previous.collaborationAction.id);
    expect(candidate.loadCodexChildDelegationByReceiverThreadId("native-retry")?.childThread.id).toBe(replacement.childThread.id);
    expect(port.loadCodexChildDelegationByReceiverThreadId("native-retry")).toBeNull();
  });

  it("records action delivery and a distinct provider retry with stable assigned identities", () => {
    const port = new AcceptedCodexCollaboration(initial(true));
    runningChild(port);
    const dispatched = port.prepare(actionInput());
    const action = dispatched.changes.find((change) => change.kind === "action-recorded");
    if (action?.kind !== "action-recorded") throw new Error("Expected child action");
    expect(action.action).toMatchObject({ kind: "return-result", status: "Dispatched", target: { threadId: "parent" } });
    const failed = port.prepare(actionInput(true, true));
    expect(failed.changes).toContainEqual(expect.objectContaining({ kind: "action-recorded", action: expect.objectContaining({ id: action.action.id, status: "Failed" }) }));
    const conflict = port.prepare(actionInput(true));
    expect(conflict.projection.status).toBe("rejected");
    expect(JSON.stringify(conflict.projection)).not.toContain("codexCollabKind");
    expect(JSON.stringify(conflict.changes)).not.toContain("receiverThreadIds");
    const retry = port.prepare(actionInput(false, false, "send-back-retry"));
    const replacement = retry.changes.find((change) => change.kind === "action-recorded");
    if (replacement?.kind !== "action-recorded") throw new Error("Expected retry observation");
    expect(replacement.action.id).not.toBe(action.action.id);
    expect(replacement.action.status).toBe("Dispatched");
    const delivered = port.prepare(actionInput(true, false, "send-back-retry"));
    expect(delivered.changes).toContainEqual(expect.objectContaining({ kind: "action-recorded", action: expect.objectContaining({ id: replacement.action.id, status: "Acknowledged" }) }));
  });

  it("rejects unsupported provider continuation without starting a turn or acknowledging its child action", () => {
    const port = new AcceptedCodexCollaboration(initial(true));
    runningChild(port);
    const dispatched = port.prepare(actionInput());
    const action = dispatched.changes.find((change) => change.kind === "action-recorded");
    if (action?.kind !== "action-recorded") throw new Error("Expected continuation action");
    const result = port.prepare(continuation());
    expect(result.projection.status).toBe("rejected");
    expect(result.changes.every((change) => change.kind === "diagnostic")).toBe(true);
    expect(port.loadTurnByExecution(CONTINUATION_EXECUTION)).toBeNull();
    expect(port.loadTurn("parent-turn")?.status).toBe("Completed");
    const nativeActionIdentity = action.action.providerIdentities.find((identity) => identity.scope === "item");
    if (!nativeActionIdentity) throw new Error("Expected action identity");
    expect(port.loadCollaborationActionBySourceProviderIdentity(action.action.source.threadId, action.action.source.turnId,
      nativeActionIdentity)).toMatchObject({ status: "Dispatched", target: { threadId: "parent" } });
  });

  it("rejects continuation ownership conflicts and sanitizes its diagnostic instead of inventing a start", () => {
    const port = new AcceptedCodexCollaboration(initial());
    runningChild(port);
    port.prepare(actionInput());
    const old = port.prepare(continuation(PARENT_EXECUTION));
    expect(old.projection.status).toBe("rejected");
    expect(old.changes.every((change) => change.kind === "diagnostic")).toBe(true);
    const active = port.prepare(continuation());
    expect(active.projection.status).toBe("rejected");
    expect(port.loadTurnByExecution(CONTINUATION_EXECUTION)).toBeNull();
    expect(JSON.stringify(active.projection)).not.toContain("sourceNativeThreadId");
    expect(port.loadTurn("parent-turn")?.status).toBe("Running");
  });
});
