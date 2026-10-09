import {
  AgentEventSchema, CanonicalAgentSemanticEnvelopeSchema, MessageSchema, PlanVersionSchema,
  createAgentModelState, reduceAgentEventBatch,
  type AgentEvent, type AgentItem, type AgentThread, type AgentTurn, type Message, type PlanVersion,
} from "@mcode/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionSemanticOperation, ParentLiveEffects } from "../../execution/execution-worker-handler.js";
import { taskToolWriteIntents } from "../../tasks/task-tool-intent-reducer.js";
import type { StoredTask } from "../../orchestration/persistence/task-repo.js";
import { prepareAcceptedFeatureObservations } from "../accepted-feature-observations.js";

const STARTED_AT = "2026-09-30T10:00:00.000Z";
const ACCEPTED_AT = "2026-09-30T10:00:04.000Z";
const execution = { threadId: "parent-thread", turnId: "parent-turn", executionId: "00000000-0000-4000-8000-000000000001" };
const thread: AgentThread = { id: execution.threadId, workspaceId: "workspace", rootThreadId: execution.threadId,
  providerId: "codex", providerIdentities: [], activityState: "Active", conversationRevision: 1,
  rosterRevision: 0, createdAt: STARTED_AT, updatedAt: STARTED_AT };
const turn: AgentTurn = { id: execution.turnId, threadId: execution.threadId, executionId: execution.executionId,
  status: "Running", trigger: { kind: "user" }, permissionMode: "supervised", approvalReviewMode: "manual",
  approvalReviewReason: "default", providerIdentities: [], startedAt: STARTED_AT, endedAt: null,
  createdAt: STARTED_AT, updatedAt: STARTED_AT };
const base = { thread, turn, acceptedAt: ACCEPTED_AT, messageSequence: 3, compaction: { active: false }, currentNoticeSessionId: "session-1" };
const planReady = { title: "Login plan", contentMd: "# Login plan\n## Build\nUse passkeys.",
  captureSource: "fence" as const };
const assistant = { messageId: "assistant-message", precedingMessageId: "user-message", content: planReady.contentMd,
  model: "fixture-model", attachments: [] };

function operation(effects: Partial<ParentLiveEffects> = {}, source?: AgentEvent, id = "lease:2"): ExecutionSemanticOperation {
  return { operationId: id, execution, lease: { leaseId: "lease", ownerEpoch: 1, workerIndex: 0, workerGeneration: 1 },
    ordinal: 2, mutation: { kind: "live-event", text: { kind: "unchanged" }, ...effects },
    ...(source ? { livePublication: [{ event: source, after: "writer" }] } : {}) };
}

function event(payload: object): AgentEvent {
  return AgentEventSchema().parse({ threadId: thread.id, turnExecutionId: execution.executionId, ...payload });
}

function prepare(op: ExecutionSemanticOperation, items: Readonly<Record<string, AgentItem>> = {}) {
  return prepareAcceptedFeatureObservations({ ...base, operation: op, items });
}

function item(id: string, payload: AgentItem["payload"], turnId = "old-turn", updatedAt = STARTED_AT): AgentItem {
  return { id, threadId: thread.id, turnId, kind: payload.projection === "message" ? "message" : "system",
    providerIdentities: [], payload, createdAt: STARTED_AT, updatedAt };
}

function recorded(prepared: ReturnType<typeof prepare>) {
  return prepared.events.flatMap((draft) => draft.payload.type === "item.recorded" ? [draft.payload.item] : []);
}

function apply(prepared: ReturnType<typeof prepare>, items: Readonly<Record<string, AgentItem>> = {}) {
  const state = { ...createAgentModelState(), threads: { [thread.id]: thread }, turns: { [turn.id]: turn }, items: { ...items } };
  const result = reduceAgentEventBatch(state, prepared.events.map((draft, index) => CanonicalAgentSemanticEnvelopeSchema.parse({
    ...draft, acceptedSequence: index + 1, serverTimestamps: { acceptedAt: ACCEPTED_AT },
  })));
  expect(result.outcome).toBe("applied");
  if (result.outcome !== "applied") throw new Error(result.reason);
  return result.state;
}

function board(tasks: StoredTask[]): AgentItem {
  return item(`taskBoard:${thread.id}`, { projection: "taskBoard", tasks });
}

function planRecord(overrides: Partial<PlanVersion> = {}): PlanVersion {
  return { id: "00000000-0000-4000-8000-000000000010", threadId: thread.id, messageId: "old-assistant", title: "Earlier plan",
    contentMd: "# Earlier plan", status: "ready", version: 1, author: "agent", providerId: "codex",
    captureSource: "fence", baseVersionId: null, revision: 0, acceptedAt: null, acceptedMessageId: null,
    createdAt: STARTED_AT, updatedAt: STARTED_AT, ...overrides };
}

function notice(message = "Provider warning", noticeKey = "warning"): Extract<AgentEvent, { type: "system" }> {
  return { type: "system", threadId: thread.id, turnExecutionId: execution.executionId,
    subtype: "provider.notice.warning", message,
    systemNotice: { kind: "warning", presentation: "timeline", scope: "session", sessionId: "session-1", noticeKey } };
}

function noticeMessage(id: string, sequence: number, overrides: Partial<Message> = {}): Message {
  return MessageSchema().parse({ id, thread_id: thread.id, role: "system", content: "Earlier warning",
    timestamp: STARTED_AT, sequence, tool_calls: null, files_changed: null, cost_usd: null,
    tokens_used: null, attachments: null, model: null, systemNotice: notice().systemNotice, ...overrides });
}

describe("prepareAcceptedFeatureObservations", () => {
  it("preserves exact child publications without applying their notices or context to the parent", () => {
    const childThread: AgentThread = { ...thread, id: "child-thread", parentThreadId: thread.id, owningParentThreadId: thread.id };
    const childTurn: AgentTurn = { ...turn, id: "child-turn", threadId: childThread.id,
      executionId: "00000000-0000-4000-8000-000000000002" };
    for (const fields of [
      { type: "system", subtype: "provider.session.started", systemNotice: { kind: "diagnostic", presentation: "timeline",
        scope: "session", sessionId: "child-session" } },
      { type: "system", subtype: "provider.notice.warning", message: "Child warning", systemNotice: {
        kind: "warning", presentation: "timeline", scope: "session", sessionId: "child-session" } },
      { type: "contextEstimate", tokensIn: 900, totalProcessedTokens: 1200, contextWindow: 1000 },
      { type: "compacting", active: true },
    ]) {
      const source = event({ ...fields, threadId: childThread.id, turnExecutionId: childTurn.executionId });
      const op: ExecutionSemanticOperation = { ...operation(), mutation: {
        kind: "append-events", phase: "running", nativeCursor: null, events: [],
      }, livePublication: [{ after: "writer", event: source }] };
      const input = { ...base, operation: op, items: {}, childPublicationOwners: [{ thread: childThread, turn: childTurn }] };
      expect(prepareAcceptedFeatureObservations(input)).toEqual({ events: [], publications: op.livePublication });
      expect(() => prepareAcceptedFeatureObservations({ ...input, childPublicationOwners: [] }))
        .toThrow("exact execution ownership");
      expect(() => prepareAcceptedFeatureObservations({ ...input, childPublicationOwners: [{ thread: childThread,
        turn: { ...childTurn, executionId: execution.executionId } }] })).toThrow("exact execution ownership");
      expect(() => prepareAcceptedFeatureObservations({ ...input, childPublicationOwners: [{
        thread: { ...childThread, owningParentThreadId: "other-parent" }, turn: childTurn }] }))
        .toThrow("exact execution ownership");
      expect(() => prepareAcceptedFeatureObservations({ ...input, operation: { ...op,
        mutation: { kind: "append-events", phase: "running", nativeCursor: null, events: [],
          parentLive: { text: { kind: "unchanged" } } } } })).toThrow("parent feature effects");
    }
  });

  it("applies real update_plan task intents while preserving other groups and leaving accepted input untouched", () => {
    const original = board([{ id: "1", content: "Child task", status: "in_progress", group: "Child" },
      { content: "Old parent task", status: "pending" }]);
    const snapshot = structuredClone(original);
    const taskIntents = taskToolWriteIntents({ kind: "tool-use", toolName: "update_plan",
      toolInput: { plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "inProgress" }] }, bufferedCalls: [] });
    const prepared = prepare(operation({ taskIntents }), { [original.id]: original });
    expect(recorded(prepared)).toHaveLength(1);
    expect(recorded(prepared)[0].payload).toEqual({ projection: "taskBoard", tasks: [
      { id: "1", content: "Child task", status: "in_progress", group: "Child" },
      { content: "Inspect", status: "completed", group: "Tasks" },
      { content: "Implement", status: "in_progress", group: "Tasks" },
    ] });
    expect(original).toEqual(snapshot);
    expect(apply(prepared, { [original.id]: original }).items[original.id].turnId).toBe(turn.id);
    expect(prepare(operation({ taskIntents }), apply(prepared).items).events).toEqual([]);
  });

  it("matches scoped task IDs, uses only unambiguous global fallback, replaces content matches, and removes the final task", () => {
    const original = board([{ id: "1", content: "Parent", status: "pending" },
      { id: "1", content: "Child", status: "pending", group: "Child" },
      { id: "2", content: "Unique", status: "pending", group: "Child" }]);
    const prepared = prepare(operation({ taskIntents: [
      { kind: "update-task", id: "1", group: "Child", patch: { status: "completed" } },
      { kind: "update-task", id: "1", group: "Unknown", patch: { content: "Wrong" } },
      { kind: "update-task", id: "2", group: "Unknown", patch: { activeForm: "Working" } },
      { kind: "append-task", task: { content: "Parent", status: "in_progress" } },
      { kind: "remove-task", id: "1", group: "Child" },
    ] }), { [original.id]: original });
    expect(recorded(prepared)[0].payload.tasks).toEqual([
      { id: "2", content: "Unique", status: "pending", group: "Child", activeForm: "Working" },
      { content: "Parent", status: "in_progress" },
    ]);
    const last = board([{ id: "9", content: "Last", status: "pending" }]);
    expect(recorded(prepare(operation({ taskIntents: [{ kind: "remove-task", id: "9", group: "Tasks" }] }), { [last.id]: last }))[0].payload.tasks).toEqual([]);
    expect(prepare(operation({ taskIntents: [{ kind: "remove-task", id: "unknown", group: "Tasks" }] }), { [last.id]: last }).events).toEqual([]);
  });

  it("uses legacy task seeds until the first accepted board and updates that board through two real turn routes", () => {
    const seed: StoredTask[] = [{ id: "1", content: "Legacy task", status: "pending" }];
    const op = operation({ taskIntents: [{ kind: "update-task", id: "1", group: "Tasks", patch: { status: "in_progress" } }] });
    const first = prepareAcceptedFeatureObservations({ ...base, persistedTasks: seed, operation: op, items: {} });
    const firstState = apply(first);
    const secondExecution = { ...execution, turnId: "second-turn", executionId: "00000000-0000-4000-8000-000000000002" };
    const secondTurn = { ...turn, id: secondExecution.turnId, executionId: secondExecution.executionId };
    const second = prepareAcceptedFeatureObservations({ ...base, turn: secondTurn, persistedTasks: seed,
      acceptedAt: "2026-09-30T10:00:05.000Z", items: firstState.items,
      operation: { ...operation({ taskIntents: [{ kind: "update-task", id: "1", group: "Tasks", patch: { status: "completed" } }] }, undefined, "lease:3"), execution: secondExecution } });
    const result = reduceAgentEventBatch({ ...firstState, turns: { ...firstState.turns, [secondTurn.id]: secondTurn } }, second.events.map((draft) =>
      CanonicalAgentSemanticEnvelopeSchema.parse({ ...draft, acceptedSequence: 1, serverTimestamps: { acceptedAt: "2026-09-30T10:00:05.000Z" } })));
    expect(result.outcome).toBe("applied");
    expect(result.state.items[`taskBoard:${thread.id}`]).toMatchObject({ turnId: secondTurn.id,
      payload: { projection: "taskBoard", tasks: [{ id: "1", content: "Legacy task", status: "completed" }] } });
    expect(firstState.items[`taskBoard:${thread.id}`].payload.tasks).toEqual([{ id: "1", content: "Legacy task", status: "in_progress" }]);
    expect(seed).toEqual([{ id: "1", content: "Legacy task", status: "pending" }]);
    const emptyBoard = board([]);
    expect(prepareAcceptedFeatureObservations({ ...base, persistedTasks: seed, operation: op, items: { [emptyBoard.id]: emptyBoard } }).events).toEqual([]);
  });

  it("extracts append-events parentLive effects and validates bounded task input without hiding failures", () => {
    const op = operation({ taskIntents: [{ kind: "append-task", task: { content: "Task", status: "pending" } }] });
    if (op.mutation.kind !== "live-event") throw new Error("Fixture needs live effects");
    expect(prepare({ ...op, mutation: { kind: "append-events", phase: "running", nativeCursor: null, events: [], parentLive: op.mutation } }))
      .toEqual(prepare(op));
    expect(() => prepare(operation({ taskIntents: [{ kind: "append-task", task: { content: "x".repeat(16 * 1024 + 1), status: "pending" } }] }))).toThrow();
    const invalid = board([{ content: "Task", status: "pending" }]);
    invalid.payload.tasks = [{ content: "Task", status: "pending", providerSecret: "private" }];
    expect(() => prepare(op, { [invalid.id]: invalid })).toThrow();
  });

  it("assigns exact accepted plan ID/version/time and records agent authorship", () => {
    const op = operation({ message: assistant, planOutput: planReady });
    const prepared = prepare(op);
    expect(prepared).toEqual(prepare(op));
    expect(prepared.planOutput).toMatchObject({ threadId: thread.id, messageId: assistant.messageId,
      version: 1, createdAt: ACCEPTED_AT, status: "ready", author: "agent", providerId: "codex", captureSource: "fence", revision: 0 });
    expect(PlanVersionSchema().parse(prepared.planOutput)).toEqual(prepared.planOutput);
    expect(prepared.planRecords).toEqual([prepared.planOutput]);
    expect(recorded(prepared)[0].payload).toEqual({ projection: "plan", plan: prepared.planOutput });
    expect(apply(prepared).items[recorded(prepared)[0].id]).toEqual(recorded(prepared)[0]);
    expect(prepare({ ...op, operationId: "lease:3" }).planOutput?.id).not.toBe(prepared.planOutput?.id);
    expect(prepare(op, apply(prepared).items)).toEqual({ events: [], publications: [] });
  });

  it("folds plan status observations and supersedes prior drafts without changing their original item ownership", () => {
    const first = planRecord();
    const original = item(`plan:${first.id}`, { projection: "plan", plan: first });
    const previous = planRecord({ id: "00000000-0000-4000-8000-000000000011", version: 2, status: "accepted", messageId: "other-assistant" });
    const items = { [original.id]: original, previous: item("previous", { projection: "plan", plan: previous }) };
    const prepared = prepare(operation({ message: assistant, planOutput: planReady }), items);
    expect(prepared.planOutput?.version).toBe(3);
    expect(prepared.planRecords).toEqual([{ ...first, status: "superseded", updatedAt: ACCEPTED_AT }, prepared.planOutput]);
    expect(recorded(prepared)[0].id).not.toBe(original.id);
    expect(recorded(prepared)[0].turnId).toBe(turn.id);
    const state = apply(prepared, items);
    expect(state.items[original.id]).toEqual(original);
    const next = prepare(operation({ message: { ...assistant, messageId: "next-assistant" }, planOutput: planReady }, undefined, "lease:4"), state.items);
    expect(next.planOutput?.version).toBe(4);
    expect(next.planRecords?.filter((plan) => plan.status === "superseded").map((plan) => plan.id)).toEqual([prepared.planOutput?.id]);
  });

  it("rejects conflicting or incomplete plan observations and preserves valid same-message retries", () => {
    const op = operation({ message: assistant, planOutput: planReady });
    const saved = apply(prepare(op)).items;
    expect(() => prepare(operation({ message: assistant, planOutput: { ...planReady, title: "Changed" } }), saved)).toThrow("conflicting content");
    expect(() => prepare(operation({ planOutput: planReady }))).toThrow("assigned assistant message");
    expect(() => prepare(operation({ message: assistant, planOutput: { ...planReady, contentMd: "x".repeat(65_537) } }))).toThrow();
    const foreign = item("foreign-plan", { projection: "plan", plan: planRecord({ threadId: "foreign" }) });
    expect(() => prepare(op, { [foreign.id]: foreign })).toThrow("conflicting ownership");
  });

  it("merges legacy plan versions with accepted status observations and supersedes only the current drafts", () => {
    const legacy = planRecord({ id: "00000000-0000-4000-8000-000000000012", version: 4, messageId: "legacy-assistant" });
    const accepted = planRecord({ id: "00000000-0000-4000-8000-000000000013", version: 5, messageId: "accepted-assistant" });
    const items = { update: item("legacy-update", { projection: "plan", plan: { ...legacy, status: "superseded" } }),
      accepted: item("accepted-plan", { projection: "plan", plan: accepted }) };
    const prepared = prepareAcceptedFeatureObservations({ ...base, operation: operation({ message: assistant, planOutput: planReady }),
      persistedPlans: [legacy], items });
    expect(prepared.planOutput?.version).toBe(6);
    expect(prepared.planRecords?.filter((record) => record.status === "superseded").map((record) => record.id)).toEqual([accepted.id]);
    const legacyOnly = prepareAcceptedFeatureObservations({ ...base, operation: operation({ message: assistant, planOutput: planReady }),
      persistedPlans: [legacy], items: {} });
    expect(legacyOnly.planOutput?.version).toBe(5);
    expect(legacyOnly.planRecords?.[0]).toEqual({ ...legacy, status: "superseded", updatedAt: ACCEPTED_AT });
    expect(legacy.status).toBe("ready");
  });

  it("projects exact system intents and deterministic notices for generic providers, rejecting mismatched evidence", () => {
    const source = notice();
    const op = operation({ systemIntents: [{ kind: "system-notice", event: source }] }, source);
    const prepared = prepareAcceptedFeatureObservations({ ...base, thread: { ...thread, providerId: "cursor" }, operation: op, items: {} });
    const message = MessageSchema().parse(recorded(prepared)[0].payload.message);
    expect(message).toMatchObject({ role: "system", content: source.message, timestamp: ACCEPTED_AT, sequence: 3, is_internal: false });
    expect(prepared.publications).toEqual([{ after: "writer", event: { ...source, messageId: message.id } }]);
    expect(prepared.events[0]).toMatchObject({ routing: { ...execution, itemId: `message:${message.id}` }, sourceProviderId: "cursor" });
    expect(() => prepare(operation({ systemIntents: [{ kind: "system-notice", event: notice("Different") }] }, source))).toThrow("do not match");
    expect(() => prepare(operation({}, { ...source, turnExecutionId: "00000000-0000-4000-8000-000000000099" }))).toThrow("exact execution ownership");
  });

  it("updates a deduplicated notice under its original ID/order and records cross-turn updates separately", () => {
    const old = noticeMessage("existing-notice", 1);
    const original = item(`message:${old.id}`, { projection: "message", message: old });
    const source = notice("New warning");
    const prepared = prepare(operation({ systemIntents: [{ kind: "system-notice", event: source }] }, source), { [original.id]: original });
    expect(recorded(prepared)[0].payload.message).toEqual({ ...old, content: "New warning" });
    expect(recorded(prepared)[0].id).not.toBe(original.id);
    expect(recorded(prepared)[0].turnId).toBe(turn.id);
    expect(prepared.publications[0].event).toMatchObject({ messageId: old.id });
    const state = apply(prepared, { [original.id]: original });
    expect(state.items[original.id]).toEqual(original);
    expect(prepare(operation({}, source), state.items).events).toEqual([]);
  });

  it("preserves model-rerouted replacement semantics, expires prior sessions, and prunes session notices to newest20", () => {
    const rerouted = noticeMessage("rerouted", 1, { systemNotice: { kind: "model-rerouted", presentation: "timeline",
      scope: "session", sessionId: "session-1", noticeKey: "old-model" } });
    const rerouteSource = event({ type: "system", subtype: "provider.notice.model-rerouted", message: "Rerouted again",
      systemNotice: { kind: "model-rerouted", presentation: "timeline", scope: "session", sessionId: "session-1", noticeKey: "new-model" } });
    expect(prepare(operation({}, rerouteSource), { rerouted: item("rerouted-item", { projection: "message", message: rerouted }) }).publications[0].event)
      .toMatchObject({ messageId: rerouted.id });
    const messages = Array.from({ length: 20 }, (_, index) => noticeMessage(`notice-${index}`, index + 1,
      { systemNotice: { ...notice().systemNotice, kind: "warning", presentation: "timeline", noticeKey: `notice-${index}` } }));
    const items = Object.fromEntries(messages.map((message) => [`message:${message.id}`, item(`message:${message.id}`, { projection: "message", message })]));
    const fresh = prepare(operation({}, notice("Fresh", "fresh")), items);
    expect(fresh.expiredNoticeMessageIds).toEqual(["notice-0"]);
    expect(recorded(fresh).some((record) => record.payload.projection === "noticeStatus")).toBe(true);
    const startup = event({ type: "system", subtype: "provider.session.started",
      systemNotice: { kind: "diagnostic", presentation: "timeline", sessionId: "session-2" } });
    if (startup.type !== "system") throw new Error("Fixture needs a system startup");
    const changed = prepare(operation({ systemIntents: [{ kind: "notice-session", event: startup }] }, startup), items);
    expect(changed.noticeSessionId).toBe("session-2");
    expect(changed.expiredNoticeMessageIds).toHaveLength(20);
    const expiredState = apply(changed, items);
    const subsequent = prepareAcceptedFeatureObservations({ ...base, currentNoticeSessionId: "session-2",
      operation: operation({}, notice("New observation", "notice-0"), "lease:5"), items: expiredState.items });
    expect(subsequent.publications[0].event).not.toMatchObject({ messageId: "notice-0" });
  });

  it("advances compaction and usage effects using accepted state without manufacturing unsupported projections", () => {
    const divider = event({ type: "compacting", active: false });
    const prepared = prepareAcceptedFeatureObservations({ ...base, compaction: { active: true }, operation: operation({}, divider), items: {} });
    expect(prepared.compacting).toBe(false);
    expect(recorded(prepared)[0].payload.message).toMatchObject({ role: "system", content: "Context compacted", sequence: 3 });
    const summary = prepare(operation({}, event({ type: "compactSummary", summary: "Accepted summary" })));
    expect(summary).toMatchObject({ compacting: false, threadPatch: { compactSummary: "Accepted summary" }, events: [] });
    const estimate = event({ type: "contextEstimate", tokensIn: 900, totalProcessedTokens: 1200, contextWindow: 1000 });
    expect(prepare(operation({}, estimate)).threadPatch).toEqual({ contextTokensUsed: 900, contextWindow: 1000 });
    expect(prepareAcceptedFeatureObservations({ ...base, compaction: { active: true }, operation: operation({}, estimate), items: {} }).threadPatch).toBeUndefined();
    const terminal = event({ type: "turnComplete", reason: "done", costUsd: null, tokensIn: 900, tokensOut: 2 });
    expect(() => prepareAcceptedFeatureObservations({ ...base, compaction: { active: true }, operation: operation({}, terminal), items: {} })).toThrow("active compaction");
    const largerSummary = "s".repeat(300 * 1024);
    expect(prepare(operation({}, event({ type: "compactSummary", summary: largerSummary }))).threadPatch?.compactSummary).toBe(largerSummary);
    expect(() => prepare(operation({}, event({ type: "compactSummary", summary: "s".repeat(2 * 1024 * 1024) })))).toThrow("metadata exceeds");
    expect(() => prepare(operation({}, event({ type: "contextEstimate", tokensIn: 1.5, totalProcessedTokens: 10 })))).toThrow("positive safe integer");
  });

  it("keeps ordinary preparations independent of saved history and sanitizes renderer tool input", () => {
    const ownKeys = vi.fn(() => { throw new Error("Ordinary event enumerated history"); });
    const items = new Proxy<Record<string, AgentItem>>({}, { ownKeys });
    const source = event({ type: "toolUse", toolCallId: "call", toolName: "Write",
      toolInput: { file_path: "file.txt", content: "private file body", _mcodeFileMutations: [{ afterText: "private" }] } });
    const prepared = prepare(operation({}, source), items);
    expect(prepared.events).toEqual([]);
    expect(prepared.publications[0].event).toMatchObject({ toolInput: { file_path: "file.txt" } });
    expect(JSON.stringify(prepared)).not.toContain("private");
    expect(ownKeys).not.toHaveBeenCalled();
    expect(prepare({ ...operation(), mutation: { kind: "checkpoint", phase: "running", nativeCursor: null } }, items))
      .toEqual({ events: [], publications: [] });
    const persistedTasks = new Proxy<StoredTask[]>([], { get: () => { throw new Error("Ordinary event read legacy tasks"); } });
    const persistedPlans = new Proxy<PlanVersion[]>([], { get: () => { throw new Error("Ordinary event read legacy plans"); } });
    expect(prepareAcceptedFeatureObservations({ ...base, items, persistedTasks, persistedPlans, operation: operation({}, source) }).events).toEqual([]);
  });

  it("rejects stale hydrated ownership and oversized changed boards without mutating accepted input", () => {
    expect(() => prepareAcceptedFeatureObservations({ ...base, turn: { ...turn, executionId: "00000000-0000-4000-8000-000000000099" }, operation: operation(), items: {} }))
      .toThrow("matching hydrated execution");
    const tasks: StoredTask[] = Array.from({ length: 256 }, (_, index) => ({ content: `${index}:${"x".repeat(12 * 1024)}`, status: "pending" }));
    const op = operation({ taskIntents: [{ kind: "upsert-group", group: "Tasks", tasks }] });
    const snapshot = structuredClone(op);
    expect(() => prepare(op)).toThrow("retention limit");
    expect(op).toEqual(snapshot);
    const longest = prepare({ ...operation({ message: assistant, planOutput: planReady }), operationId: "x".repeat(240) });
    apply(longest);
  });
});
