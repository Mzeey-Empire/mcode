import {
  applyLegacyThreadStoreSeed,
  getTestActiveMessages,
  getTestActiveLatestTurnWithChanges,
  getTestThreadStreaming,
  getTestThreadToolCalls,
  getTestThreadError,
  getTestThreadLoadEpoch,
  getTestThreadPlanQuestionsStatus,
  readActiveThreadField,
  hasTestThreadRecord,
} from "@/stores/thread-store-test-utils";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockThread } from "./mocks/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useToastStore } from "@/stores/toastStore";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

/**
 * Tests that agent events from one thread do not leak into another thread's
 * UI state. Covers the cross-thread isolation contract for error state,
 * toast notifications, panel side-effects, and per-thread map cleanup.
 */
describe("Agent event thread isolation", () => {
  const THREAD_A = "thread-a";
  const THREAD_B = "thread-b";

  beforeEach(() => {
    vi.useFakeTimers();
    applyLegacyThreadStoreSeed({
      messages: [],
      runningThreadIds: new Set([THREAD_A, THREAD_B]),
      loading: false,
      errorByThread: {},
      streamingByThread: {},
      streamingPreviewByThread: {},
      toolCallsByThread: {},
      agentStartTimes: {
        [THREAD_A]: Date.now(),
        [THREAD_B]: Date.now(),
      },
      currentThreadId: THREAD_A,
      currentTurnMessageIdByThread: {},
      isCompactingByThread: {},
      lastFallbackByThread: {},
      contextByThread: {},
    });
    useWorkspaceStore.setState({
      activeThreadId: THREAD_A,
      threads: [
        createMockThread({ id: THREAD_A, workspace_id: "ws-1", title: "A", branch: "main" }),
        createMockThread({ id: THREAD_B, workspace_id: "ws-1", title: "B", branch: "feat" }),
      ],
    });
    useToastStore.setState({ toasts: [] });
    vi.clearAllMocks();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback): number => {
      queueMicrotask(() => {
        cb(0);
      });
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Error isolation ──────────────────────────────────────────────────

  describe("error isolation", () => {
    it("session.error for background thread does not set error on active thread", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      // Thread B errors while user views Thread A
      handleAgentEvent(THREAD_B, {
        method: "session.error",
        error: "Out of tokens",
      });

      // Thread B's error is recorded under its own key
      expect(getTestThreadError(THREAD_B)).toBe("Out of tokens");
      // Thread A has no error
      expect(getTestThreadError(THREAD_A)).toBeUndefined();
    });

    it("session.error for active thread sets error on that thread only", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_A, {
        method: "session.error",
        error: "CLI not found",
      });

      expect(getTestThreadError(THREAD_A)).toBe("CLI not found");
      expect(getTestThreadError(THREAD_B)).toBeUndefined();
    });

    it("errors from two concurrent threads are tracked independently", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_A, {
        method: "session.error",
        error: "Error A",
      });
      handleAgentEvent(THREAD_B, {
        method: "session.error",
        error: "Error B",
      });

      expect(getTestThreadError(THREAD_A)).toBe("Error A");
      expect(getTestThreadError(THREAD_B)).toBe("Error B");
    });

    it("loadMessages clears error for the loaded thread", async () => {
      applyLegacyThreadStoreSeed({
        errorByThread: { [THREAD_A]: "stale error", [THREAD_B]: "other error" },
      });
      (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        messages: [],
        hasMore: false,
      });

      await useThreadStore.getState().loadMessages(THREAD_A);

      expect(getTestThreadError(THREAD_A)).toBeUndefined();
      // Thread B's error is preserved
      expect(getTestThreadError(THREAD_B)).toBe("other error");
    });
  });

  // ── Toast isolation ──────────────────────────────────────────────────

  describe("modelFallback toast isolation", () => {
    it("does not show toast when modelFallback fires on a background thread", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_B, {
        method: "session.modelFallback",
        requestedModel: "claude-opus-4-6",
        actualModel: "claude-haiku-4-5-20251001",
      });

      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it("shows toast when modelFallback fires on the active thread", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_A, {
        method: "session.modelFallback",
        requestedModel: "claude-opus-4-6",
        actualModel: "claude-haiku-4-5-20251001",
      });

      expect(useToastStore.getState().toasts).toHaveLength(1);
    });
  });

  // ── TodoWrite panel isolation ────────────────────────────────────────

  describe("TodoWrite panel isolation", () => {
    it("does not open task panel when TodoWrite fires on a background thread", async () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_B, {
        method: "session.toolUse",
        toolCallId: "tc-todo",
        toolName: "TodoWrite",
        toolInput: { todos: [{ id: "0", content: "Plan", status: "in_progress" }] },
      });

      // Give the dynamic import time to resolve
      if (vi.dynamicImportSettled) {
        await vi.dynamicImportSettled();
      } else {
        vi.advanceTimersByTime(0);
      }
      await Promise.resolve();

      const { useDiffStore } = await import("@/stores/diffStore");
      expect(useDiffStore.getState().rightPanelByThread[THREAD_A]?.visible).toBeFalsy();
    });

    it("does not auto-open task panel on TodoWrite", async () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_A, {
        method: "session.toolUse",
        toolCallId: "tc-todo",
        toolName: "TodoWrite",
        toolInput: { todos: [{ id: "0", content: "Plan", status: "in_progress" }] },
      });

      await vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();

      const { useDiffStore } = await import("@/stores/diffStore");
      expect(useDiffStore.getState().rightPanelByThread[THREAD_A]?.visible).toBeFalsy();
    });
  });

  // ── Streaming isolation ──────────────────────────────────────────────

  describe("streaming text isolation", () => {
    it("textDelta for background thread does not appear in active thread's streaming", async () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_B, {
        method: "session.textDelta",
        delta: "background text",
      });

      for (let i = 0; i < 8; i++) {
        await Promise.resolve();
      }
      expect(getTestThreadStreaming(THREAD_A)).toBeUndefined();
      expect(getTestThreadStreaming(THREAD_B)).toBe("background text");
    });

    it("turnComplete for background thread does not add message to active thread's messages", () => {
      applyLegacyThreadStoreSeed({
        streamingByThread: { [THREAD_B]: "background content" },
      });

      useThreadStore.getState().handleAgentEvent(THREAD_B, {
        method: "session.turnComplete",
        costUsd: null,
        totalTokensIn: 100,
        totalTokensOut: 50,
      });
      vi.runAllTimers();

      // No message added to the visible list (user is on Thread A)
      expect(getTestActiveMessages()).toHaveLength(0);
      // Streaming state is cleaned up for Thread B
      expect(getTestThreadStreaming(THREAD_B)).toBeUndefined();
    });
  });

  // ── Tool call isolation ──────────────────────────────────────────────

  describe("tool call isolation", () => {
    it("toolUse for background thread does not contaminate active thread's tool calls", () => {
      const { handleAgentEvent } = useThreadStore.getState();

      handleAgentEvent(THREAD_B, {
        method: "session.toolUse",
        toolCallId: "tc-bg",
        toolName: "Read",
        toolInput: { path: "/bg" },
      });

      expect(getTestThreadToolCalls(THREAD_A)).toEqual([]);
      expect(getTestThreadToolCalls(THREAD_B)).toHaveLength(1);
    });
  });

  // ── Per-thread map cleanup on deletion ─────────────────────────────

  describe("clearThreadState", () => {
    it("removes all per-thread map entries for a background thread", () => {
      applyLegacyThreadStoreSeed({
        errorByThread: { [THREAD_A]: "kept", [THREAD_B]: "zombie" },
        streamingByThread: { [THREAD_A]: "kept-stream", [THREAD_B]: "zombie-stream" },
        loadEpochByThread: { [THREAD_A]: 1, [THREAD_B]: 99 },
        planQuestionsStatusByThread: { [THREAD_A]: "idle", [THREAD_B]: "pending" },
        runningThreadIds: new Set([THREAD_A, THREAD_B]),
        currentThreadId: null,
      });

      useThreadStore.getState().clearThreadState(THREAD_B);

      expect(hasTestThreadRecord(THREAD_B)).toBe(false);
      expect(getTestThreadError(THREAD_A)).toBe("kept");
      expect(getTestThreadStreaming(THREAD_A)).toBe("kept-stream");
      expect(getTestThreadLoadEpoch(THREAD_A)).toBe(1);
      expect(getTestThreadPlanQuestionsStatus(THREAD_A)).toBe("idle");
    });

    it("removes threadId from runningThreadIds", () => {
      useThreadStore.setState({
        runningThreadIds: new Set([THREAD_A, THREAD_B]),
      });

      useThreadStore.getState().clearThreadState(THREAD_B);

      const state = useThreadStore.getState();
      expect(state.runningThreadIds.has(THREAD_B)).toBe(false);
      expect(state.runningThreadIds.has(THREAD_A)).toBe(true);
    });

    it("clears visible-thread globals when deleting the current thread", () => {
      applyLegacyThreadStoreSeed({
        currentThreadId: THREAD_A,
        messages: [{ id: "m1", thread_id: THREAD_A, role: "user", content: "hi", tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, timestamp: "", sequence: 1, attachments: null }],
        persistedToolCallCounts: { m1: 2 },
        persistedFilesChanged: { m1: ["foo.ts"] },
        serverMessageIds: { m1: "server-m1" },
        latestTurnWithChanges: "m1",
      });

      useThreadStore.getState().clearThreadState(THREAD_A);

      const state = useThreadStore.getState();
      expect(state.currentThreadId).toBeNull();
      expect(getTestActiveMessages()).toHaveLength(0);
      expect(readActiveThreadField((r) => r.persistedToolCallCounts) ?? {}).toEqual({});
      expect(readActiveThreadField((r) => r.persistedFilesChanged) ?? {}).toEqual({});
      expect(readActiveThreadField((r) => r.serverMessageIds) ?? {}).toEqual({});
      expect(getTestActiveLatestTurnWithChanges()).toBeNull();
    });

    it("does not clear visible-thread globals when deleting a background thread", () => {
      applyLegacyThreadStoreSeed({
        currentThreadId: THREAD_A,
        messages: [{ id: "m1", thread_id: THREAD_A, role: "user", content: "hi", tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null, timestamp: "", sequence: 1, attachments: null }],
        persistedToolCallCounts: { m1: 2 },
      });

      useThreadStore.getState().clearThreadState(THREAD_B);

      const state = useThreadStore.getState();
      expect(state.currentThreadId).toBe(THREAD_A);
      expect(getTestActiveMessages()).toHaveLength(1);
      expect(readActiveThreadField((r) => r.persistedToolCallCounts) ?? {}).toEqual({ m1: 2 });
    });
  });
});
