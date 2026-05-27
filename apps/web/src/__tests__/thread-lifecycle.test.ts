import {
  resetThreadStoreForTests,
  applyLegacyThreadStoreSeed,
  getTestActiveMessages,
  getTestThreadStreaming,
  getTestThreadError,
  readActiveThreadField,
} from "@/stores/thread-store-test-utils";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockMessage } from "./mocks/transport";
import { clearRecordCache } from "@/lib/thread-hydrator/record-cache";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("Thread Lifecycle Behavior", () => {
  beforeEach(() => {
    clearRecordCache();
    resetThreadStoreForTests();
    vi.clearAllMocks();
  });

  it("when the user sends a message, the thread is marked as running", async () => {
    const threadId = "thread-1";
    await useThreadStore.getState().sendMessage(threadId, "Hello");

    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(true);
  });

  it("when the user stops an agent, the thread is no longer running", async () => {
    const threadId = "thread-1";
    useThreadStore.setState({
      runningThreadIds: new Set([threadId]),
    });

    await useThreadStore.getState().stopAgent(threadId);

    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(
      false,
    );
  });

  it("when stopAgent fails, the thread is still marked as not running", async () => {
    const threadId = "thread-1";
    useThreadStore.setState({
      runningThreadIds: new Set([threadId]),
    });
    (
      mockTransport.stopAgent as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("connection lost"));

    await useThreadStore.getState().stopAgent(threadId);

    // Should still be cleared even on error
    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(
      false,
    );
    expect(getTestThreadError("thread-1")).toBeTruthy();
  });

  it("when sendMessage fails, the thread is no longer marked as running", async () => {
    const threadId = "thread-1";
    (
      mockTransport.sendMessage as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("spawn failed"));

    await useThreadStore.getState().sendMessage(threadId, "Hello");

    expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(
      false,
    );
    expect(getTestThreadError("thread-1")).toBeTruthy();
  });

  it("when clearMessages is called, streaming state resets but running threads persist", () => {
    const msg = createMockMessage({
      id: "1",
      thread_id: "t",
      content: "hi",
    });
    applyLegacyThreadStoreSeed({
      messages: [msg],
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1"]),
      streamingByThread: { "thread-1": "partial" },
    });

    useThreadStore.getState().clearMessages();

    const state = useThreadStore.getState();
    expect(getTestActiveMessages()).toHaveLength(0);
    // Only the current thread's streaming entry should be pruned
    expect(getTestThreadStreaming("thread-1")).toBeUndefined();
    // Running threads should NOT be cleared by clearMessages
    expect(state.runningThreadIds.has("thread-1")).toBe(true);
  });

  it("when loadMessages is called, it sets the current thread and fetches messages", async () => {
    const threadId = "thread-1";
    const msgs = [
      createMockMessage({ thread_id: threadId, sequence: 1 }),
      createMockMessage({ thread_id: threadId, sequence: 2 }),
    ];
    (
      mockTransport.getMessages as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ messages: msgs, hasMore: false });

    await useThreadStore.getState().loadMessages(threadId);

    const state = useThreadStore.getState();
    expect(state.currentThreadId).toBe(threadId);
    expect(getTestActiveMessages()).toEqual(msgs);
    expect(readActiveThreadField((r) => r.loading) ?? false).toBe(false);
  });

  it("when loadMessages fails, the error is captured", async () => {
    const threadId = "thread-1";
    (
      mockTransport.getMessages as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("db connection failed"));

    await useThreadStore.getState().loadMessages(threadId);

    expect(getTestThreadError("thread-1")).toContain("db connection failed");
    expect(readActiveThreadField((r) => r.loading) ?? false).toBe(false);
  });
});
