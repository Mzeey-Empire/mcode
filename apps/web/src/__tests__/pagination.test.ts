import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TurnSnapshot } from "@mcode/contracts";
import { useThreadStore, TOOL_CALL_CACHE_SIZE } from "@/stores/threadStore";
import { cacheSnapshot, clearMessageCache, getCachedSnapshot } from "@/stores/messageCache";
import { LruCache } from "@/lib/lru-cache";
import { mockTransport, createMockMessage } from "./mocks/transport";
import type { Message } from "@/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

/** Verifies cursor-based pagination: loadOlderMessages behavior and guards. */
describe("Chat Pagination", () => {
  const threadId = "thread-1";

  beforeEach(() => {
    clearMessageCache();
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(),
      loading: false,
      errorByThread: {},
      streamingByThread: {},
      toolCallsByThread: {},
      currentThreadId: threadId,
      persistedToolCallCounts: {},
      serverMessageIds: {},
      toolCallRecordCache: new LruCache(TOOL_CALL_CACHE_SIZE),
      currentTurnMessageIdByThread: {},
      agentStartTimes: {},
      settingsByThread: {},
      activeSubagentsByThread: {},
      oldestLoadedSequence: {},
      hasMoreMessages: {},
      isLoadingMore: {},
      loadEpochByThread: {},
      persistedFilesChanged: {},
      latestTurnWithChanges: null,
      answeredPlanMessageIdsByThread: {},
    });
    vi.clearAllMocks();
  });

  it("loadMessages sets pagination state from initial load", async () => {
    const messages = [
      createMockMessage({ id: "m1", thread_id: threadId, sequence: 51 }),
      createMockMessage({ id: "m2", thread_id: threadId, sequence: 52 }),
    ];
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages,
      hasMore: true,
    });

    await useThreadStore.getState().loadMessages(threadId);

    const state = useThreadStore.getState();
    expect(state.messages).toEqual(messages);
    expect(state.oldestLoadedSequence[threadId]).toBe(51);
    expect(state.hasMoreMessages[threadId]).toBe(true);
  });

  it("loadOlderMessages prepends older messages and updates cursor", async () => {
    const initialMessages = [
      createMockMessage({ id: "m3", thread_id: threadId, sequence: 51 }),
      createMockMessage({ id: "m4", thread_id: threadId, sequence: 52 }),
    ];
    useThreadStore.setState({
      currentThreadId: threadId,
      messages: initialMessages,
      oldestLoadedSequence: { [threadId]: 51 },
      hasMoreMessages: { [threadId]: true },
      isLoadingMore: {},
    });

    const olderMessages = [
      createMockMessage({ id: "m1", thread_id: threadId, sequence: 1 }),
      createMockMessage({ id: "m2", thread_id: threadId, sequence: 2 }),
    ];
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: olderMessages,
      hasMore: false,
    });

    await useThreadStore.getState().loadOlderMessages(threadId);

    const state = useThreadStore.getState();
    expect(state.messages).toHaveLength(4);
    expect(state.messages[0].id).toBe("m1");
    expect(state.messages[1].id).toBe("m2");
    expect(state.messages[2].id).toBe("m3");
    expect(state.messages[3].id).toBe("m4");
    expect(state.oldestLoadedSequence[threadId]).toBe(1);
    expect(state.hasMoreMessages[threadId]).toBe(false);
    expect(state.isLoadingMore[threadId]).toBe(false);
    expect(mockTransport.getMessages).toHaveBeenCalledWith(threadId, 50, 51);
  });

  it("loadOlderMessages is a no-op when hasMore is false", async () => {
    useThreadStore.setState({
      currentThreadId: threadId,
      messages: [createMockMessage({ id: "m1", thread_id: threadId, sequence: 1 })],
      oldestLoadedSequence: { [threadId]: 1 },
      hasMoreMessages: { [threadId]: false },
    });

    await useThreadStore.getState().loadOlderMessages(threadId);

    expect(mockTransport.getMessages).not.toHaveBeenCalled();
  });

  it("loadOlderMessages deduplicates concurrent calls", async () => {
    useThreadStore.setState({
      currentThreadId: threadId,
      messages: [createMockMessage({ id: "m2", thread_id: threadId, sequence: 2 })],
      oldestLoadedSequence: { [threadId]: 2 },
      hasMoreMessages: { [threadId]: true },
      isLoadingMore: { [threadId]: true },
    });

    await useThreadStore.getState().loadOlderMessages(threadId);

    expect(mockTransport.getMessages).not.toHaveBeenCalled();
  });

  it("loadOlderMessages discards results for a stale thread", async () => {
    useThreadStore.setState({
      currentThreadId: threadId,
      messages: [createMockMessage({ id: "m2", thread_id: threadId, sequence: 2 })],
      oldestLoadedSequence: { [threadId]: 2 },
      hasMoreMessages: { [threadId]: true },
    });

    let resolveGetMessages!: (result: { messages: Message[]; hasMore: boolean }) => void;
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { resolveGetMessages = resolve; }),
    );

    const loadPromise = useThreadStore.getState().loadOlderMessages(threadId);

    // Switch to a different thread before the fetch resolves
    useThreadStore.setState({ currentThreadId: "thread-other" });

    resolveGetMessages({
      messages: [createMockMessage({ id: "m1", thread_id: threadId, sequence: 1 })],
      hasMore: false,
    });
    await loadPromise;

    const state = useThreadStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].id).toBe("m2");
    expect(state.isLoadingMore[threadId]).toBe(false);
  });

  it("loadOlderMessages discards results when epoch changes (A->B->A switch)", async () => {
    useThreadStore.setState({
      currentThreadId: threadId,
      messages: [createMockMessage({ id: "m2", thread_id: threadId, sequence: 2 })],
      oldestLoadedSequence: { [threadId]: 2 },
      hasMoreMessages: { [threadId]: true },
      loadEpochByThread: { [threadId]: 1 },
    });

    let resolveGetMessages!: (result: { messages: Message[]; hasMore: boolean }) => void;
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { resolveGetMessages = resolve; }),
    );

    const loadPromise = useThreadStore.getState().loadOlderMessages(threadId);

    // Simulate A->B->A: loadMessages increments epoch while fetch is in-flight
    useThreadStore.setState((s) => ({
      loadEpochByThread: { ...s.loadEpochByThread, [threadId]: 2 },
    }));

    resolveGetMessages({
      messages: [createMockMessage({ id: "m1", thread_id: threadId, sequence: 1 })],
      hasMore: false,
    });
    await loadPromise;

    // Stale response should be discarded - messages unchanged
    const state = useThreadStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].id).toBe("m2");
    expect(state.isLoadingMore[threadId]).toBe(false);
  });

  it("loadOlderMessages writes async snapshot file lists into the message cache", async () => {
    const mOldId = "m-old";
    const initialMessages = [
      createMockMessage({ id: "m3", thread_id: threadId, sequence: 51 }),
    ];
    useThreadStore.setState({
      currentThreadId: threadId,
      messages: initialMessages,
      oldestLoadedSequence: { [threadId]: 51 },
      hasMoreMessages: { [threadId]: true },
      isLoadingMore: {},
      persistedFilesChanged: { m3: ["kept.ts"] },
      latestTurnWithChanges: "m3",
    });
    cacheSnapshot(threadId, {
      messages: initialMessages,
      oldestLoadedSequence: 51,
      hasMoreMessages: true,
      persistedToolCallCounts: {},
      persistedFilesChanged: { m3: ["kept.ts"] },
      latestTurnWithChanges: "m3",
      answeredPlanMessageIds: [],
    });

    const olderMessages = [
      createMockMessage({ id: mOldId, thread_id: threadId, sequence: 1 }),
    ];
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      messages: olderMessages,
      hasMore: false,
    });

    const snap: TurnSnapshot = {
      id: "snap-1",
      message_id: mOldId,
      thread_id: threadId,
      ref_before: "a",
      ref_after: "b",
      files_changed: ["legacy.ts"],
      worktree_path: null,
      created_at: new Date().toISOString(),
    };
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValueOnce([snap]);

    await useThreadStore.getState().loadOlderMessages(threadId);
    expect(useThreadStore.getState().persistedFilesChanged[mOldId]).toEqual(["legacy.ts"]);

    const cached = getCachedSnapshot(threadId);
    expect(cached?.persistedFilesChanged[mOldId]).toEqual(["legacy.ts"]);
    expect(cached?.persistedFilesChanged.m3).toEqual(["kept.ts"]);
  });

  it("loadOlderMessages resets isLoadingMore on network error", async () => {
    useThreadStore.setState({
      currentThreadId: threadId,
      messages: [createMockMessage({ id: "m2", thread_id: threadId, sequence: 2 })],
      oldestLoadedSequence: { [threadId]: 2 },
      hasMoreMessages: { [threadId]: true },
    });

    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Network error"),
    );

    await useThreadStore.getState().loadOlderMessages(threadId);

    const state = useThreadStore.getState();
    expect(state.isLoadingMore[threadId]).toBe(false);
    expect(state.messages).toHaveLength(1);
  });
});
