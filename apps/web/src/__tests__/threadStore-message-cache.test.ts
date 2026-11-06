import { createMockMessage, createMockThread } from "@mcode/contracts/testing";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { NarrativeEntry } from "@mcode/contracts/models/narrative-entry";
import type { ToolCallRecord } from "@/transport/types";
import {
  activateTestConversation,
  resetThreadStoreForTests,
  getTestActiveMessages,
} from "@/stores/thread-store-test-utils";
import {
  createEmptyThreadRecord,
  patchThreadRecord,
  type ThreadRecord,
} from "@/stores/thread-record";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAgentModelState, type AcceptedCanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import { getConversationResidency } from "@/features/conversation/residency/conversation-residency";
import { useThreadStore, MESSAGE_FETCH_SIZE } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getThreadRecord } from "@/stores/thread-record";
import { clearRecordCache, getCachedRecord } from "@/features/conversation/hydration/record-cache";
import {
  ACTIVE_CONVERSATION_BYTES,
  CONVERSATION_NARRATIVE_BYTES,
  measureConversationValue,
} from "@/features/conversation/hydration/conversation-memory-policy";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const fakeMessages = [
  createMockMessage({
    id: "m1",
    thread_id: "t1",
    content: "hello",
  }),
];

const CACHE_EXECUTION = "00000000-0000-4000-8000-000000000001";
const CACHE_NOW = "2026-11-06T12:00:00.000Z";

function startHiddenConversation(threadId: string) {
  const state = createAgentModelState();
  state.threads[threadId] = { id: threadId, workspaceId: "workspace", rootThreadId: threadId,
    providerId: "codex", providerIdentities: [], activityState: "Active", conversationRevision: 0,
    rosterRevision: 0, createdAt: CACHE_NOW, updatedAt: CACHE_NOW };
  state.turns[threadId] = { id: threadId, threadId, executionId: CACHE_EXECUTION,
    status: "Running", trigger: { kind: "user" }, permissionMode: "full", approvalReviewMode: "manual",
    approvalReviewReason: "manual-requested", attemptOf: null, providerIdentities: [],
    startedAt: CACHE_NOW, providerStartedAt: null, ending: null, endedAt: null,
    createdAt: CACHE_NOW, updatedAt: CACHE_NOW };
  const message = createMockMessage({ id: `${threadId}-answer`, thread_id: threadId,
    role: "assistant", content: `Answer for ${threadId}`, sequence: 10 });
  state.items[`message:${message.id}`] = { id: `message:${message.id}`, threadId, turnId: threadId, kind: "message",
    providerIdentities: [], createdAt: CACHE_NOW, updatedAt: CACHE_NOW,
    payload: { projection: "message", message } };
  useThreadStore.setState((current) => ({
    records: patchThreadRecord(current.records, threadId, {
      ...createEmptyThreadRecord(), turnExecutionId: CACHE_EXECUTION, runtimePhase: "running",
      messages: [message], oldestLoadedSequence: 10, newestLoadedSequence: 10, hasMoreMessages: true,
    }),
    runningThreadIds: new Set([...current.runningThreadIds, threadId]),
  }));
  useThreadStore.getState().handleCanonicalProgress({ phase: "recovery", threadId,
    epoch: threadId, acceptedThrough: 0, savedThrough: 0, retained: [], loss: "none",
    durable: { mode: "snapshot", threadId, snapshot: {
      revision: { conversationRevision: 0, rosterRevision: 0 }, state,
    } },
  });
  const terminal: AcceptedCanonicalAgentEventEnvelope = {
    eventId: `${threadId}-complete`, routing: { threadId, turnId: threadId, executionId: CACHE_EXECUTION },
    sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: 1,
    progressPosition: { epoch: threadId, sequence: 1 },
    serverTimestamps: { acceptedAt: CACHE_NOW, persistedAt: CACHE_NOW },
    payload: { type: "turn.completed", endedAt: CACHE_NOW },
  };
  return {
    complete: () => useThreadStore.getState().handleCanonicalProgress({ phase: "accepted", threadId,
      epoch: threadId, from: 0, through: 1, events: [terminal] }),
    save: () => useThreadStore.getState().handleCanonicalProgress({ phase: "saved", threadId,
      epoch: threadId, through: 1, revision: { conversationRevision: 1, rosterRevision: 0 },
      events: [{ ...terminal, durableRevision: 1 }] }),
  };
}

describe("hidden completion residency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetThreadStoreTestState();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps persisted file changes when the hidden turn's saved frame lands first", async () => {
    useWorkspaceStore.setState({ threads: [createMockThread({ id: "late", has_file_changes: false })] });
    const execution = startHiddenConversation("late");
    execution.complete();
    await vi.advanceTimersByTimeAsync(100);
    execution.save();
    await vi.advanceTimersByTimeAsync(100);
    expect(useThreadStore.getState().records.has("late")).toBe(true);
    useThreadStore.getState().handleTurnPersisted({
      threadId: "late", messageId: "late-answer", executionId: CACHE_EXECUTION,
      settledMessage: { id: "late-answer", sequence: 10 },
      outcome: "completed", toolCallCount: 2, filesChanged: ["src/a.ts"],
    });
    expect(useWorkspaceStore.getState().threads.find((thread) => thread.id === "late")?.has_file_changes).toBe(true);
    expect(useThreadStore.getState().records.has("late")).toBe(false);
    expect(getCachedRecord("late")?.persistedFilesChanged).toEqual({ "late-answer": ["src/a.ts"] });
    expect(getCachedRecord("late")?.persistedToolCallCounts).toEqual({ "late-answer": 2 });
    expect(getCachedRecord("late")?.messages[0]?.serverSequence).toBe(10);
    useThreadStore.getState().handleTurnPersisted({
      threadId: "late", messageId: "late-answer", executionId: CACHE_EXECUTION,
      settledMessage: { id: "late-answer", sequence: 11 },
      outcome: "completed", toolCallCount: 3, filesChanged: ["src/a.ts", "src/b.ts"],
    });
    expect(useThreadStore.getState().records.has("late")).toBe(false);
    expect(getCachedRecord("late")?.persistedToolCallCounts).toEqual({ "late-answer": 3 });
    expect(getCachedRecord("late")?.messages[0]?.serverSequence).toBe(11);
    await activateTestConversation("late");
    expect(getThreadRecord(useThreadStore.getState().records, "late").persistedFilesChanged).toEqual({ "late-answer": ["src/a.ts", "src/b.ts"] });
  });

  it("applies turn.persisted for a thread this window never loaded", () => {
    useWorkspaceStore.setState({ threads: [createMockThread({ id: "unloaded", has_file_changes: false })] });
    useThreadStore.getState().handleTurnPersisted({
      threadId: "unloaded", messageId: "answer", executionId: CACHE_EXECUTION,
      settledMessage: { id: "answer", sequence: 3 },
      outcome: "completed", toolCallCount: 0, filesChanged: ["src/b.ts"],
    });
    expect(useWorkspaceStore.getState().threads.find((thread) => thread.id === "unloaded")?.has_file_changes).toBe(true);
  });

  it("keeps an accepted terminal with turn.persisted resident until its saved frame", async () => {
    const execution = startHiddenConversation("unsaved");
    execution.complete();
    await vi.advanceTimersByTimeAsync(100);
    useThreadStore.getState().handleTurnPersisted({
      threadId: "unsaved", messageId: "unsaved-answer", executionId: CACHE_EXECUTION,
      settledMessage: { id: "unsaved-answer", sequence: 10 },
      outcome: "completed", toolCallCount: 0, filesChanged: [],
    });
    expect(useThreadStore.getState().records.get("unsaved")?.canonicalAgent.progress?.savedThrough).toBe(0);
    execution.save();
    await vi.advanceTimersByTimeAsync(100);
    expect(useThreadStore.getState().records.has("unsaved")).toBe(false);
  });

  it("retires five durably completed hidden records and restores their warm transcript", async () => {
    for (let index = 0; index < 5; index += 1) {
      const execution = startHiddenConversation(`hidden-${index}`);
      execution.complete();
      await vi.advanceTimersByTimeAsync(100);
      expect(useThreadStore.getState().records.has(`hidden-${index}`)).toBe(true);
      execution.save();
      await vi.advanceTimersByTimeAsync(100);
      useThreadStore.getState().handleTurnPersisted({ threadId: `hidden-${index}`,
        messageId: `hidden-${index}-answer`, executionId: CACHE_EXECUTION,
        settledMessage: { id: `hidden-${index}-answer`, sequence: 10 },
        outcome: "completed", toolCallCount: 0, filesChanged: [] });
    }
    const records = [...useThreadStore.getState().records.values()];
    const canonicalItems = records.reduce((count, record) => count + Object.keys(record.canonicalAgent.state.items).length, 0);
    expect({ liveRecords: records.length, canonicalItems }).toEqual({ liveRecords: 0, canonicalItems: 0 });
    useThreadStore.getState().handleTurnPersisted({ threadId: "hidden-0", messageId: "hidden-0-answer",
      settledMessage: { id: "hidden-0-answer", sequence: 10 },
      executionId: CACHE_EXECUTION, outcome: "completed", toolCallCount: 0, filesChanged: [] });
    expect(useThreadStore.getState().records.has("hidden-0")).toBe(false);
    const cached = getCachedRecord("hidden-0");
    expect(cached?.messages.map((message) => message.content)).toEqual(["Answer for hidden-0"]);
    expect(cached?.oldestLoadedSequence).toBe(10);
    expect(cached?.hasMoreMessages).toBe(true);
    const restoration = activateTestConversation("hidden-0");
    expect(getTestActiveMessages().map((message) => message.content)).toEqual(["Answer for hidden-0"]);
    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();
    await restoration;
  });

  it.each(["selected", "leased"])("keeps a %s completed conversation resident", async (display) => {
    const execution = startHiddenConversation("displayed");
    if (display === "selected") useThreadStore.setState({ currentThreadId: "displayed" });
    else await getConversationResidency().mountDisplayConversation("displayed");
    execution.complete();
    await vi.advanceTimersByTimeAsync(100);
    execution.save();
    await vi.advanceTimersByTimeAsync(100);
    useThreadStore.getState().handleTurnPersisted({ threadId: "displayed", messageId: "displayed-answer",
      settledMessage: { id: "displayed-answer", sequence: 10 }, executionId: CACHE_EXECUTION,
      outcome: "completed", toolCallCount: 0, filesChanged: [] });
    expect(useThreadStore.getState().records.get("displayed")?.runtimePhase).toBe("completed");
    expect(Object.keys(useThreadStore.getState().records.get("displayed")?.canonicalAgent.state.items ?? {})).toEqual(["message:displayed-answer"]);
    if (display === "leased") getConversationResidency().unmountDisplayConversation("displayed");
  });

  it("keeps a replacement execution when the old saved receipt arrives", async () => {
    const execution = startHiddenConversation("replacement");
    execution.complete();
    await vi.advanceTimersByTimeAsync(100);
    useThreadStore.getState().handleAgentEvent({ type: "turnStarted", threadId: "replacement",
      turnExecutionId: "00000000-0000-4000-8000-000000000002" });
    execution.save();
    await vi.advanceTimersByTimeAsync(100);
    expect(useThreadStore.getState().records.get("replacement")?.turnExecutionId).toBe("00000000-0000-4000-8000-000000000002");
    expect(useThreadStore.getState().runningThreadIds.has("replacement")).toBe(true);
  });

  it("keeps running hidden conversations", async () => {
    startHiddenConversation("running");
    await vi.advanceTimersByTimeAsync(100);
    expect(useThreadStore.getState().records.get("running")?.runtimePhase).toBe("running");
    expect(Object.keys(useThreadStore.getState().records.get("running")?.canonicalAgent.state.items ?? {})).toEqual(["message:running-answer"]);
  });

  it("waits for response persistence before retiring a saved hidden execution", async () => {
    const execution = startHiddenConversation("pending");
    execution.complete();
    await vi.advanceTimersByTimeAsync(100);
    useThreadStore.setState((state) => ({ records: patchThreadRecord(state.records, "pending", {
      pendingTurnPersistMessageIds: ["pending-answer"],
    }) }));
    execution.save();
    await vi.advanceTimersByTimeAsync(100);
    expect(useThreadStore.getState().records.has("pending")).toBe(true);
    useThreadStore.getState().handleTurnPersisted({ threadId: "pending", messageId: "pending-answer",
      settledMessage: { id: "pending-answer", sequence: 10 }, executionId: CACHE_EXECUTION,
      outcome: "completed", toolCallCount: 0, filesChanged: [] });
    expect(useThreadStore.getState().records.has("pending")).toBe(false);
    expect(getCachedRecord("pending")?.messages.map((message) => message.content)).toEqual(["Answer for pending"]);
  });

  it("keeps a saved hidden execution while a background tool owes a late result", async () => {
    const execution = startHiddenConversation("background");
    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: "background",
      turnExecutionId: CACHE_EXECUTION, toolCallId: "background-tool", toolName: "Bash", toolInput: { command: "work" } });
    useThreadStore.getState().handleAgentEvent({ type: "toolBackgrounded", threadId: "background",
      turnExecutionId: CACHE_EXECUTION, toolCallId: "background-tool" });
    execution.complete();
    await vi.advanceTimersByTimeAsync(100);
    execution.save();
    await vi.advanceTimersByTimeAsync(100);
    useThreadStore.getState().handleTurnPersisted({ threadId: "background", messageId: "background-answer",
      settledMessage: { id: "background-answer", sequence: 10 }, executionId: CACHE_EXECUTION,
      outcome: "completed", toolCallCount: 1, filesChanged: [] });
    expect(useThreadStore.getState().records.get("background")?.toolCalls.map((tool) => ({
      id: tool.id, complete: tool.isComplete,
    }))).toEqual([{ id: "background-tool", complete: false }]);
  });
});

/**
 * Reset thread store and message cache to a clean state for tests.
 * Sets up mocked transport and properly-typed initial state.
 * Clears all ThreadState fields to prevent state leakage between tests.
 */
function resetThreadStoreTestState() {
  useThreadStore.getState().clearThreadState("t1");
  clearRecordCache();
  vi.clearAllMocks();
  (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: fakeMessages, hasMore: false });
  (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
    messages: fakeMessages,
    hasMore: false,
    narrativeByMessage: {},
  });
  resetThreadStoreForTests({
    currentThreadId: null,
    runningThreadIds: new Set<string>(),
    records: new Map<string, ThreadRecord>(),
  });
}

describe("loadMessages cache integration", () => {
  beforeEach(() => {
    resetThreadStoreTestState();
  });

  it("calls conversation.page on first load (cache miss) and populates cache", async () => {
await activateTestConversation("t1");

    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith("t1", MESSAGE_FETCH_SIZE);
    expect(mockTransport.getMessages).not.toHaveBeenCalled();
    expect(getTestActiveMessages()).toEqual([{ ...fakeMessages[0], serverSequence: 1 }]);
    expect(getCachedRecord("t1")).toBeDefined();
    expect(getCachedRecord("t1")?.messages).toEqual([{ ...fakeMessages[0], serverSequence: 1 }]);
  });

  it("loads one bounded turn detail window without refetching the conversation page", async () => {
    const assistant = createMockMessage({
      id: "assistant-agent",
      thread_id: "t1",
      role: "assistant",
      content: "Child result",
    });
    const command: ToolCallRecord = {
      id: "command-1",
      message_id: assistant.id,
      parent_tool_call_id: null,
      tool_name: "command_execution",
      input_summary: "pwd",
      output_summary: "/workspace",
      status: "completed" as const,
      started_at: "2026-08-20T10:00:00.000Z",
      completed_at: "2026-08-20T10:00:01.000Z",
      sort_order: 1,
    };
    const agent: ToolCallRecord = {
      ...command,
      id: "agent-1",
      tool_name: "Agent",
      input_summary: "delegate",
      output_summary: "done",
      sort_order: 2,
    };
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [assistant],
      hasMore: false,
      narrativeByMessage: {},
    });
    (mockTransport.loadTurn as ReturnType<typeof vi.fn>).mockResolvedValue([
      { kind: "assistantMessage", messageId: assistant.id, sequence: assistant.sequence, body: assistant.content, sortOrder: 0 },
      { kind: "toolCall", sequence: assistant.sequence, sortOrder: 1, record: command },
      { kind: "toolCall", sequence: assistant.sequence, sortOrder: 2, record: agent },
    ] satisfies NarrativeEntry[]);

    await activateTestConversation("t1");
    // Activation prefetches tail detail, so the window is already resident.
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(true);

    await useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1");

    const narrative = getThreadRecord(
      useThreadStore.getState().records,
      "t1",
    ).narrativeByMessage[assistant.id];
    expect(mockTransport.loadTurn).toHaveBeenCalledWith("t1", {
      limit: 1,
      before: assistant.sequence + 1,
      detail: { limit: 100 },
    });
    expect(narrative?.tools.map((record) => record.id)).toEqual(["command-1", "agent-1"]);
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(true);
  });

  it("continues a full detail window with its stable cursor and merges by detail identity", async () => {
    const assistant = createMockMessage({
      id: "assistant-retry",
      thread_id: "t1",
      role: "assistant",
      content: "Child result",
      tool_call_count: 101,
    });
    const command: ToolCallRecord = {
      id: "command-retry",
      message_id: assistant.id,
      parent_tool_call_id: null,
      tool_name: "command_execution",
      input_summary: "pwd",
      output_summary: "/workspace",
      status: "completed" as const,
      started_at: "2026-08-20T10:00:00.000Z",
      completed_at: "2026-08-20T10:00:01.000Z",
      sort_order: 1,
    };
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [assistant],
      hasMore: false,
      narrativeByMessage: {},
    });
    const firstWindow = Array.from({ length: 100 }, (_, index) => ({
      kind: "toolCall" as const,
      sequence: assistant.sequence,
      sortOrder: index,
      record: { ...command, id: `tool-retry-${index}`, sort_order: index },
    } satisfies NarrativeEntry));
    const finalTool = { ...command, id: "tool-retry-100", sort_order: 100 };
    (mockTransport.loadTurn as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(firstWindow)
      .mockResolvedValueOnce([
        { kind: "toolCall", sequence: assistant.sequence, sortOrder: 100, record: finalTool },
      ] satisfies NarrativeEntry[]);

    await activateTestConversation("t1");

    // The activation prefetch consumes the first window and leaves the cursor.
    expect(mockTransport.loadTurn).toHaveBeenCalledTimes(1);
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(false);

    await useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1", { continue: true });

    expect(mockTransport.loadTurn).toHaveBeenLastCalledWith("t1", {
      limit: 1,
      before: assistant.sequence + 1,
      detail: {
        limit: 100,
        after: {
          sequence: assistant.sequence,
          sortOrder: 99,
          kind: "toolCall",
          id: "tool-retry-99",
        },
      },
    });
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(true);
    expect(getThreadRecord(useThreadStore.getState().records, "t1")
      .narrativeByMessage[assistant.id]?.tools.map((record) => record.id))
      .toEqual(Array.from({ length: 101 }, (_, index) => `tool-retry-${index}`));
  });

  it("does not let the render caused by a full detail window request its continuation by default", async () => {
    const assistant = createMockMessage({
      id: "assistant-effect-continuation",
      thread_id: "t1",
      role: "assistant",
      content: "Child result",
      tool_call_count: 101,
    });
    const command: ToolCallRecord = {
      id: "effect-tool",
      message_id: assistant.id,
      parent_tool_call_id: null,
      tool_name: "command_execution",
      input_summary: "pwd",
      output_summary: "/workspace",
      status: "completed",
      started_at: "2026-08-20T10:00:00.000Z",
      completed_at: "2026-08-20T10:00:01.000Z",
      sort_order: 0,
    };
    const firstWindow = Array.from({ length: 100 }, (_, index) => ({
      kind: "toolCall" as const,
      sequence: assistant.sequence,
      sortOrder: index,
      record: { ...command, id: `effect-tool-${index}`, sort_order: index },
    } satisfies NarrativeEntry));
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [assistant], hasMore: false, narrativeByMessage: {},
    });
    (mockTransport.loadTurn as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(firstWindow);

    await activateTestConversation("t1");
    let continuation: Promise<void> | undefined;
    const unsubscribe = useThreadStore.subscribe((state, previous) => {
      const next = getThreadRecord(state.records, "t1").narrativeByMessage[assistant.id];
      const prior = getThreadRecord(previous.records, "t1").narrativeByMessage[assistant.id];
      if (next !== prior && next && !state.isNarrativeLoaded("t1", assistant.id)) {
        continuation = state.loadNarrativeForMessage(assistant.id, "t1");
      }
    });

    await useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1");
    await continuation;
    unsubscribe();

    expect(mockTransport.loadTurn).toHaveBeenCalledTimes(1);
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(false);
    expect(getThreadRecord(useThreadStore.getState().records, "t1")
      .narrativeByMessage[assistant.id]?.tools.map((record) => record.id))
      .toEqual(Array.from({ length: 100 }, (_, index) => `effect-tool-${index}`));
  });

  it("keeps an earlier detail window when a later window would exceed the resident budget", async () => {
    const assistant = createMockMessage({
      id: "assistant-detail-budget",
      thread_id: "t1",
      role: "assistant",
      tool_call_count: 200,
    });
    const baseTool: ToolCallRecord = {
      id: "detail-budget-0",
      message_id: assistant.id,
      parent_tool_call_id: null,
      tool_name: "command_execution",
      input_summary: "pwd",
      output_summary: "/workspace",
      status: "completed",
      started_at: "2026-08-20T10:00:00.000Z",
      completed_at: "2026-08-20T10:00:01.000Z",
      sort_order: 0,
    };
    const firstWindow = Array.from({ length: 100 }, (_, index) => ({
      kind: "toolCall" as const,
      sequence: assistant.sequence,
      sortOrder: index,
      record: { ...baseTool, id: `detail-budget-${index}`, sort_order: index },
    } satisfies NarrativeEntry));
    const tooLargeWindow = Array.from({ length: 100 }, (_, offset) => {
      const index = offset + 100;
      return {
        kind: "toolCall" as const,
        sequence: assistant.sequence,
        sortOrder: index,
        record: {
          ...baseTool,
          id: `detail-budget-${index}`,
          output_summary: "x".repeat(50_000),
          sort_order: index,
        },
      } satisfies NarrativeEntry;
    });
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [assistant], hasMore: false, narrativeByMessage: {},
    });
    (mockTransport.loadTurn as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(firstWindow)
      .mockResolvedValueOnce(tooLargeWindow);

    await activateTestConversation("t1");
    // The activation prefetch consumed the first window; this explicitly requests the next.
    await useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1", { continue: true });

    const record = getThreadRecord(useThreadStore.getState().records, "t1");
    const retained = record.narrativeByMessage[assistant.id];
    expect(retained?.tools.map((tool) => tool.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `detail-budget-${index}`),
    );
    expect(measureConversationValue(record.narrativeByMessage)).toBeLessThanOrEqual(CONVERSATION_NARRATIVE_BYTES);
    expect(measureConversationValue(record)).toBeLessThanOrEqual(ACTIVE_CONVERSATION_BYTES);
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(false);
  });

  it("drops an in-flight detail response after its assistant row scrolls out", async () => {
    const assistant = createMockMessage({ id: "assistant-scroll-out", thread_id: "t1", role: "assistant" });
    let resolveResponse!: (entries: NarrativeEntry[]) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [assistant], hasMore: false, narrativeByMessage: {},
    });
    (mockTransport.loadTurn as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(new Promise<NarrativeEntry[]>((resolve) => {
        resolveResponse = resolve;
      }))
      .mockResolvedValueOnce([
        { kind: "assistantMessage", messageId: assistant.id, sequence: 1, body: "fresh", sortOrder: 0 },
      ] satisfies NarrativeEntry[]);

    await activateTestConversation("t1");
    const request = useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1");
    useThreadStore.getState().evictNarrativeForMessage(assistant.id, "t1");
    resolveResponse([{ kind: "assistantMessage", messageId: assistant.id, sequence: 1, body: "done", sortOrder: 0 }]);
    await request;

    expect(getThreadRecord(useThreadStore.getState().records, "t1").narrativeByMessage[assistant.id]).toBeUndefined();
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(false);

    await useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1");
    expect(mockTransport.loadTurn).toHaveBeenLastCalledWith("t1", {
      limit: 1,
      before: assistant.sequence + 1,
      detail: { limit: 100 },
    });
    expect(getThreadRecord(useThreadStore.getState().records, "t1").narrativeByMessage[assistant.id]).toBeDefined();
  });

  it("evicts a deferred detail cache when a narrative is collapsed after its response", async () => {
    const assistant = createMockMessage({ id: "assistant-collapse", thread_id: "t1", role: "assistant" });
    let resolveResponse!: (entries: NarrativeEntry[]) => void;
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [assistant], hasMore: false, narrativeByMessage: {},
    });
    (mockTransport.loadTurn as ReturnType<typeof vi.fn>).mockReturnValue(new Promise<NarrativeEntry[]>((resolve) => {
      resolveResponse = resolve;
    }));

    await activateTestConversation("t1");
    const request = useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1");
    resolveResponse([
      { kind: "assistantMessage", messageId: assistant.id, sequence: 1, body: "done", sortOrder: 0 },
    ]);
    await request;
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(true);

    useThreadStore.getState().evictNarrativeForMessage(assistant.id, "t1");
    expect(getThreadRecord(useThreadStore.getState().records, "t1").narrativeByMessage[assistant.id]).toBeUndefined();
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(false);
  });

  it("retains loaded detail across a thread switch round trip", async () => {
    const assistant = createMockMessage({ id: "assistant-retain", thread_id: "t1", role: "assistant" });
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [assistant], hasMore: false, narrativeByMessage: {},
    });
    (mockTransport.loadTurn as ReturnType<typeof vi.fn>).mockResolvedValue([
      { kind: "assistantMessage", messageId: assistant.id, sequence: 1, body: "done", sortOrder: 0 },
    ] satisfies NarrativeEntry[]);

    await activateTestConversation("t1");
    await useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1");
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(true);
    const detailCalls = vi.mocked(mockTransport.loadTurn).mock.calls.length;

    useThreadStore.setState((s) => ({
      currentThreadId: "t2",
      records: patchThreadRecord(s.records, "t2", { messages: [] }),
    }));
    await activateTestConversation("t1");

    const record = getThreadRecord(useThreadStore.getState().records, "t1");
    expect(record.narrativeByMessage[assistant.id]).toBeDefined();
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(true);
    expect(vi.mocked(mockTransport.loadTurn).mock.calls.length).toBe(detailCalls);
  });

  it("on cache hit, does not call conversation.page and renders from cache", async () => {
    // First load primes the cache
    await activateTestConversation("t1");
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);

    // Switch away
    useThreadStore.setState((s) => ({
      currentThreadId: "t2",
      records: patchThreadRecord(s.records, "t2", { messages: [] }),
    }));

    // Switch back -- should hit cache
    await activateTestConversation("t1");
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1); // unchanged
    expect(getTestActiveMessages()).toEqual([{ ...fakeMessages[0], serverSequence: 1 }]);
    expect(useThreadStore.getState().currentThreadId).toBe("t1");
  });

  it("appends an optimistic user message after a restored high-sequence cache tail", async () => {
    const cachedTail = [
      createMockMessage({ id: "m99", thread_id: "t1", sequence: 99 }),
      createMockMessage({ id: "m100", thread_id: "t1", sequence: 100 }),
    ];
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: cachedTail,
      hasMore: true,
      narrativeByMessage: {},
    });

    await activateTestConversation("t1");
    useThreadStore.setState((s) => ({
      currentThreadId: "t2",
      records: patchThreadRecord(s.records, "t2", { messages: [] }),
    }));
    await activateTestConversation("t1");

    await useThreadStore.getState().sendMessage("t1", "new user message");

    const messages = getTestActiveMessages();
    expect(messages.map((message) => message.sequence)).toEqual([99, 100, 101]);
    expect(messages.at(-1)?.content).toBe("new user message");
  });

  it("starts optimistic messages at sequence one for an empty record", async () => {
    useThreadStore.setState((s) => ({
      currentThreadId: "t1",
      records: patchThreadRecord(s.records, "t1", { messages: [] }),
    }));

    await useThreadStore.getState().sendMessage("t1", "first user message");

    expect(getTestActiveMessages().at(-1)?.sequence).toBe(1);
  });

  it("sends the optimistic user message ID to the agent transport", async () => {
    const threadId = "t1";
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [threadId, createEmptyThreadRecord()],
      ]),
    });

    await useThreadStore.getState().sendMessage(threadId, "follow-up");

    const optimisticMessage = getTestActiveMessages().at(-1);
    const sendPayload = vi.mocked(mockTransport.sendMessage).mock.calls.at(-1)?.[0];
    expect(optimisticMessage?.role).toBe("user");
    expect(sendPayload?.messageId).toBe(optimisticMessage?.id);
  });

  it("does NOT clear toolCallRecordCache on cache hit", async () => {
    await activateTestConversation("t1");
    useThreadStore.getState().cacheToolCallRecords("t1:m1", [
      { id: "tc1", name: "Read", args: {}, result: "ok", at_ms: 0 } as never,
    ]);
    useThreadStore.setState((s) => ({
      currentThreadId: "t2",
      records: patchThreadRecord(s.records, "t2", { messages: [] }),
    }));

    await activateTestConversation("t1");
    expect(useThreadStore.getState().getCachedToolCallRecords("t1:m1")).not.toBeNull();
  });

  it("never sets messages to [] when serving from cache (no blank flash)", async () => {
    await activateTestConversation("t1");
    useThreadStore.setState((s) => ({
      currentThreadId: "t2",
      records: patchThreadRecord(s.records, "t2", { messages: [] }),
    }));

    const snapshots: typeof fakeMessages[] = [];
    const unsub = useThreadStore.subscribe((s) => {
      const id = s.currentThreadId;
      snapshots.push(id ? getThreadRecord(s.records, id).messages : []);
    });

    await activateTestConversation("t1");
    unsub();

    // Verify state updates were observed (not just an empty array)
    expect(snapshots.length).toBeGreaterThan(0);
    // Every observed messages array should be non-empty for thread t1.
    expect(snapshots.every((m) => m.length > 0)).toBe(true);
  });
});

describe("loadMessages cache synchronization", () => {
  beforeEach(() => {
    resetThreadStoreTestState();
  });

  it("synchronizes a live message into the cache", async () => {
    await activateTestConversation("t1");
    expect(getCachedRecord("t1")).toBeDefined();

    useThreadStore.getState().handleAgentEvent({ type: "message", threadId: "t1", content: "x", tokens: null } satisfies AgentEvent);
    expect(getCachedRecord("t1")?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "m1", content: "hello" }),
      expect.objectContaining({ role: "assistant", content: "x" }),
    ]));
  });

  it("evicts when handleTurnPersisted fires", async () => {
    await activateTestConversation("t1");
    expect(getCachedRecord("t1")).toBeDefined();

    useThreadStore.getState().handleTurnPersisted({
      settledMessage: null,
      threadId: "t1",
      messageId: "m1",
      toolCallCount: 0,
      filesChanged: [],
    });
    expect(getCachedRecord("t1")).toBeUndefined();
  });

  it("removes a cancelled queued Turn from the live record and conversation cache", async () => {
    await activateTestConversation("t1");
    expect(getCachedRecord("t1")).toBeDefined();

    useThreadStore.getState().removePersistedMessage("t1", "m1");

    expect(getTestActiveMessages()).toEqual([]);
    expect(getCachedRecord("t1")).toBeUndefined();
  });

  it("evicts on clearThreadState", async () => {
    await activateTestConversation("t1");
    expect(getCachedRecord("t1")).toBeDefined();

    useThreadStore.getState().clearThreadState("t1");
    expect(getCachedRecord("t1")).toBeUndefined();
  });

  it("evicts all listed threads on clearThreadStateMany", async () => {
    await activateTestConversation("t1");
    await activateTestConversation("t2");
    expect(getCachedRecord("t1")).toBeDefined();
    expect(getCachedRecord("t2")).toBeDefined();

    useThreadStore.getState().clearThreadStateMany(["t1", "t2"]);
    expect(getCachedRecord("t1")).toBeUndefined();
    expect(getCachedRecord("t2")).toBeUndefined();
  });
});
