import {
  CanonicalAgentEventSchema,
  CanonicalAgentSemanticEnvelopeSchema,
  MessageSchema,
  createAgentModelState,
  encodeCanonicalSubagentDetailTarget,
  reduceAgentEventBatch,
  type AgentItem,
  type AgentThread,
  type AgentTurn,
  type ParentNarrativeRecoveryItem,
  type TurnOutcome,
} from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import type { ExecutionSemanticOperation } from "../../execution/execution-worker-handler.js";
import { deriveTurnAssistantMessageId } from "../../turns/turn-assistant-message-id.js";
import type { CanonicalAgentEventDraft } from "../canonical-agent-boundary.js";
import { prepareAcceptedParentEvents } from "../accepted-parent-events.js";

const STARTED_AT = "2026-09-30T10:00:00.000Z";
const ENDED_AT = "2026-09-30T10:00:03.000Z";
const ACCEPTED_AT = "2026-09-30T10:00:04.000Z";
const execution = { threadId: "parent-thread", turnId: "parent-turn", executionId: "00000000-0000-4000-8000-000000000001" };
const thread: AgentThread = {
  id: execution.threadId, workspaceId: "workspace", rootThreadId: execution.threadId,
  providerId: "codex", providerIdentities: [], activityState: "Active",
  conversationRevision: 1, rosterRevision: 0, createdAt: STARTED_AT, updatedAt: STARTED_AT,
};
const turn: AgentTurn = {
  id: execution.turnId, threadId: execution.threadId, executionId: execution.executionId,
  status: "Running", trigger: { kind: "user" }, permissionMode: "supervised",
  approvalReviewMode: "manual", approvalReviewReason: "default", providerIdentities: [],
  startedAt: STARTED_AT, providerStartedAt: null, endedAt: null, createdAt: STARTED_AT, updatedAt: STARTED_AT,
};

function operation(mutation: ExecutionSemanticOperation["mutation"]): ExecutionSemanticOperation {
  return { operationId: "lease:2", execution,
    lease: { leaseId: "lease", ownerEpoch: 1, workerIndex: 0, workerGeneration: 1 }, ordinal: 2, mutation };
}

function prepare(op: ExecutionSemanticOperation, items: Readonly<Record<string, AgentItem>> = {}) {
  return prepareAcceptedParentEvents({ operation: op, thread, turn, items,
    publicationIds: (op.livePublication ?? []).map((_, index) => String(index + 7)),
    messageSequence: 3, acceptedAt: ACCEPTED_AT });
}

function thought(id = "thought", text = "Answer", order = 3): Extract<ParentNarrativeRecoveryItem, { kind: "narrationSegment" }> {
  return { kind: "narrationSegment", record: { id, message_id: "", text,
    started_at: STARTED_AT, ended_at: null, sort_order: order, is_final_response: 0 } };
}

function tool(status: "running" | "completed" = "running"): Extract<ParentNarrativeRecoveryItem, { kind: "toolCall" }> {
  return { kind: "toolCall", record: {
    id: "tool", message_id: "", parent_tool_call_id: "parent-tool", tool_name: "Read",
    display_name: null, provider_agent_key: null, subagent_identity_key: null, subagent_provider_name: null,
    subagent_prompt: null, subagent_type: null, subagent_agent_id: null, subagent_duration_ms: null,
    model: null, reasoning_effort: null, input_summary: "file.txt", output_summary: "",
    output_total_bytes: null, output_artifact_path: null, exit_code: null, status,
    started_at: STARTED_AT, completed_at: status === "completed" ? STARTED_AT : null, sort_order: 1,
  } };
}

function hook(endedAt: string | null = null): Extract<ParentNarrativeRecoveryItem, { kind: "hook" }> {
  return { kind: "hook", record: { id: "hook", message_id: "", hook_name: "Stop", tool_name: null,
    phase: "stop", payload: "{}", duration_ms: endedAt ? 3000 : null, did_block: false,
    started_at: STARTED_AT, ended_at: endedAt, sort_order: 2 } };
}

function recoveryItem(entry: ParentNarrativeRecoveryItem, metadata: Record<string, unknown> = {}): AgentItem {
  return { id: `${entry.kind}:${entry.record.id}`, threadId: thread.id, turnId: turn.id,
    kind: entry.kind === "toolCall" ? "tool-call" : entry.kind === "hook" ? "system" : "reasoning", providerIdentities: [],
    payload: { projection: "narrativeRecovery", narrative: entry, ...metadata },
    createdAt: STARTED_AT, updatedAt: STARTED_AT };
}

function rawDraft(): CanonicalAgentEventDraft {
  return { eventId: "provider:exact-event", routing: { ...execution, itemId: "native-item" },
    sourceProviderId: "codex", sourceIdentities: [], sourceSequence: 11, providerTimestamp: STARTED_AT,
    ingestClass: "volatile", payload: { type: "item.recorded", item: {
      id: "native-item", threadId: thread.id, turnId: turn.id, kind: "system", providerIdentities: [],
      payload: { projection: "providerRuntimeEvent", event: { type: "toolUse" } },
      createdAt: STARTED_AT, updatedAt: STARTED_AT,
    } } };
}

function finish(outcome: TurnOutcome = "completed", narrative: readonly ParentNarrativeRecoveryItem[] = [tool(), hook(), thought()]): ExecutionSemanticOperation {
  return operation({ kind: "finish-live-event", outcome,
    projection: { threadId: thread.id, executionId: execution.executionId, outcome, endedAt: ENDED_AT,
      assistant: { content: "Answer", model: "fixture-model", attachments: [] }, narrative },
    input: { ...execution, providerId: "codex", providerIdentities: [], outcome,
      projection: { kind: "writer-staged" } },
  });
}

function projectedItems(events: readonly CanonicalAgentEventDraft[]): AgentItem[] {
  return events.flatMap((event) => event.payload.type === "item.recorded" ? [event.payload.item] : []);
}

function narrativeItems(narrative: readonly ParentNarrativeRecoveryItem[]): Record<string, AgentItem> {
  return Object.fromEntries(narrative.map((entry) => {
    const item = recoveryItem(entry);
    return [item.id, item];
  }));
}

function applyPrepared(events: readonly CanonicalAgentEventDraft[], items: Readonly<Record<string, AgentItem>> = {}) {
  const initial = { ...createAgentModelState(), threads: { [thread.id]: thread },
    turns: { [turn.id]: turn }, items: { ...items } };
  const envelopes = events.map((event, index) => CanonicalAgentSemanticEnvelopeSchema.parse({
    eventId: event.eventId, routing: event.routing, sourceProviderId: event.sourceProviderId,
    sourceIdentities: event.sourceIdentities, acceptedSequence: index + 1,
    serverTimestamps: { acceptedAt: ACCEPTED_AT }, payload: event.payload,
  }));
  const result = reduceAgentEventBatch(initial, envelopes);
  expect(result.outcome).toBe("applied");
  if (result.outcome !== "applied") throw new Error(`Prepared event rejected: ${result.reason}`);
  return result.state;
}

describe("prepareAcceptedParentEvents", () => {
  it("keeps owned identical commentary and explicit final classification through terminal binding", () => {
    const commentary = thought(`assistant-text:${"a".repeat(64)}`, "Answer", 1);
    const explicitFinal = thought(`assistant-text:${"b".repeat(64)}`, "Answer", 2);
    explicitFinal.record.is_final_response = 1;
    const accepted = narrativeItems([commentary, explicitFinal]);
    const result = prepare(finish("completed", [commentary, explicitFinal]), accepted);
    const state = applyPrepared(result.events, accepted);
    expect(state.items[`narrationSegment:${commentary.record.id}`]?.payload.record)
      .toMatchObject({ text: "Answer", is_final_response: 0 });
    expect(state.items[`narrationSegment:${explicitFinal.record.id}`]?.payload.record)
      .toMatchObject({ text: "Answer", is_final_response: 1 });
    expect(state.turns[turn.id]?.status).toBe("Completed");
  });

  it("records one response text slot for partial deltas, closure, and authoritative full body", () => {
    const append = operation({ kind: "live-event", text: { kind: "append", inputs: [{ ...execution, sequence: 1, text: "Part" }] } });
    const initial = prepare(append);
    const slot = projectedItems(initial.events)[0];
    if (!slot) throw new Error("Missing text recovery");
    expect(slot.payload).toEqual({ projection: "assistantText", content: "Part", isStreaming: true });
    const second = prepare({ ...append, operationId: "lease:3", mutation: { kind: "live-event",
      text: { kind: "append", inputs: [{ ...execution, sequence: 2, text: "ial" }] } } }, { [slot.id]: slot });
    const streamed = projectedItems(second.events)[0];
    if (!streamed) throw new Error("Missing updated recovery");
    expect(streamed.id).toBe(slot.id);
    expect(streamed.payload).toEqual({ projection: "assistantText", content: "Partial", isStreaming: true });
    const closed = prepare({ ...operation({ kind: "live-event", text: { kind: "unchanged" } }), operationId: "lease:4",
      livePublication: [{ after: "writer", event: { type: "assistantMessageBoundary", threadId: thread.id,
        turnExecutionId: execution.executionId, content: "Corrected", isFinalResponse: true } }],
    }, { [streamed.id]: streamed });
    const sealed = projectedItems(closed.events)[0];
    if (!sealed) throw new Error("Missing closed recovery");
    expect(sealed.payload).toEqual({ projection: "assistantText", content: "Corrected", isStreaming: false });
    const body = prepare({ ...operation({ kind: "live-event", text: { kind: "unchanged" },
      message: { precedingMessageId: "user", messageId: "answer", content: "Corrected", model: null, attachments: [] } }),
      operationId: "lease:5" }, { [sealed.id]: sealed });
    const projected = applyPrepared(body.events, { [sealed.id]: sealed });
    expect(projected.items[slot.id]?.payload).toEqual({ projection: "assistantText", content: "Corrected", isStreaming: false });
    expect(Object.values(projected.items).filter((item) => item.payload.projection === "assistantText")).toHaveLength(1);
    expect(projected.turns[turn.id]?.status).toBe("Running");
    expect(Object.values(projected.items).find((item) => item.payload.projection === "message")?.payload.message).toMatchObject({ id: "answer", content: "Corrected" });
    const newAttempt = prepare({ ...append, operationId: "lease:6" }, projected.items);
    expect(projectedItems(newAttempt.events)[0]?.payload).toEqual({ projection: "assistantText", content: "Part", isStreaming: true });
  });

  it("assigns a new recovery identity for a late child target and retains it through repeat preparation and terminal binding", () => {
    const base = tool("completed");
    const entry = { ...base, record: { ...base.record, tool_name: "Agent" } };
    const op = operation({ kind: "narrative-delta", input: { executionId: execution.executionId, items: [entry] } });
    const initial = prepare(op);
    const source = projectedItems(initial.events)[0];
    if (!source) throw new Error("Expected assigned tool recovery");
    const bound = { ...source, payload: { ...source.payload, childThreadId: "child-thread" } };
    const enriched = prepare(op, { [bound.id]: bound });
    const assigned = projectedItems(enriched.events)[0];
    if (!assigned) throw new Error("Expected assigned child recovery");
    expect(enriched.events[0]?.eventId).not.toBe(initial.events[0]?.eventId);
    expect(assigned.payload).toMatchObject({ childThreadId: "child-thread", narrative: { record: {
      subagent_identity_key: encodeCanonicalSubagentDetailTarget("child-thread"),
    } } });
    expect(prepare(op, { [assigned.id]: assigned })).toEqual(enriched);
    const terminal = prepare(finish("completed", [entry]), { [assigned.id]: assigned });
    expect(projectedItems(terminal.events).filter((item) => item.kind === "tool-call")).toEqual([]);
    const state = applyPrepared(terminal.events, { [assigned.id]: assigned });
    expect(state.items[assigned.id]?.payload).toMatchObject({ projection: "toolCall", childThreadId: "child-thread", record: {
      subagent_identity_key: encodeCanonicalSubagentDetailTarget("child-thread"),
    } });
  });

  it("retains raw event identities and routing, prepares recovery changes, and sanitizes renderer tools", () => {
    const raw = rawDraft();
    const discarded = recoveryItem(thought("discarded"));
    const existing = recoveryItem(tool(), { identity: "child", model: "child-model", reasoningEffort: "high" });
    const op = { ...operation({ kind: "append-events", phase: "running", nativeCursor: null, events: [raw],
      parentLive: { text: { kind: "unchanged" }, narrative: { executionId: execution.executionId,
        items: [tool()], discardedItemIds: [discarded.id] } } }),
      livePublication: [{ after: "writer", event: { type: "toolUse", threadId: thread.id,
        turnExecutionId: execution.executionId, toolCallId: "tool", toolName: "Write",
        toolInput: { file_path: "file.txt", content: "private file body" } } }],
    } satisfies ExecutionSemanticOperation;
    const before = structuredClone(op);
    const result = prepare(op, { [discarded.id]: discarded, [existing.id]: existing });

    expect(result.events[0]?.payload).toEqual({ type: "turn.provider-started", at: ACCEPTED_AT });
    expect(result.events[1]).toBe(raw);
    expect(result.events[2]?.payload).toMatchObject({ type: "item.recorded", item: {
      parentItemId: "toolCall:parent-tool", payload: { projection: "narrativeRecovery",
        identity: "child", model: "child-model", reasoningEffort: "high" },
    } });
    expect(result.events[3]?.payload).toMatchObject({ type: "item.recorded", item: {
      id: discarded.id, payload: { projection: "narrativeRecoveryDiscarded" },
    } });
    expect(result.events[4]).toMatchObject({ eventId: "lease:2:publication:0", routing: execution,
      payload: { type: "publication.recorded", publicationId: "7", event: {
        type: "toolUse", toolInput: { file_path: "file.txt" },
      } } });
    expect(op).toEqual(before);
    expect(prepare(op, { [discarded.id]: discarded, [existing.id]: existing })).toEqual(result);
  });

  it("projects accepted live messages with the assigned identity and supplied message ordering", () => {
    const result = prepare(operation({ kind: "live-event", text: { kind: "unchanged" },
      message: { precedingMessageId: "user", messageId: "live-assistant", content: "Plan body",
        model: "fixture-model", attachments: [] } }));
    const item = projectedItems(result.events)[0];
    expect(item?.payload).toEqual({ projection: "message", message: {
      id: "live-assistant", thread_id: thread.id, role: "assistant", content: "Plan body",
      is_internal: true,
      timestamp: ACCEPTED_AT, sequence: 3, model: "fixture-model", attachments: [],
      tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null,
    } });
    expect(result.terminalMessage).toBeUndefined();
  });

  it("keeps an assigned live assistant internal until the same message becomes terminal", () => {
    const live = prepare(operation({ kind: "live-event", text: { kind: "unchanged" },
      message: { precedingMessageId: "user", messageId: "assigned", content: "Plan body",
        model: "fixture-model", attachments: [] } }));
    const item = projectedItems(live.events)[0];
    if (!item) throw new Error("Expected live assistant");
    expect(item.payload.message).toMatchObject({ id: "assigned", content: "Plan body", is_internal: true });
    const op = finish("completed", []);
    if (op.mutation.kind !== "finish-live-event") throw new Error("Expected terminal fixture");
    const terminal = prepare({ ...op, mutation: { ...op.mutation, projection: { ...op.mutation.projection,
      assistant: { ...op.mutation.projection.assistant, messageId: "assigned" } } } }, { [item.id]: item });
    expect(terminal.terminalMessage).toMatchObject({ id: "assigned", content: "Answer", is_internal: false,
      outcome: "completed", outcomeExecutionId: execution.executionId });
    expect(applyPrepared(terminal.events, { [item.id]: item }).items[item.id]?.payload.message)
      .toEqual(terminal.terminalMessage);
    expect(item.payload.message).toMatchObject({ is_internal: true });
    expect(terminal.storageOperation?.mutation).toMatchObject({ kind: "finish-live-event",
      projection: { assistant: { messageId: "assigned" } }, input: { projection: { kind: "writer-staged", messageId: "assigned" } } });
  });

  it("preserves an assigned assistant's original ordering and timestamp across later content and terminal updates", () => {
    const op = operation({ kind: "live-event", text: { kind: "unchanged" },
      message: { precedingMessageId: "user", messageId: "assigned", content: "First", model: null, attachments: [] } });
    const initial = projectedItems(prepare(op).events)[0];
    if (!initial) throw new Error("Expected assigned assistant");
    const updated = prepareAcceptedParentEvents({ operation: { ...op, operationId: "lease:3" }, thread, turn,
      items: { [initial.id]: initial }, publicationIds: [], messageSequence: 10, acceptedAt: ENDED_AT });
    expect(projectedItems(updated.events)[0]?.payload.message).toMatchObject({ id: "assigned", sequence: 3, timestamp: ACCEPTED_AT });
    const terminalOperation = finish("completed", []);
    if (terminalOperation.mutation.kind !== "finish-live-event") throw new Error("Expected terminal fixture");
    const terminal = prepare({ ...terminalOperation, mutation: { ...terminalOperation.mutation,
      projection: { ...terminalOperation.mutation.projection, assistant: { ...terminalOperation.mutation.projection.assistant,
        messageId: "assigned" } } } }, { [initial.id]: initial });
    expect(terminal.terminalMessage).toMatchObject({ id: "assigned", sequence: 3, timestamp: ACCEPTED_AT, content: "Answer" });
    const otherTurn = { ...initial, turnId: "another-turn" };
    expect(() => prepare(op, { [initial.id]: otherTurn })).toThrow("different message");
  });

  it("prepares narrative-only deltas and rejects an unknown discarded item", () => {
    const result = prepare(operation({ kind: "narrative-delta", input: {
      executionId: execution.executionId, items: [thought()],
    } }));
    expect(result.events[0]?.eventId).toMatch(/^narrative:/);
    expect(projectedItems(result.events)[0]?.payload.projection).toBe("narrativeRecovery");
    expect(() => prepare(operation({ kind: "narrative-delta", input: {
      executionId: execution.executionId, items: [], discardedItemIds: ["missing"],
    } }))).toThrow("Canonical narrative recovery item was not found");
  });

  it.each([
    { outcome: "completed", type: "turn.completed", status: "completed", turnStatus: "Completed" },
    { outcome: "cancelled", type: "turn.cancelled", status: "cancelled", turnStatus: "Cancelled" },
    { outcome: "interrupted", type: "turn.interrupted", status: "failed", turnStatus: "Interrupted" },
    { outcome: "errored", type: "turn.errored", status: "failed", turnStatus: "Errored" },
  ] satisfies { outcome: TurnOutcome; type: string; status: string; turnStatus: string }[])("binds and settles $outcome accepted history without replaying a tool", ({ outcome, type, status, turnStatus }) => {
    const op = finish(outcome);
    if (op.mutation.kind !== "finish-live-event") throw new Error("Expected terminal fixture");
    const accepted = narrativeItems(op.mutation.projection.narrative);
    const before = structuredClone(op);
    const acceptedBefore = structuredClone(accepted);
    const result = prepare(op, accepted);
    const messageId = deriveTurnAssistantMessageId(thread.id, `execution:${execution.executionId}`);
    expect(result.terminalMessage).toMatchObject({ id: messageId, content: "Answer",
      timestamp: ACCEPTED_AT, sequence: 3, outcome, outcomeExecutionId: execution.executionId,
      tool_call_count: 1 });
    expect(MessageSchema().safeParse(result.terminalMessage).success).toBe(true);
    expect(projectedItems(result.events)).toHaveLength(1);
    expect(result.events[1]).toMatchObject({ eventId: "lease:2:response-bound", routing: execution,
      payload: { type: "turn.response-bound", messageId, outcome, endedAt: ENDED_AT } });
    const state = applyPrepared(result.events, accepted);
    const items = Object.values(state.items);
    expect(items).toHaveLength(4);
    expect(items.find((item) => item.id === "toolCall:tool")?.payload).toMatchObject({
      projection: "toolCall", record: { message_id: messageId, status, completed_at: ENDED_AT },
    });
    expect(items.find((item) => item.id === "hook:hook")?.payload).toMatchObject({
      projection: "hook", record: { message_id: messageId, duration_ms: 3000, ended_at: ENDED_AT },
    });
    expect(items.find((item) => item.id === "narrationSegment:thought")?.payload).toMatchObject({
      projection: "narrationSegment", record: { message_id: messageId, is_final_response: 1 },
    });
    expect(result.events.at(-1)).toMatchObject({ eventId: `${execution.executionId}:${type}`,
      routing: execution, payload: { type, endedAt: ENDED_AT } });
    expect(result.events.every((event) => CanonicalAgentEventSchema.safeParse(event.payload).success)).toBe(true);
    expect(state.turns[turn.id]?.status).toBe(turnStatus);
    expect(state.turns[turn.id]?.endedAt).toBe(ENDED_AT);
    expect(result.storageOperation?.mutation).toMatchObject({ kind: "finish-live-event",
      projection: { narrative: [], assistant: { messageId, content: "Answer" } },
      input: { projection: { kind: "writer-staged", messageId } } });
    expect(op).toEqual(before);
    expect(accepted).toEqual(acceptedBefore);
    expect(prepare(op, accepted)).toEqual(result);
  });

  it("preserves completed tool and hook evidence and uses an assigned terminal assistant ID", () => {
    const op = finish("errored", [tool("completed"), hook(ENDED_AT), thought("older", "Before", 1), thought()]);
    if (op.mutation.kind !== "finish-live-event") throw new Error("Expected terminal fixture");
    const result = prepare({ ...op, mutation: { ...op.mutation,
      projection: { ...op.mutation.projection, assistant: { ...op.mutation.projection.assistant, messageId: "assigned" } },
      input: { ...op.mutation.input, error: "Provider failed", projection: { kind: "writer-staged", messageId: "stale-writer-id" } },
    } });
    expect(result.terminalMessage?.id).toBe("assigned");
    expect(result.storageOperation?.mutation).toMatchObject({ kind: "finish-live-event",
      projection: { assistant: { messageId: "assigned" } },
      input: { projection: { kind: "writer-staged", messageId: "assigned" } } });
    const items = Object.values(applyPrepared(result.events).items);
    expect(items.find((item) => item.id === "toolCall:tool")?.payload.record).toMatchObject({
      status: "completed", completed_at: STARTED_AT,
    });
    expect(items.find((item) => item.id === "hook:hook")?.payload.record).toMatchObject({ duration_ms: 3000 });
    expect(items.find((item) => item.id === "narrationSegment:older")?.payload.record).toMatchObject({ is_final_response: 0 });
    expect(result.events.at(-1)?.payload).toEqual({ type: "turn.errored", endedAt: ENDED_AT, error: "Provider failed" });
  });

  it("retains complete new source records before binding and keeps raw and publication ordering", () => {
    const op = finish();
    if (op.mutation.kind !== "finish-live-event") throw new Error("Expected terminal fixture");
    const raw = rawDraft();
    const terminal = { ...op, mutation: { ...op.mutation,
      providerEvent: { phase: "ended", nativeCursor: null, events: [raw] } },
      livePublication: [{ after: "terminal", event: { type: "hookCompleted", threadId: thread.id,
        turnExecutionId: execution.executionId, hookName: "Stop", durationMs: 3000, didBlock: false } }],
    } satisfies ExecutionSemanticOperation;
    const result = prepare(terminal);
    const records = projectedItems(result.events).filter((item) => item.payload.projection === "narrativeRecovery");
    expect(records.map((item) => item.payload.narrative)).toEqual(op.mutation.projection.narrative);
    expect(result.events[0]).toBe(raw);
    expect(result.events[4]?.payload.type).toBe("item.recorded");
    expect(result.events[5]?.payload.type).toBe("turn.response-bound");
    expect(result.events[6]?.payload).toEqual({ type: "turn.completed", endedAt: ENDED_AT });
    expect(result.events[7]).toMatchObject({ eventId: "lease:2:publication:0",
      payload: { type: "publication.recorded", publicationId: "7" } });
    expect(result.storageOperation?.mutation).toMatchObject({ kind: "finish-live-event",
      projection: { narrative: op.mutation.projection.narrative } });
    const state = applyPrepared(result.events);
    expect(state.items["toolCall:tool"]?.payload.record).toMatchObject({ status: "completed", completed_at: ENDED_AT });
    expect(state.items["hook:hook"]?.payload.record).toMatchObject({ ended_at: ENDED_AT, duration_ms: 3000 });
    expect(state.items["narrationSegment:thought"]?.payload.record).toMatchObject({ is_final_response: 1 });
  });

  it("prepares a bounded terminal tail over 5,000 accepted tools and binds the entire history", () => {
    const template = tool("completed");
    const tools: ParentNarrativeRecoveryItem[] = Array.from({ length: 5000 }, (_, index) => ({
      ...template, record: { ...template.record, id: `tool-${index}`, sort_order: index,
        output_summary: `Completed output ${index}`, exit_code: 0 },
    }));
    const earlier = thought("earlier", "Before", 5000);
    const revised = thought("earlier", "Before revised", 5000);
    const final = thought("final", "Answer", 5001);
    const accepted = narrativeItems(structuredClone([...tools, earlier]));
    const child = accepted["toolCall:tool-4999"];
    if (!child) throw new Error("Expected accepted child tool");
    accepted[child.id] = { ...child, payload: { ...child.payload, identity: "child", model: "child-model" } };
    const source = [...tools, revised, final];
    const op = finish("completed", source);
    const result = prepare(op, accepted);
    const messageId = deriveTurnAssistantMessageId(thread.id, `execution:${execution.executionId}`);

    expect(result.events).toHaveLength(5);
    expect(projectedItems(result.events).map((item) => item.id)).toEqual([
      "narrationSegment:earlier", "narrationSegment:final", `message:${messageId}`,
    ]);
    expect(result.terminalMessage).toMatchObject({ id: messageId, content: "Answer", tool_call_count: 5000,
      timestamp: ACCEPTED_AT, sequence: 3, outcome: "completed", outcomeExecutionId: execution.executionId });
    const storage = result.storageOperation;
    if (storage?.mutation.kind !== "finish-live-event") throw new Error("Expected retained terminal write");
    expect(storage.mutation.projection.narrative).toEqual([revised, final]);
    expect(storage.mutation.projection.assistant).toEqual({ content: "Answer", model: "fixture-model", attachments: [], messageId });
    expect(storage.mutation.input.projection).toEqual({ kind: "writer-staged", messageId });
    expect(JSON.stringify(storage).length).toBeLessThan(2000);

    const state = applyPrepared(result.events, accepted);
    expect(Object.values(state.items)).toHaveLength(5003);
    for (const entry of tools) {
      expect(state.items[`toolCall:${entry.record.id}`]?.payload).toMatchObject({ projection: "toolCall",
        record: { ...entry.record, message_id: messageId } });
    }
    expect(state.items[child.id]?.payload).toMatchObject({ identity: "child", model: "child-model" });
    expect(state.items["narrationSegment:earlier"]?.payload.record).toMatchObject({ text: "Before revised", is_final_response: 0, message_id: messageId });
    expect(state.items["narrationSegment:final"]?.payload.record).toMatchObject({ text: "Answer", is_final_response: 1, message_id: messageId });
    expect(state.turns[turn.id]).toMatchObject({ status: "Completed", endedAt: ENDED_AT });
    expect(accepted["narrationSegment:earlier"]?.payload.narrative).toEqual(earlier);
    expect(source[0]).toMatchObject({ record: { message_id: "" } });
    expect(op.mutation).toMatchObject({ kind: "finish-live-event", projection: { narrative: source } });
  });

  it("compares recovery and normal source projections and preserves changed tool metadata", () => {
    const original = tool("completed");
    const changed: ParentNarrativeRecoveryItem = { ...original, record: { ...original.record, output_summary: "New output" } };
    const existing = recoveryItem(original, { identity: "child", model: "child-model", reasoningEffort: "high" });
    const sourceThought = thought("saved", "Before", 1);
    const normalThought = { ...sourceThought, record: { ...sourceThought.record,
      message_id: deriveTurnAssistantMessageId(thread.id, `execution:${execution.executionId}`) } };
    const saved = recoveryItem(normalThought);
    const normal = { ...saved, payload: { projection: normalThought.kind, record: normalThought.record } };
    const result = prepare(finish("completed", [changed, normalThought]), { [existing.id]: existing, [normal.id]: normal });
    const records = projectedItems(result.events).filter((item) => item.payload.projection === "narrativeRecovery");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: existing.id, parentItemId: "toolCall:parent-tool", payload: {
      narrative: changed, identity: "child", model: "child-model", reasoningEffort: "high",
    } });
    expect(result.storageOperation?.mutation).toMatchObject({ kind: "finish-live-event", projection: { narrative: [changed] } });
  });

  it("records the provider start before a terminal frame that is also the first frame", () => {
    const op = { ...finish("completed", []), livePublication: [{ after: "terminal" as const,
      event: { type: "turnComplete" as const, threadId: thread.id, reason: "end_turn",
        costUsd: null, tokensIn: 1, tokensOut: 1 } }] } satisfies ExecutionSemanticOperation;
    const result = prepare(op);

    expect(result.events[0]).toMatchObject({ eventId: `${execution.executionId}:provider-started`, routing: execution,
      payload: { type: "turn.provider-started", at: ACCEPTED_AT } });
    const state = applyPrepared(result.events);
    expect(state.turns[turn.id]).toMatchObject({ status: "Completed", providerStartedAt: ACCEPTED_AT });
  });

  it("does not treat a synthesized turn start, session noise, or pre-answer Claude frames as the provider answering", () => {
    const op = { ...operation({ kind: "checkpoint", phase: "running", nativeCursor: null }),
      livePublication: [
        { after: "writer" as const, event: { type: "turnStarted" as const, threadId: thread.id } },
        { after: "writer" as const, event: { type: "system" as const, threadId: thread.id, subtype: "init" } },
        { after: "writer" as const, event: { type: "hookStarted" as const, threadId: thread.id,
          hookName: "SessionStart", hookType: "permission" as const } },
        { after: "writer" as const, event: { type: "rateLimited" as const, threadId: thread.id, active: false } },
        { after: "writer" as const, event: { type: "assistantMessageBoundary" as const, threadId: thread.id,
          isFinalResponse: true } },
      ] } satisfies ExecutionSemanticOperation;

    expect(prepare(op).events.map((event) => event.payload.type)).not.toContain("turn.provider-started");
  });

  it("records the provider start only while the turn has none", () => {
    const op = { ...operation({ kind: "checkpoint", phase: "running", nativeCursor: null }),
      livePublication: [{ after: "writer" as const, event: { type: "textDelta" as const, threadId: thread.id,
        delta: "Hi" } }] } satisfies ExecutionSemanticOperation;
    const started = prepareAcceptedParentEvents({ operation: op, thread, turn: { ...turn, providerStartedAt: STARTED_AT },
      items: {}, publicationIds: ["7"], messageSequence: 3, acceptedAt: ACCEPTED_AT });

    expect(started.events.map((event) => event.payload.type)).not.toContain("turn.provider-started");
  });

  it("finishes an empty turn without inventing an assistant message", () => {
    const op = finish("completed", []);
    if (op.mutation.kind !== "finish-live-event") throw new Error("Expected terminal fixture");
    const result = prepare({ ...op, mutation: { ...op.mutation, projection: {
      ...op.mutation.projection, assistant: { content: "  ", model: null, attachments: [] },
    } } });
    expect(result.terminalMessage).toBeUndefined();
    expect(projectedItems(result.events)).toHaveLength(0);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.payload).toEqual({ type: "turn.response-bound", outcome: "completed",
      messageId: deriveTurnAssistantMessageId(thread.id, `execution:${execution.executionId}`), endedAt: ENDED_AT });
    expect(result.events[1]?.payload).toEqual({ type: "turn.completed", endedAt: ENDED_AT });
    const state = applyPrepared(result.events);
    expect(state.items).toEqual({});
    expect(state.turns[turn.id]?.status).toBe("Completed");
  });

  it("links a post-terminal completed hook to its accepted assistant and preserves provider evidence", () => {
    const terminal = prepare(finish());
    const assistant = projectedItems(terminal.events).find((item) => item.kind === "message");
    if (!assistant || !terminal.terminalMessage) throw new Error("Expected assistant fixture");
    const raw = rawDraft();
    const op = { ...operation({ kind: "post-terminal-event", hooks: [hook(ENDED_AT)],
      providerEvent: { phase: "ended", nativeCursor: null, events: [raw] } }),
      livePublication: [{ after: "terminal", event: { type: "hookCompleted", threadId: thread.id,
        turnExecutionId: execution.executionId, hookName: "Stop", durationMs: 3000, didBlock: false } }],
    } satisfies ExecutionSemanticOperation;
    const result = prepare(op, { [assistant.id]: assistant });
    expect(result.events[0]).toBe(raw);
    expect(projectedItems(result.events).find((item) => item.id === "hook:hook")?.payload.record)
      .toMatchObject({ message_id: terminal.terminalMessage.id, ended_at: ENDED_AT });
    expect(result.events.at(-1)?.payload).toMatchObject({ type: "publication.recorded", event: {
      persistedMessageId: terminal.terminalMessage.id, persistedHookId: "hook",
    } });
    expect(() => prepare(op)).toThrow("requires its terminal assistant message");
  });

  it("records no-effect controls explicitly and rejects mismatched acceptance context", () => {
    const op = operation({ kind: "effect-result", effectId: "effect", settled: true });
    expect(prepare(op).events).toEqual([{ eventId: "lease:2:checkpoint", routing: execution,
      sourceProviderId: "codex", sourceIdentities: [],
      payload: { type: "execution.checkpoint", operationKind: "effect-result" } }]);
    expect(() => prepareAcceptedParentEvents({ operation: op, thread, turn: { ...turn, executionId: "other" },
      items: {}, publicationIds: [], messageSequence: 3, acceptedAt: ACCEPTED_AT }))
      .toThrow("matching hydrated execution state");
    expect(() => prepareAcceptedParentEvents({ operation: op, thread, turn,
      items: {}, publicationIds: ["7"], messageSequence: 3, acceptedAt: ACCEPTED_AT }))
      .toThrow("must match their reserved publication IDs");
  });

  it("rejects an operation above its finite event limit before preparing raw drafts", () => {
    const op = operation({ kind: "append-events", phase: "running", nativeCursor: null,
      events: Array.from({ length: 8193 }, rawDraft) });
    expect(() => prepare(op)).toThrow("exceeds its event limit");
  });
});
