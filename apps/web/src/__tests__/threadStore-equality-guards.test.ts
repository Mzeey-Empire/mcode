import {
  activateTestConversation,
  resetThreadStoreForTests,
} from "@/stores/thread-store-test-utils";
/**
 * Tests for the equality guards added to loadMessages() that prevent
 * redundant set() calls when getThreadTasks
 * resolves with data identical to what is already in the store.
 *
 * Both the cache-hit path (side-effect refresh) and the cache-miss path
 * (post-getMessages hydration) are exercised.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useTaskStore } from "@/stores/taskStore";
import {
  cacheRecord,
  clearRecordCache,
  getCachedRecord,
} from "@/features/conversation/hydration/record-cache";
import { mockTransport, createMockMessage } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD_ID = "thread-equality-guard-test";

const fakeMessages = [
  createMockMessage({ id: "m1", thread_id: THREAD_ID, content: "hello", sequence: 1 }),
];

/** Reset all relevant stores and mocks to a clean baseline. */
function resetState() {
  clearRecordCache();
  vi.clearAllMocks();

  (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
    messages: fakeMessages,
    hasMore: false,
  });
  (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue(null);

  resetThreadStoreForTests();

  // Pre-populate workspace with a thread record that has no file changes so that
  // loadMessages takes the synchronous cacheRecord path instead of the async
  // listSnapshots path. This is critical for warmCache() to work correctly.
  useWorkspaceStore.setState({
    threads: [
      {
        id: THREAD_ID,
        workspace_id: "ws-1",
        title: "Test thread",
        status: "active" as const,
        mode: "direct" as const,
        worktree_path: null,
        branch: "main",
        checkout_state: "named" as const,
        base_branch: null,
        head_sha: null,
        worktree_managed: false,
        issue_number: null,
        pr_number: null,
        pr_status: null,
        has_file_changes: false,
        sdk_session_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        model: null,
        provider: "claude",
        deleted_at: null,
        user_completed_at: null,
    scheduled_deletion_at: null,
    scheduled_resume: null,
    cleanup_state: null,
    cleanup_reason: null,
        last_context_tokens: null,
        context_window: null,
        reasoning_level: null,
    interaction_mode: null,
    orchestration_mode: null,
        permission_mode: null,
        context_window_mode: null,
        thinking: null,
        codex_fast_mode: null,
    devin_mode: null,
        parent_thread_id: null,
        forked_from_message_id: null,
        last_compact_summary: null,
        plan_phase: null,
        default_open_in_app: null,
      },
    ],
  });

  useTaskStore.setState({ tasksByThread: {} });
}

/** Age the cache-owned freshness marker so cache-hit equality guards run their RPC handlers. */
function ageCachedHydration(): void {
  const cached = getCachedRecord(THREAD_ID);
  expect(cached).toBeDefined();
  cacheRecord(THREAD_ID, { ...cached!, lastHydratedAt: Date.now() - 5000 });
}

// ---------------------------------------------------------------------------
// Cache-miss path: guards on the post-getMessages hydration handlers
// ---------------------------------------------------------------------------

describe("loadMessages (cache-miss) - getThreadTasks equality guard", () => {
  beforeEach(() => {
    resetState();
  });

  it("does NOT call setTasks when resolved tasks match existing store values", async () => {
    const existingTasks = [{ id: "0", content: "Run tests", status: "pending" as const, group: "Tasks" }];
    useTaskStore.setState({ tasksByThread: { [THREAD_ID]: existingTasks } });

    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { content: "Run tests", status: "pending" },
    ]);

    const tasksBefore = useTaskStore.getState().tasksByThread[THREAD_ID];

    await activateTestConversation(THREAD_ID);

    await vi.waitFor(() => {
      expect(mockTransport.getThreadTasks).toHaveBeenCalledWith(THREAD_ID);
    });

    await Promise.resolve();

    // Same reference means setTasks was NOT called (equality guard suppressed the update).
    expect(useTaskStore.getState().tasksByThread[THREAD_ID]).toBe(tasksBefore);
  });

  it("DOES call setTasks when resolved tasks differ from existing store values", async () => {
    // Store has a completed task; server returns pending.
    useTaskStore.setState({
      tasksByThread: {
        [THREAD_ID]: [{ id: "0", content: "Run tests", status: "completed" as const, group: "Tasks" }],
      },
    });

    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { content: "Run tests", status: "pending" },
    ]);

    const tasksBefore = useTaskStore.getState().tasksByThread[THREAD_ID];

    await activateTestConversation(THREAD_ID);

    await vi.waitFor(() => {
      expect(mockTransport.getThreadTasks).toHaveBeenCalledWith(THREAD_ID);
    });

    await Promise.resolve();

    const tasksAfter = useTaskStore.getState().tasksByThread[THREAD_ID];
    // Different reference means setTasks was called (data changed).
    expect(tasksAfter).not.toBe(tasksBefore);
    expect(tasksAfter).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "Run tests", status: "pending" })]),
    );
  });
});

// ---------------------------------------------------------------------------
// Cache-hit path: guards on the side-effect refresh after restoring from cache
// ---------------------------------------------------------------------------

describe("loadMessages (cache-hit) - getThreadTasks equality guard", () => {
  beforeEach(() => {
    resetState();
  });

  /**
   * Warm the message cache by triggering a cache-miss load on THREAD_ID,
   * then reset currentThreadId so the second load for a different thread
   * will cause a cache-hit when we switch back.
   *
   * The workspace thread record has has_file_changes=false (set in resetState),
   * so loadMessages takes the synchronous cacheRecord path, guaranteeing
   * the cache is populated before we switch threads.
   */
  async function warmCache() {
    await activateTestConversation(THREAD_ID);
    await vi.waitFor(() => {
      expect(getCachedRecord(THREAD_ID)).toBeDefined();
    });
    resetThreadStoreForTests({ currentThreadId: "other-thread" });
    ageCachedHydration();
    vi.clearAllMocks();
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  }

  it("does NOT call setTasks on cache-hit when tasks are unchanged", async () => {
    await warmCache();

    const existingTasks = [{ id: "0", content: "Deploy", status: "in_progress" as const, group: "Tasks" }];
    useTaskStore.setState({ tasksByThread: { [THREAD_ID]: existingTasks } });

    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { content: "Deploy", status: "in_progress" },
    ]);

    const tasksBefore = useTaskStore.getState().tasksByThread[THREAD_ID];

    await activateTestConversation(THREAD_ID);

    await vi.waitFor(() => {
      expect(mockTransport.getThreadTasks).toHaveBeenCalledWith(THREAD_ID);
    });

    await Promise.resolve();

    expect(mockTransport.getMessages).not.toHaveBeenCalled();
    // Same reference means setTasks was NOT called (equality guard suppressed the update).
    expect(useTaskStore.getState().tasksByThread[THREAD_ID]).toBe(tasksBefore);
  });

  it("DOES call setTasks on cache-hit when task content changed", async () => {
    await warmCache();

    useTaskStore.setState({
      tasksByThread: {
        [THREAD_ID]: [{ id: "0", content: "Old task", status: "pending" as const, group: "Tasks" }],
      },
    });

    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { content: "New task", status: "pending" },
    ]);

    const tasksBefore = useTaskStore.getState().tasksByThread[THREAD_ID];

    await activateTestConversation(THREAD_ID);

    await vi.waitFor(() => {
      expect(mockTransport.getThreadTasks).toHaveBeenCalledWith(THREAD_ID);
    });

    await Promise.resolve();

    const tasksAfter = useTaskStore.getState().tasksByThread[THREAD_ID];
    // Different reference means setTasks was called (data changed).
    expect(tasksAfter).not.toBe(tasksBefore);
    expect(tasksAfter).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "New task" })]),
    );
  });
});
