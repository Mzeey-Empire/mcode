import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createAgentModelState, reduceAgentEventBatch, type CanonicalAgentEventEnvelope, type Message, type TurnSavingStatus } from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import {
  resetThreadStoreForTests,
  seedThreadRecord,
  readThreadField,
} from "@/stores/thread-store-test-utils";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_EXECUTION_ID = "00000000-0000-4000-8000-000000000099";
const NOW = "2026-08-11T12:00:00.000Z";

function envelope(
  eventId: string,
  acceptedSequence: number,
  executionId: string,
  payload: CanonicalAgentEventEnvelope["payload"],
): CanonicalAgentEventEnvelope {
  return {
    eventId,
    routing: {
      threadId: THREAD_ID,
      turnId: payload.type === "thread.recorded" ? undefined : TURN_ID,
      itemId: payload.type === "item.recorded" ? payload.item.id : undefined,
      executionId,
    },
    sourceProviderId: "codex",
    sourceIdentities: [],
    acceptedSequence,
    durableRevision: acceptedSequence,
    serverTimestamps: { acceptedAt: NOW, persistedAt: NOW },
    payload,
  };
}

function turnEvents(executionId: string, terminal?: "completed" | "interrupted"): CanonicalAgentEventEnvelope[] {
  const events: CanonicalAgentEventEnvelope[] = [
    envelope("e1", 1, executionId, {
      type: "thread.recorded",
      thread: {
        id: THREAD_ID,
        workspaceId: "workspace-1",
        rootThreadId: THREAD_ID,
        providerId: "codex",
        providerIdentities: [],
        activityState: "Active",
        conversationRevision: 1,
        rosterRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    envelope("e2", 2, executionId, {
      type: "turn.created",
      turn: {
        id: TURN_ID,
        threadId: THREAD_ID,
        status: "Pending",
        trigger: { kind: "user" },
        permissionMode: "full",
        approvalReviewMode: "manual",
        approvalReviewReason: "manual-requested",
        providerIdentities: [],
        startedAt: null, providerStartedAt: null,
        endedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    envelope("e3", 3, executionId, { type: "turn.started", startedAt: NOW }),
  ];
  if (terminal === "completed") {
    events.push(envelope("e4", 4, executionId, { type: "turn.completed", endedAt: NOW }));
  } else if (terminal === "interrupted") {
    events.push(envelope("e4", 4, executionId, { type: "turn.interrupted", endedAt: NOW, reason: "restart" }));
  }
  return events;
}

function seedRuntime(phase: "running" | "idle", turnExecutionId: string | null, running: boolean) {
  useThreadStore.setState({
    records: seedThreadRecord(THREAD_ID, { runtimePhase: phase, turnExecutionId }),
    runningThreadIds: running ? new Set([THREAD_ID]) : new Set(),
  });
}

function promptAdmission(prompt: Message): CanonicalAgentEventEnvelope[] {
  return [...turnEvents(EXECUTION_ID), envelope("user-message", 4, EXECUTION_ID, {
    type: "item.recorded", item: { id: `message:${prompt.id}`, threadId: THREAD_ID, turnId: TURN_ID,
      kind: "message", providerIdentities: [], createdAt: NOW, updatedAt: NOW,
      payload: { projection: "message", message: prompt } },
  })];
}

async function sendOptimisticPrompt(content: string): Promise<Message> {
  vi.mocked(mockTransport.sendMessage).mockResolvedValueOnce(undefined);
  expect(await useThreadStore.getState().sendMessage(THREAD_ID, content)).toBe(true);
  const prompt = readThreadField(THREAD_ID, (record) => record.messages.at(-1));
  if (!prompt || prompt.role !== "user") throw new Error("missing optimistic prompt");
  return prompt;
}

function pendingSave(accepted: number, saved: number): TurnSavingStatus {
  return { threadId: THREAD_ID, executionId: EXECUTION_ID, mode: "saving",
    accepted: { epoch: "runtime-1", sequence: accepted }, saved: { epoch: "runtime-1", sequence: saved },
    pendingEvents: accepted - saved, pendingBytes: 128, oldestPendingAt: NOW };
}

describe("canonical runtime reconciliation", () => {
  beforeEach(() => {
    clearRecordCache();
    resetThreadStoreForTests();
    vi.clearAllMocks();
    vi.mocked(mockTransport.sendMessage).mockReset();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("restores partial final text and a closed full answer while its native turn remains active", () => {
    const textSlot = (content: string, isStreaming: boolean) => ({ id: `assistant-response-text:${EXECUTION_ID}`,
      threadId: THREAD_ID, turnId: TURN_ID, kind: "message", providerIdentities: [], createdAt: NOW, updatedAt: NOW,
      payload: { projection: "assistantText", content, isStreaming } } satisfies import("@mcode/contracts").AgentItem);
    const prompt: Message = { id: "admitted-prompt", thread_id: THREAD_ID, role: "user", content: "Prompt",
      timestamp: NOW, sequence: 1, attachments: null, cost_usd: null, tokens_used: null, tool_calls: null, files_changed: null };
    const partial = [...promptAdmission(prompt), envelope("partial", 5, EXECUTION_ID, {
      type: "item.recorded", item: textSlot("Partial answer", true) })];
    const reduced = reduceAgentEventBatch(createAgentModelState(), partial);
    if (reduced.outcome !== "applied") throw new Error("Invalid partial fixture");
    seedRuntime("running", EXECUTION_ID, true);
    useThreadStore.getState().applyCanonicalReconnectRecoveries([{ mode: "snapshot", threadId: THREAD_ID,
      snapshot: { revision: { conversationRevision: 5, rosterRevision: 0 }, state: reduced.state } }]);
    expect(readThreadField(THREAD_ID, (record) => record.streaming)).toBe("Partial answer");
    expect(readThreadField(THREAD_ID, (record) => record.responseTextIsStreaming)).toBe(true);
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(true);
    const response: Message = { id: "closed-answer", thread_id: THREAD_ID, role: "assistant", content: "Authoritative answer",
      timestamp: NOW, sequence: 2, attachments: null, cost_usd: null, tokens_used: null, tool_calls: null, files_changed: null };
    const closed = [envelope("closed", 6, EXECUTION_ID, { type: "item.recorded", item: textSlot(response.content, false) }),
      envelope("closed-message", 7, EXECUTION_ID, { type: "item.recorded", item: { id: "message:closed-answer",
        threadId: THREAD_ID, turnId: TURN_ID, kind: "message", providerIdentities: [], createdAt: NOW, updatedAt: NOW,
        payload: { projection: "message", message: response } } })];
    const boundary = closed[0]; const message = closed[1];
    if (!boundary || !message) throw new Error("Missing closed fixture");
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, [boundary]);
    expect(readThreadField(THREAD_ID, (record) => record.streaming)).toBe(response.content);
    expect(readThreadField(THREAD_ID, (record) => record.responseTextIsStreaming)).toBe(false);
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, [message]);
    expect(readThreadField(THREAD_ID, (record) => record.streaming)).toBe("");
    expect(readThreadField(THREAD_ID, (record) => record.responseTextIsStreaming)).toBe(false);
    expect(readThreadField(THREAD_ID, (record) => record.messages)).toContainEqual(response);
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(true);
    const reopened = envelope("next-final", 8, EXECUTION_ID, { type: "item.recorded", item: textSlot("Next final item", true) });
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, [reopened]);
    expect(readThreadField(THREAD_ID, (record) => record.streaming)).toBe("Next final item");
    expect(readThreadField(THREAD_ID, (record) => record.responseTextIsStreaming)).toBe(true);
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, [envelope("done", 9, EXECUTION_ID, { type: "turn.completed", endedAt: NOW })]);
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
  });

  it("clears the last discarded keyed narration from an owning snapshot without erasing unrelated tools", () => {
    const id = `assistant-text:${"a".repeat(64)}`;
    const events = [...turnEvents(EXECUTION_ID), envelope("discarded", 4, EXECUTION_ID, { type: "item.recorded", item: {
      id: `narrationSegment:${id}`, threadId: THREAD_ID, turnId: TURN_ID, kind: "reasoning", providerIdentities: [], createdAt: NOW, updatedAt: NOW,
      payload: { projection: "narrativeRecoveryDiscarded", narrative: { kind: "narrationSegment", record: {
        id, message_id: "", text: "Final", started_at: NOW, ended_at: NOW, sort_order: 0, is_final_response: 0 } } },
    } })];
    const reduced = reduceAgentEventBatch(createAgentModelState(), events);
    if (reduced.outcome !== "applied") throw new Error("Invalid discarded fixture");
    seedRuntime("running", EXECUTION_ID, true);
    useThreadStore.setState({ records: seedThreadRecord(THREAD_ID, {
      thoughtSegments: [{ id, text: "Final", startedAt: 1, endedAt: 2 }],
      toolCalls: [{ id: "unrelated-tool", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false }],
    }) });
    useThreadStore.getState().applyCanonicalReconnectRecoveries([{ mode: "snapshot", threadId: THREAD_ID,
      snapshot: { revision: { conversationRevision: 4, rosterRevision: 0 }, state: reduced.state } }]);
    expect(readThreadField(THREAD_ID, (record) => record.thoughtSegments)).toEqual([]);
    expect(readThreadField(THREAD_ID, (record) => record.toolCalls)).toHaveLength(1);
  });

  it("clears a stale running flag when the correlated canonical turn terminates", () => {
    seedRuntime("running", EXECUTION_ID, true);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID, "completed"));

    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("completed");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
  });

  it("settles a recovered first turn whose terminal arrived before its stale running snapshot", () => {
    useThreadStore.setState({ records: seedThreadRecord("placeholder-1", { runtimePhase: "running", turnExecutionId: null }) });
    useThreadStore.setState({
      records: seedThreadRecord(THREAD_ID, { runtimePhase: "idle", turnExecutionId: null }),
      runningThreadIds: new Set(["placeholder-1"]),
    });
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID, "completed"));

    useThreadStore.getState().applyThreadRuntimeSnapshot({ threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, phase: "running" });
    useThreadStore.getState().transferThreadRuntime("placeholder-1", THREAD_ID);

    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("completed");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
  });

  it("lets canonical claim and then settle a recovered first turn with no runtime snapshot", () => {
    useThreadStore.setState({
      records: seedThreadRecord("placeholder-1", { runtimePhase: "running", turnExecutionId: null }),
      runningThreadIds: new Set(["placeholder-1"]),
    });

    useThreadStore.getState().transferThreadRuntime("placeholder-1", THREAD_ID, { runtimeKnown: false });
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID));
    expect(readThreadField(THREAD_ID, (r) => [r.runtimePhase, r.turnExecutionId])).toEqual(["running", EXECUTION_ID]);
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(true);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, [envelope("e4", 4, EXECUTION_ID, { type: "turn.completed", endedAt: NOW })]);
    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("completed");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
  });

  it("claims an idle record when canonical reports a running turn", () => {
    seedRuntime("idle", null, false);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID));

    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("running");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(true);
  });

  it("keeps the optimistic running window while no canonical turn correlates", () => {
    seedRuntime("running", null, true);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID, "completed"));

    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("running");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(true);
  });

  it("correlates saved-only admission to its exact optimistic prompt without replaying effects", async () => {
    seedRuntime("idle", null, false);
    useThreadStore.setState({ currentThreadId: THREAD_ID });
    const prompt = await sendOptimisticPrompt("Measured prompt");
    const dispatch = vi.spyOn(useThreadStore.getState(), "handleAgentEvent");
    const epoch = "saved-admission";
    useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId: THREAD_ID, epoch, through: 0,
      revision: { conversationRevision: 4, rosterRevision: 0 }, events: promptAdmission(prompt) });
    useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId: THREAD_ID, epoch, through: 0,
      revision: { conversationRevision: 5, rosterRevision: 0 }, events: [envelope("saved-start", 5, EXECUTION_ID, {
        type: "publication.recorded", publicationId: "2", event: { type: "turnStarted", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID },
      })] });
    expect(dispatch).not.toHaveBeenCalled();
    expect(readThreadField(THREAD_ID, (record) => record.turnExecutionId)).toBe(EXECUTION_ID);
    expect(readThreadField(THREAD_ID, (record) => record.optimisticUserMessageId)).toBeNull();
    const events = [
      envelope("live-tool", 6, EXECUTION_ID, { type: "publication.recorded", publicationId: "3",
        event: { type: "toolUse", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, toolCallId: "open-tool", toolName: "Bash", toolInput: { command: "measured command" } } }),
      envelope("interrupted", 7, EXECUTION_ID, { type: "turn.interrupted", endedAt: NOW, reason: "Turn interrupted" }),
      envelope("worker-lost", 8, EXECUTION_ID, { type: "publication.recorded", publicationId: "12",
        event: { type: "ended", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, outcome: "interrupted" } }),
    ].map(({ durableRevision: _durableRevision, ...event }, index) => ({ ...event, progressPosition: { epoch, sequence: index + 1 } }));
    useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: THREAD_ID, epoch, from: 0, through: 3, events });
    expect(readThreadField(THREAD_ID, (record) => record.runtimePhase)).toBe("interrupted");
    expect(readThreadField(THREAD_ID, (record) => record.toolCalls)).toMatchObject([{ id: "open-tool", isComplete: true, isError: true }]);
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("preserves a newer optimistic prompt across an older terminal recovery with identical text", async () => {
    seedRuntime("idle", null, false);
    useThreadStore.setState({ currentThreadId: THREAD_ID });
    const olderPrompt = await sendOptimisticPrompt("Repeated prompt");
    useThreadStore.getState().applyThreadRuntimeSnapshot({ threadId: THREAD_ID, phase: "completed", turnExecutionId: EXECUTION_ID, savingStatus: null });
    const newerPrompt = await sendOptimisticPrompt("Repeated prompt");
    expect(newerPrompt.id).not.toBe(olderPrompt.id);
    useThreadStore.getState().handleAgentEvent({ type: "textDelta", threadId: THREAD_ID, delta: "Newer in flight", isFinalResponse: true });
    const response: Message = { ...olderPrompt, id: "older-response", role: "assistant", content: "Older response", sequence: 2 };
    const olderEvents = [...promptAdmission(olderPrompt), envelope("old-response", 5, EXECUTION_ID, {
      type: "item.recorded", item: { id: "old-response", threadId: THREAD_ID, turnId: TURN_ID, kind: "message", providerIdentities: [],
        payload: { projection: "message", message: response }, createdAt: NOW, updatedAt: NOW },
    }), envelope("old-interrupted", 6, EXECUTION_ID,
      { type: "turn.interrupted", endedAt: NOW, reason: "Turn interrupted" })];
    const reduced = reduceAgentEventBatch(createAgentModelState(), olderEvents);
    if (reduced.outcome === "rejected") throw new Error("invalid older admission");
    useThreadStore.getState().handleCanonicalProgress({ phase: "recovery", threadId: THREAD_ID, epoch: "older-prompt",
      acceptedThrough: 0, savedThrough: 0, retained: [], loss: "none", durable: { mode: "snapshot", threadId: THREAD_ID,
        snapshot: { revision: { conversationRevision: 6, rosterRevision: 0 }, state: reduced.state } } });
    expect(readThreadField(THREAD_ID, (record) => record.runtimePhase)).toBe("running");
    expect(readThreadField(THREAD_ID, (record) => record.turnExecutionId)).toBeNull();
    expect(readThreadField(THREAD_ID, (record) => record.optimisticUserMessageId)).toBe(newerPrompt.id);
    expect(readThreadField(THREAD_ID, (record) => record.streaming)).toBe("Newer in flight");
    expect(readThreadField(THREAD_ID, (record) => record.currentTurnMessageId)).toBe("");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(true);
  });

  it("correlates a matching prompt when recovery already contains its terminal", async () => {
    seedRuntime("idle", null, false);
    useThreadStore.setState({ currentThreadId: THREAD_ID });
    const prompt = await sendOptimisticPrompt("Completed before recovery");
    const reduced = reduceAgentEventBatch(createAgentModelState(), [...promptAdmission(prompt),
      envelope("completed", 5, EXECUTION_ID, { type: "turn.completed", endedAt: NOW })]);
    if (reduced.outcome === "rejected") throw new Error("invalid terminal admission");
    useThreadStore.getState().handleCanonicalProgress({ phase: "recovery", threadId: THREAD_ID, epoch: "terminal-admission",
      acceptedThrough: 0, savedThrough: 0, retained: [], loss: "none", durable: { mode: "snapshot", threadId: THREAD_ID,
        snapshot: { revision: { conversationRevision: 5, rosterRevision: 0 }, state: reduced.state } } });
    expect(readThreadField(THREAD_ID, (record) => record.runtimePhase)).toBe("completed");
    expect(readThreadField(THREAD_ID, (record) => record.turnExecutionId)).toBe(EXECUTION_ID);
    expect(readThreadField(THREAD_ID, (record) => record.optimisticUserMessageId)).toBeNull();
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
  });

  it("keeps a newer pending prompt when an older send fails later", async () => {
    seedRuntime("idle", null, false);
    useThreadStore.setState({ currentThreadId: THREAD_ID });
    let rejectOlder: ((reason: Error) => void) | undefined;
    vi.mocked(mockTransport.sendMessage).mockImplementationOnce(() => new Promise((_, reject) => { rejectOlder = reject; }));
    const olderSend = useThreadStore.getState().sendMessage(THREAD_ID, "Older request");
    useThreadStore.getState().applyThreadRuntimeSnapshot({ threadId: THREAD_ID, phase: "completed", turnExecutionId: EXECUTION_ID, savingStatus: null });
    const newerPrompt = await sendOptimisticPrompt("Newer request");
    const responseKey = readThreadField(THREAD_ID, (record) => record.currentTurnResponseKey);
    useThreadStore.setState({ currentThreadId: "other-thread" });
    useThreadStore.getState().handleAgentEvent({ type: "textDelta", threadId: THREAD_ID, delta: "Newer healthy progress", isFinalResponse: true });
    if (!rejectOlder) throw new Error("missing pending request");
    rejectOlder(new Error("Older request failed"));
    expect(await olderSend).toBe(false);
    expect(readThreadField(THREAD_ID, (record) => record.optimisticUserMessageId)).toBe(newerPrompt.id);
    expect(readThreadField(THREAD_ID, (record) => record.runtimePhase)).toBe("running");
    expect(readThreadField(THREAD_ID, (record) => record.error)).toBeNull();
    expect(readThreadField(THREAD_ID, (record) => record.currentTurnResponseKey)).toBe(responseKey);
    useThreadStore.setState({ currentThreadId: THREAD_ID });
    useThreadStore.getState().handleAgentEvent({ type: "system", threadId: THREAD_ID, subtype: "test.flush", message: "Flush newer progress" });
    expect(readThreadField(THREAD_ID, (record) => record.streaming)).toBe("Newer healthy progress");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(true);
  });

  it("clears its own pending prompt when the send fails before admission", async () => {
    seedRuntime("idle", null, false);
    useThreadStore.setState({ currentThreadId: THREAD_ID });
    vi.mocked(mockTransport.sendMessage).mockRejectedValueOnce(new Error("Send rejected"));
    expect(await useThreadStore.getState().sendMessage(THREAD_ID, "Rejected request")).toBe(false);
    expect(readThreadField(THREAD_ID, (record) => record.optimisticUserMessageId)).toBeNull();
    expect(readThreadField(THREAD_ID, (record) => record.runtimePhase)).toBe("errored");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
  });

  it("lets a newer turn the client did not start claim a settled record", () => {
    seedRuntime("running", EXECUTION_ID, true);
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID, "completed"));
    expect(readThreadField(THREAD_ID, (r) => [r.runtimePhase, r.turnExecutionId])).toEqual(["completed", EXECUTION_ID]);

    const second = (eventId: string, sequence: number, payload: CanonicalAgentEventEnvelope["payload"]) => {
      const event = envelope(eventId, sequence, OTHER_EXECUTION_ID, payload);
      return { ...event, routing: { ...event.routing, turnId: "turn-2" } };
    };
    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, [
      second("p1", 5, { type: "turn.created", turn: { id: "turn-2", threadId: THREAD_ID, status: "Pending", trigger: { kind: "user" },
        permissionMode: "full", approvalReviewMode: "manual", approvalReviewReason: "manual-requested", providerIdentities: [],
        startedAt: null, providerStartedAt: null, endedAt: null, createdAt: NOW, updatedAt: NOW } }),
      second("p2", 6, { type: "turn.started", startedAt: NOW }),
    ]);
    expect(readThreadField(THREAD_ID, (r) => [r.runtimePhase, r.turnExecutionId])).toEqual(["running", OTHER_EXECUTION_ID]);
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(true);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, [second("p3", 7, { type: "turn.completed", endedAt: NOW })]);
    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("completed");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
  });

  it("ignores a canonical turn carrying a different execution identity", () => {
    seedRuntime("running", OTHER_EXECUTION_ID, true);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID, "completed"));

    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("running");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(true);
  });

  it("maps an interrupted canonical turn to the interrupted phase", () => {
    seedRuntime("running", EXECUTION_ID, true);

    useThreadStore.getState().handleCanonicalAgentEvents(THREAD_ID, turnEvents(EXECUTION_ID, "interrupted"));

    expect(readThreadField(THREAD_ID, (r) => r.runtimePhase)).toBe("interrupted");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
  });

  it.each(["running", "completed"] as const)("keeps %s transcript references through sequential saved acknowledgements", (phase) => {
    seedRuntime("running", EXECUTION_ID, true);
    const response: Message = { id: "ack-response", thread_id: THREAD_ID, role: "assistant", content: "Accepted response",
      tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, timestamp: NOW, sequence: 1, attachments: null };
    const commonItem = { threadId: THREAD_ID, turnId: TURN_ID, providerIdentities: [], createdAt: NOW, updatedAt: NOW };
    const events = [...turnEvents(EXECUTION_ID),
      envelope("ack-tool-use", 4, EXECUTION_ID, { type: "publication.recorded", publicationId: "4", event: {
        type: "toolUse", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, toolCallId: "ack-tool", toolName: "Read", toolInput: { path: "/accepted" },
      } }),
      envelope("ack-tool-result", 5, EXECUTION_ID, { type: "publication.recorded", publicationId: "5", event: {
        type: "toolResult", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, toolCallId: "ack-tool", output: "Full accepted output", isError: false,
      } }),
      envelope("ack-tool-item", 6, EXECUTION_ID, { type: "item.recorded", item: { ...commonItem, id: "toolCall:ack-tool", kind: "tool-call",
        payload: { projection: "toolCall", record: { id: "ack-tool", message_id: response.id, parent_tool_call_id: null,
          tool_name: "Read", input_summary: "/accepted", output_summary: "Full accepted output", status: "completed",
          started_at: NOW, completed_at: NOW, sort_order: 0 } },
      } }),
      envelope("ack-thought-item", 7, EXECUTION_ID, { type: "item.recorded", item: { ...commonItem, id: "narrationSegment:ack-thought", kind: "reasoning",
        payload: { projection: "narrationSegment", record: { id: "ack-thought", message_id: response.id, text: "Accepted reasoning",
          started_at: NOW, ended_at: NOW, sort_order: 1, is_final_response: 0 } },
      } }),
      envelope("ack-hook-item", 8, EXECUTION_ID, { type: "item.recorded", item: { ...commonItem, id: "hook:ack-hook", kind: "system",
        payload: { projection: "hook", record: { id: "ack-hook", message_id: response.id, hook_name: "Stop", tool_name: null,
          phase: "stop", payload: "{}", duration_ms: 42, did_block: false, started_at: NOW, ended_at: NOW, sort_order: 2 } },
      } }),
      envelope("ack-message-publication", 9, EXECUTION_ID, { type: "publication.recorded", publicationId: "9", event: {
        type: "message", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, messageId: response.id, content: response.content, tokens: null,
      } }),
      envelope("ack-message-item", 10, EXECUTION_ID, { type: "item.recorded", item: { ...commonItem, id: "message:ack-response", kind: "message",
        payload: { projection: "message", message: response },
      } }),
      ...(phase === "completed" ? [envelope("ack-terminal", 11, EXECUTION_ID, { type: "turn.completed", endedAt: NOW })] : []),
    ].map((event) => ({ ...event, progressPosition: { epoch: "runtime-1", sequence: event.acceptedSequence } }));
    useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: THREAD_ID, epoch: "runtime-1", from: 0, through: events.length,
      events: events.map(({ durableRevision: _durableRevision, ...event }) => event) });
    useThreadStore.getState().setTurnSavingStatus(pendingSave(events.length, 0));
    const visible = useThreadStore.getState().records.get(THREAD_ID);
    if (!visible) throw new Error("missing accepted transcript");
    const runningThreadIds = useThreadStore.getState().runningThreadIds;
    const dispatch = vi.spyOn(useThreadStore.getState(), "handleAgentEvent");
    dispatch.mockClear();
    expect(visible.runtimePhase).toBe(phase);
    expect(visible.toolCalls).toHaveLength(1);
    expect(visible.toolCalls[0]?.output).toBe("Full accepted output");
    if (phase === "completed") {
      expect(visible.messages).toEqual([response]);
      expect(visible.thoughtSegments).toHaveLength(1);
      expect(visible.hooks).toHaveLength(1);
    }
    expect(visible.serverMessageIds[response.id]).toBeUndefined();
    for (let through = 1; through <= events.length; through += 1) {
      useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId: THREAD_ID, epoch: "runtime-1", through,
        revision: { conversationRevision: through, rosterRevision: 0 }, events: events.slice(0, through) });
      const saved = readThreadField(THREAD_ID, (record) => record);
      expect(saved.canonicalAgent.state).toBe(visible.canonicalAgent.state);
      expect(saved.canonicalAgent.state.turns[TURN_ID]).toBe(visible.canonicalAgent.state.turns[TURN_ID]);
      expect(saved.messages).toBe(visible.messages);
      expect(saved.toolCalls).toBe(visible.toolCalls);
      expect(saved.toolCalls[0]).toBe(visible.toolCalls[0]);
      expect(saved.thoughtSegments).toBe(visible.thoughtSegments);
      expect(saved.hooks).toBe(visible.hooks);
      expect(saved.canonicalAgent.progress?.savedThrough).toBe(through);
      expect(saved.canonicalAgent.revision.conversationRevision).toBe(through);
      expect(saved.savingStatuses).toHaveLength(through === events.length ? 0 : 1);
      expect(saved.savingStatus).toBe(through === events.length ? null : visible.savingStatus);
      expect(saved.serverMessageIds[response.id]).toBe(through >= 10 ? response.id : undefined);
      expect(saved.runtimePhase).toBe(phase);
      expect(useThreadStore.getState().runningThreadIds).toBe(runningThreadIds);
    }
    expect(dispatch).not.toHaveBeenCalled();
    dispatch.mockRestore();
  });

  it("keeps a saved completion terminal when earlier accepted start and text arrive later", () => {
    seedRuntime("running", EXECUTION_ID, true);
    const prefix = turnEvents(EXECUTION_ID);
    const started = envelope("publication-start", 4, EXECUTION_ID, { type: "publication.recorded", publicationId: "4",
      event: { type: "turnStarted", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID } });
    const text = envelope("publication-text", 5, EXECUTION_ID, { type: "publication.recorded", publicationId: "5",
      event: { type: "textDelta", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, delta: "Saved completion stays complete", isFinalResponse: true } });
    const terminal = envelope("terminal", 6, EXECUTION_ID, { type: "turn.completed", endedAt: NOW });
    const all = [...prefix, started, text, terminal].map((event) => ({ ...event, progressPosition: { epoch: "runtime-1", sequence: event.acceptedSequence } }));
    const beforeSaved = readThreadField(THREAD_ID, (record) => record.canonicalAgent.state);
    useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId: THREAD_ID, epoch: "runtime-1", through: 6,
      revision: { conversationRevision: 6, rosterRevision: 0 }, events: all });
    expect(readThreadField(THREAD_ID, (record) => record.canonicalAgent.state)).not.toBe(beforeSaved);
    expect(readThreadField(THREAD_ID, (record) => record.runtimePhase)).toBe("completed");
    const phases: string[] = [];
    const unsubscribe = useThreadStore.subscribe((state) => { phases.push(state.records.get(THREAD_ID)?.runtimePhase ?? "missing"); });
    useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: THREAD_ID, epoch: "runtime-1", from: 0, through: 5,
      events: all.slice(0, 5).map(({ durableRevision: _durableRevision, ...event }) => event) });
    unsubscribe();
    expect(phases).not.toContain("running");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
    expect(readThreadField(THREAD_ID, (record) => record.messages.filter((message) => message.content === "Saved completion stays complete"))).toHaveLength(1);
    expect(readThreadField(THREAD_ID, (record) => record.streaming)).toBe("");
  });

  it("preserves newer accepted progress when a delayed recovery response has an earlier cut", () => {
    seedRuntime("running", EXECUTION_ID, true);
    useThreadStore.setState({ currentThreadId: THREAD_ID });
    const epoch = "runtime-1";
    const events = [
      ...turnEvents(EXECUTION_ID),
      envelope("publication-tool", 4, EXECUTION_ID, { type: "publication.recorded", publicationId: "4",
        event: { type: "toolUse", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, toolCallId: "call-1", toolName: "Read", toolInput: { path: "/original" } } }),
      envelope("publication-text", 5, EXECUTION_ID, { type: "publication.recorded", publicationId: "5",
        event: { type: "textDelta", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, delta: "Newer accepted response", isFinalResponse: true } }),
      envelope("publication-ended", 6, EXECUTION_ID, { type: "publication.recorded", publicationId: "6",
        event: { type: "ended", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, reason: "completed", outcome: "completed" } }),
      envelope("terminal", 7, EXECUTION_ID, { type: "turn.completed", endedAt: NOW }),
    ].map((event) => ({ ...event, progressPosition: { epoch, sequence: event.acceptedSequence } }));
    const accepted = events.map(({ durableRevision: _durableRevision, ...event }) => event);
    useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId: THREAD_ID, epoch, through: 3,
      revision: { conversationRevision: 3, rosterRevision: 0 }, events: events.slice(0, 3) });
    const dispatch = vi.spyOn(useThreadStore.getState(), "handleAgentEvent");
    useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: THREAD_ID, epoch, from: 0, through: 7, events: accepted });
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(readThreadField(THREAD_ID, (record) => record.runtimePhase)).toBe("completed");

    const phases: string[] = [];
    const unsubscribe = useThreadStore.subscribe((state) => { phases.push(state.records.get(THREAD_ID)?.runtimePhase ?? "missing"); });
    useThreadStore.getState().applyCanonicalReconnectRecoveries([{ phase: "recovery", threadId: THREAD_ID, epoch,
      acceptedThrough: 4, savedThrough: 3, retained: accepted.slice(3, 4), loss: "none",
      durable: { mode: "delta", threadId: THREAD_ID, from: { conversationRevision: 3, rosterRevision: 0 },
        through: { conversationRevision: 3, rosterRevision: 0 }, events: [] } }]);
    unsubscribe();
    useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: THREAD_ID, epoch, from: 0, through: 7, events: accepted });

    const record = useThreadStore.getState().records.get(THREAD_ID);
    if (!record) throw new Error("missing recovered thread");
    const progress = record.canonicalAgent.progress;
    if (!progress) throw new Error("missing recovered progress");
    expect(progress.acceptedThrough).toBe(7);
    expect(progress.retained.map((event) => event.eventId)).toEqual(accepted.slice(3).map((event) => event.eventId));
    expect(record.canonicalAgent.durableState.turns[TURN_ID]?.status).toBe("Running");
    expect(record.canonicalAgent.state.turns[TURN_ID]?.status).toBe("Completed");
    expect(record.canonicalAgent.recoveryRequired).toBe(false);
    expect(record.runtimePhase).toBe("completed");
    expect(record.turnExecutionId).toBe(EXECUTION_ID);
    expect(phases).not.toContain("running");
    expect(useThreadStore.getState().runningThreadIds.has(THREAD_ID)).toBe(false);
    expect(record.messages.filter((message) => message.content === "Newer accepted response")).toHaveLength(1);
    expect(record.toolCalls).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(3);
    dispatch.mockRestore();
  });

  it("clears a completed save notice when recovery covers its missed acknowledgement", () => {
    seedRuntime("running", EXECUTION_ID, true);
    const events = turnEvents(EXECUTION_ID, "completed").map((event) => ({ ...event,
      progressPosition: { epoch: "runtime-1", sequence: event.acceptedSequence } }));
    useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: THREAD_ID, epoch: "runtime-1", from: 0, through: 4,
      events: events.map(({ durableRevision: _durableRevision, ...event }) => event) });
    useThreadStore.getState().setTurnSavingStatus(pendingSave(4, 0));
    expect(readThreadField(THREAD_ID, (record) => record.savingStatuses)).toHaveLength(1);

    useThreadStore.getState().applyCanonicalReconnectRecoveries([{ phase: "recovery", threadId: THREAD_ID, epoch: "runtime-1",
      acceptedThrough: 4, savedThrough: 4, retained: [], loss: "none",
      durable: { mode: "delta", threadId: THREAD_ID, from: { conversationRevision: 0, rosterRevision: 0 },
        through: { conversationRevision: 4, rosterRevision: 0 }, events } }]);
    useThreadStore.getState().hydrateThreadRuntimes([{ threadId: THREAD_ID, phase: "completed", turnExecutionId: EXECUTION_ID,
      savingStatuses: [], savingStatus: null }]);

    expect(readThreadField(THREAD_ID, (record) => record.savingStatuses)).toEqual([]);
    expect(readThreadField(THREAD_ID, (record) => record.savingStatus)).toBeNull();
    expect(readThreadField(THREAD_ID, (record) => record.runtimePhase)).toBe("completed");
  });

  it("clears the previous generation's saving notice after a fully saved loss-free recovery", () => {
    seedRuntime("running", EXECUTION_ID, true);
    const events = turnEvents(EXECUTION_ID, "completed").map(({ durableRevision: _durableRevision, ...event }) => ({ ...event,
      progressPosition: { epoch: "runtime-1", sequence: event.acceptedSequence } }));
    useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: THREAD_ID, epoch: "runtime-1", from: 0, through: 4, events });
    useThreadStore.getState().setTurnSavingStatus(pendingSave(4, 0));
    const state = readThreadField(THREAD_ID, (record) => record.canonicalAgent.state);
    if (!state) throw new Error("missing accepted state");

    useThreadStore.getState().applyCanonicalReconnectRecoveries([{ phase: "recovery", threadId: THREAD_ID, epoch: "runtime-2",
      acceptedThrough: 0, savedThrough: 0, retained: [], loss: "none",
      durable: { mode: "snapshot", threadId: THREAD_ID, snapshot: { revision: { conversationRevision: 4, rosterRevision: 0 }, state } } }]);
    useThreadStore.getState().hydrateThreadRuntimes([{ threadId: THREAD_ID, phase: "completed", turnExecutionId: EXECUTION_ID,
      savingStatus: null, savingStatuses: [] }]);

    expect(readThreadField(THREAD_ID, (record) => record.savingStatuses)).toEqual([]);
    expect(readThreadField(THREAD_ID, (record) => record.savingStatus)).toBeNull();
    expect(readThreadField(THREAD_ID, (record) => record.canonicalAgent.progress?.epoch)).toBe("runtime-2");
    expect(readThreadField(THREAD_ID, (record) => record.canonicalAgent.lostProgress)).toBe(false);
    expect(readThreadField(THREAD_ID, (record) => record.runtimePhase)).toBe("completed");
  });

  it.each([null, "durable"] as const)("preserves newer pending saves after a delayed empty snapshot with legacy status %s", (savingStatus) => {
    seedRuntime("running", EXECUTION_ID, true);
    useThreadStore.setState({ currentThreadId: THREAD_ID });
    const events = [...turnEvents(EXECUTION_ID),
      envelope("publication-tool", 4, EXECUTION_ID, { type: "publication.recorded", publicationId: "4",
        event: { type: "toolUse", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, toolCallId: "call-1", toolName: "Read", toolInput: {} } }),
      envelope("publication-text", 5, EXECUTION_ID, { type: "publication.recorded", publicationId: "5",
        event: { type: "textDelta", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, delta: "Newer pending reply", isFinalResponse: true } }),
    ].map((event) => ({ ...event, progressPosition: { epoch: "runtime-1", sequence: event.acceptedSequence } }));
    useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId: THREAD_ID, epoch: "runtime-1", through: 3,
      revision: { conversationRevision: 3, rosterRevision: 0 }, events: events.slice(0, 3) });
    useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: THREAD_ID, epoch: "runtime-1", from: 0, through: 5,
      events: events.map(({ durableRevision: _durableRevision, ...event }) => event) });
    const pending = pendingSave(5, 3);
    useThreadStore.getState().setTurnSavingStatus(pending);

    useThreadStore.getState().applyCanonicalReconnectRecoveries([{ phase: "recovery", threadId: THREAD_ID, epoch: "runtime-1",
      acceptedThrough: 3, savedThrough: 3, retained: [], loss: "none",
      durable: { mode: "delta", threadId: THREAD_ID, from: { conversationRevision: 3, rosterRevision: 0 },
        through: { conversationRevision: 3, rosterRevision: 0 }, events: [] } }]);
    useThreadStore.getState().hydrateThreadRuntimes([{ threadId: THREAD_ID, phase: "running", turnExecutionId: EXECUTION_ID,
      savingStatuses: [], savingStatus }]);

    expect(readThreadField(THREAD_ID, (record) => record.savingStatuses)).toEqual([pending]);
    expect(readThreadField(THREAD_ID, (record) => record.savingStatus)).toEqual(pending);
    expect(readThreadField(THREAD_ID, (record) => record.canonicalAgent.progress?.acceptedThrough)).toBe(5);
    expect(readThreadField(THREAD_ID, (record) => record.streaming)).toBe("Newer pending reply");
  });

  it.each([false, true])("removes an assigned-ID response after restart only when unsaved, acknowledged=%s", (acknowledged) => {
    const savedMessage: Message = { id: "saved-message", thread_id: THREAD_ID, role: "assistant", content: "Already saved reply",
      tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, timestamp: NOW, sequence: 1, attachments: null };
    const response: Message = { ...savedMessage, id: "unsaved-message", content: "Accepted unsaved reply", sequence: 2 };
    resetThreadStoreForTests({ currentThreadId: THREAD_ID, records: seedThreadRecord(THREAD_ID, {
      runtimePhase: "running", turnExecutionId: EXECUTION_ID, messages: [savedMessage], serverMessageIds: { [savedMessage.id]: savedMessage.id },
    }), runningThreadIds: new Set([THREAD_ID]) });
    const events = [...turnEvents(EXECUTION_ID),
      envelope("publication-message", 4, EXECUTION_ID, { type: "publication.recorded", publicationId: "4",
        event: { type: "message", threadId: THREAD_ID, turnExecutionId: EXECUTION_ID, messageId: "unsaved-message", content: "Accepted unsaved reply", tokens: null } }),
      envelope("response-item", 5, EXECUTION_ID, { type: "item.recorded", item: { id: "response-item", threadId: THREAD_ID, turnId: TURN_ID,
        kind: "message", providerIdentities: [], createdAt: NOW, updatedAt: NOW, payload: { projection: "message", message: response } } }),
      envelope("terminal", 6, EXECUTION_ID, { type: "turn.completed", endedAt: NOW }),
    ].map((event) => ({ ...event, progressPosition: { epoch: "runtime-1", sequence: event.acceptedSequence } }));
    useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId: THREAD_ID, epoch: "runtime-1", through: 3,
      revision: { conversationRevision: 3, rosterRevision: 0 }, events: events.slice(0, 3) });
    useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId: THREAD_ID, epoch: "runtime-1", from: 0, through: 6,
      events: events.map(({ durableRevision: _durableRevision, ...event }) => event) });
    expect(readThreadField(THREAD_ID, (record) => record.messages.map((message) => message.id))).toEqual(["saved-message", "unsaved-message"]);
    expect(readThreadField(THREAD_ID, (record) => record.serverMessageIds["unsaved-message"])).toBeUndefined();
    if (acknowledged) {
      useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId: THREAD_ID, epoch: "runtime-1", through: 6,
        revision: { conversationRevision: 6, rosterRevision: 0 }, events: events.slice(3) });
      expect(readThreadField(THREAD_ID, (record) => record.serverMessageIds["unsaved-message"])).toBe("unsaved-message");
    }
    const replica = readThreadField(THREAD_ID, (record) => record.canonicalAgent);
    if (!replica) throw new Error("missing canonical replica");

    useThreadStore.getState().applyCanonicalReconnectRecoveries([{ phase: "recovery", threadId: THREAD_ID, epoch: "runtime-2",
      acceptedThrough: 0, savedThrough: 0, retained: [], loss: "runtime-restarted",
      durable: { mode: "snapshot", threadId: THREAD_ID, snapshot: { revision: replica.revision, state: replica.durableState } } }]);

    expect(readThreadField(THREAD_ID, (record) => record.messages)).toEqual(acknowledged ? [savedMessage, response] : [savedMessage]);
    expect(readThreadField(THREAD_ID, (record) => record.serverMessageIds)).toEqual({ "saved-message": "saved-message",
      ...(acknowledged ? { "unsaved-message": "unsaved-message" } : {}) });
    expect(readThreadField(THREAD_ID, (record) => record.runtimePhase)).toBe(acknowledged ? "completed" : "interrupted");
    expect(readThreadField(THREAD_ID, (record) => record.canonicalAgent.lostProgress)).toBe(true);
  });
});
