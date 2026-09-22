import type { AgentEvent, NarrativeEntry } from "@mcode/contracts";
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
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore, MESSAGE_FETCH_SIZE } from "@/stores/threadStore";
import { getThreadRecord } from "@/stores/thread-record";
import { clearRecordCache, getCachedRecord } from "@/features/conversation/hydration/record-cache";
import {
  ACTIVE_CONVERSATION_BYTES,
  CONVERSATION_NARRATIVE_BYTES,
  measureConversationValue,
} from "@/features/conversation/hydration/conversation-memory-policy";
import { mockTransport, createMockMessage } from "./mocks/transport";

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
    expect(getTestActiveMessages()).toEqual(fakeMessages);
    expect(getCachedRecord("t1")).toBeDefined();
    expect(getCachedRecord("t1")?.messages).toEqual(fakeMessages);
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
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(false);

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
    await useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1");

    expect(mockTransport.loadTurn).toHaveBeenCalledTimes(1);
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(false);

    await useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1");

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

  it("lets the render caused by a full detail window request its continuation", async () => {
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
      .mockResolvedValueOnce(firstWindow)
      .mockResolvedValueOnce([
        {
          kind: "toolCall",
          sequence: assistant.sequence,
          sortOrder: 100,
          record: { ...command, id: "effect-tool-100", sort_order: 100 },
        },
      ] satisfies NarrativeEntry[]);

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

    expect(mockTransport.loadTurn).toHaveBeenCalledTimes(2);
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(true);
    expect(getThreadRecord(useThreadStore.getState().records, "t1")
      .narrativeByMessage[assistant.id]?.tools.map((record) => record.id))
      .toEqual(Array.from({ length: 101 }, (_, index) => `effect-tool-${index}`));
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
    await useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1");
    await useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1");

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

  it("keeps detail through a virtual-row handoff and evicts after the final row releases", async () => {
    const assistant = createMockMessage({ id: "assistant-lease", thread_id: "t1", role: "assistant" });
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [assistant], hasMore: false, narrativeByMessage: {},
    });
    (mockTransport.loadTurn as ReturnType<typeof vi.fn>).mockResolvedValue([
      { kind: "assistantMessage", messageId: assistant.id, sequence: 1, body: "done", sortOrder: 0 },
    ] satisfies NarrativeEntry[]);

    await activateTestConversation("t1");
    await useThreadStore.getState().loadNarrativeForMessage(assistant.id, "t1");
    useThreadStore.getState().retainNarrativeForMessage(assistant.id, "t1");
    useThreadStore.getState().retainNarrativeForMessage(assistant.id, "t1");
    useThreadStore.getState().releaseNarrativeForMessage(assistant.id, "t1");
    await Promise.resolve();

    expect(getThreadRecord(useThreadStore.getState().records, "t1").narrativeByMessage[assistant.id]).toBeDefined();

    useThreadStore.getState().releaseNarrativeForMessage(assistant.id, "t1");
    await Promise.resolve();

    expect(getThreadRecord(useThreadStore.getState().records, "t1").narrativeByMessage[assistant.id]).toBeUndefined();
    expect(useThreadStore.getState().isNarrativeLoaded("t1", assistant.id)).toBe(false);
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
    expect(getTestActiveMessages()).toEqual(fakeMessages);
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
