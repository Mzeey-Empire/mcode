/**
 * Tests that loadMessages() skips the listSnapshots RPC when a thread has no
 * file changes (has_file_changes === false), and falls back to calling it when
 * has_file_changes is true or when the thread record is absent from the workspace
 * store (race condition during initial workspace load).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore, TOOL_CALL_CACHE_SIZE, MESSAGE_FETCH_SIZE } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { clearMessageCache } from "@/stores/messageCache";
import { mockTransport, createMockMessage, createMockThread } from "./mocks/transport";
import { LruCache } from "@/lib/lru-cache";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-skip-rpc-test";

const fakeMessages = [
  createMockMessage({ id: "m1", thread_id: THREAD_ID, content: "hello" }),
];

/**
 * Reset both stores and mock state to a clean baseline before each test.
 */
function resetState() {
  clearMessageCache();
  vi.clearAllMocks();

  (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
    messages: fakeMessages,
    hasMore: false,
  });
  (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  useThreadStore.setState({
    messages: [],
    currentThreadId: null,
    runningThreadIds: new Set<string>(),
    loading: false,
    errorByThread: {},
    streamingByThread: {},
    streamingPreviewByThread: {},
    toolCallsByThread: {},
    persistedToolCallCounts: {},
    persistedFilesChanged: {},
    latestTurnWithChanges: null,
    serverMessageIds: {},
    toolCallRecordCache: new LruCache(TOOL_CALL_CACHE_SIZE),
    currentTurnMessageIdByThread: {},
    agentStartTimes: {},
    settingsByThread: {},
    oldestLoadedSequence: {},
    hasMoreMessages: {},
    isLoadingMore: {},
    loadEpochByThread: {},
    contextByThread: {},
    usageByProvider: {},
    isCompactingByThread: {},
    lastFallbackByThread: {},
    planQuestionsByThread: {},
    planAnswersByThread: {},
    activeQuestionIndexByThread: {},
    planQuestionsStatusByThread: {},
    permissionsByThread: {},
  });

  // Reset workspace store threads
  useWorkspaceStore.setState({ threads: [] });
}

describe("loadMessages - listSnapshots RPC gating", () => {
  beforeEach(() => {
    resetState();
  });

  it("does NOT call listSnapshots when thread has has_file_changes = false", async () => {
    const thread = createMockThread({ id: THREAD_ID, has_file_changes: false });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore.getState().loadMessages(THREAD_ID);

    // Allow any async microtasks to flush
    await vi.waitFor(() => {
      expect(mockTransport.getMessages).toHaveBeenCalledWith(THREAD_ID, MESSAGE_FETCH_SIZE);
    });

    expect(mockTransport.listSnapshots).not.toHaveBeenCalled();
  });

  it("DOES call listSnapshots once when thread has has_file_changes = true", async () => {
    const thread = createMockThread({ id: THREAD_ID, has_file_changes: true });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore.getState().loadMessages(THREAD_ID);

    // listSnapshots is fired in a void async block - wait for it to resolve
    await vi.waitFor(() => {
      expect(mockTransport.listSnapshots).toHaveBeenCalledTimes(1);
    });

    expect(mockTransport.listSnapshots).toHaveBeenCalledWith(THREAD_ID);
  });

  it("falls back to calling listSnapshots when thread record is absent from workspace store (race condition)", async () => {
    // Workspace store has no threads - simulates a race during initial workspace load
    useWorkspaceStore.setState({ threads: [] });

    await useThreadStore.getState().loadMessages(THREAD_ID);

    await vi.waitFor(() => {
      expect(mockTransport.listSnapshots).toHaveBeenCalledTimes(1);
    });

    expect(mockTransport.listSnapshots).toHaveBeenCalledWith(THREAD_ID);
  });
});

describe("loadMessages (cache-hit) - hydration staleness gate", () => {
  beforeEach(() => {
    resetState();
  });

  it("skips listPendingPermissions and getThreadTasks on a cache-hit within the staleness window", async () => {
    const thread = createMockThread({ id: THREAD_ID, has_file_changes: false });
    useWorkspaceStore.setState({ threads: [thread] });

    // First load: cache-miss path populates cache AND stamps lastHydratedByThread.
    await useThreadStore.getState().loadMessages(THREAD_ID);
    await vi.waitFor(() => {
      expect(mockTransport.getMessages).toHaveBeenCalledWith(THREAD_ID, MESSAGE_FETCH_SIZE);
    });

    // Switch away so the next load is a cache-hit.
    useThreadStore.setState({ currentThreadId: "other-thread" });
    vi.clearAllMocks();

    // Second load within 2s of the first - the gate should suppress both side-effect RPCs.
    await useThreadStore.getState().loadMessages(THREAD_ID);
    // Give any erroneously-scheduled microtasks a chance to fire.
    await new Promise((r) => setTimeout(r, 20));

    expect(mockTransport.getMessages).not.toHaveBeenCalled();
    expect(mockTransport.listPendingPermissions).not.toHaveBeenCalled();
    expect(mockTransport.getThreadTasks).not.toHaveBeenCalled();
  });

  it("calls side-effect RPCs again once the staleness window has elapsed", async () => {
    const thread = createMockThread({ id: THREAD_ID, has_file_changes: false });
    useWorkspaceStore.setState({ threads: [thread] });

    await useThreadStore.getState().loadMessages(THREAD_ID);
    await vi.waitFor(() => {
      expect(mockTransport.getMessages).toHaveBeenCalledWith(THREAD_ID, MESSAGE_FETCH_SIZE);
    });

    // Simulate ">2s ago" by rewinding the hydration timestamp.
    useThreadStore.setState({
      currentThreadId: "other-thread",
      lastHydratedByThread: { [THREAD_ID]: Date.now() - 5000 },
    });
    vi.clearAllMocks();

    await useThreadStore.getState().loadMessages(THREAD_ID);

    await vi.waitFor(() => {
      expect(mockTransport.listPendingPermissions).toHaveBeenCalledWith(THREAD_ID);
      expect(mockTransport.getThreadTasks).toHaveBeenCalledWith(THREAD_ID);
    });
  });
});
