import {
  applyLegacyThreadStoreSeed,
  getTestActiveMessages,
  getTestThreadOldestLoadedSequence,
  getTestThreadHasMoreMessages,
  getTestThreadIsLoadingMore,
  patchTestThreadLoadEpoch,
  getTestThreadPersistedFilesChanged,
  readThreadField,
} from "@/stores/thread-store-test-utils";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TurnSnapshot } from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import { cacheRecord, clearRecordCache, getCachedRecord } from "@/lib/thread-hydrator/record-cache";
import { createEmptyThreadRecord } from "@/stores/thread-record";
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
    clearRecordCache();
    applyLegacyThreadStoreSeed({
      messages: [],
      runningThreadIds: new Set(),
      loading: false,
      errorByThread: {},
      streamingByThread: {},
      toolCallsByThread: {},
      currentThreadId: threadId,
      persistedToolCallCounts: {},
      serverMessageIds: {},
      currentTurnMessageIdByThread: {},
      agentStartTimes: {},
      settingsByThread: {},
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

    expect(getTestActiveMessages()).toEqual(messages);
    expect(getTestThreadOldestLoadedSequence(threadId)).toBe(51);
    expect(getTestThreadHasMoreMessages(threadId)).toBe(true);
  });

  it("loadOlderMessages prepends older messages and updates cursor", async () => {
    const initialMessages = [
      createMockMessage({ id: "m3", thread_id: threadId, sequence: 51 }),
      createMockMessage({ id: "m4", thread_id: threadId, sequence: 52 }),
    ];
    applyLegacyThreadStoreSeed({
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

    expect(getTestActiveMessages()).toHaveLength(4);
    expect(getTestActiveMessages()[0].id).toBe("m1");
    expect(getTestActiveMessages()[1].id).toBe("m2");
    expect(getTestActiveMessages()[2].id).toBe("m3");
    expect(getTestActiveMessages()[3].id).toBe("m4");
    expect(getTestThreadOldestLoadedSequence(threadId)).toBe(1);
    expect(getTestThreadHasMoreMessages(threadId)).toBe(false);
    expect(getTestThreadIsLoadingMore(threadId)).toBe(false);
    expect(mockTransport.getMessages).toHaveBeenCalledWith(threadId, 50, 51);
  });

  it("loadOlderMessages is a no-op when hasMore is false", async () => {
    applyLegacyThreadStoreSeed({
      currentThreadId: threadId,
      messages: [createMockMessage({ id: "m1", thread_id: threadId, sequence: 1 })],
      oldestLoadedSequence: { [threadId]: 1 },
      hasMoreMessages: { [threadId]: false },
    });

    await useThreadStore.getState().loadOlderMessages(threadId);

    expect(mockTransport.getMessages).not.toHaveBeenCalled();
  });

  it("loadOlderMessages deduplicates concurrent calls", async () => {
    applyLegacyThreadStoreSeed({
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
    applyLegacyThreadStoreSeed({
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

    expect(getTestActiveMessages()).toHaveLength(0);
    expect(readThreadField(threadId, (r) => r.messages)).toHaveLength(1);
    expect(readThreadField(threadId, (r) => r.messages)[0]?.id).toBe("m2");
    expect(getTestThreadIsLoadingMore(threadId)).toBe(false);
  });

  it("loadOlderMessages discards results when epoch changes (A->B->A switch)", async () => {
    applyLegacyThreadStoreSeed({
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
    patchTestThreadLoadEpoch(threadId, 2);

    resolveGetMessages({
      messages: [createMockMessage({ id: "m1", thread_id: threadId, sequence: 1 })],
      hasMore: false,
    });
    await loadPromise;

    // Stale response should be discarded - messages unchanged
    expect(getTestActiveMessages()).toHaveLength(1);
    expect(getTestActiveMessages()[0].id).toBe("m2");
    expect(getTestThreadIsLoadingMore(threadId)).toBe(false);
  });

  it("loadOlderMessages writes async snapshot file lists into the message cache", async () => {
    const mOldId = "m-old";
    const initialMessages = [
      createMockMessage({ id: "m3", thread_id: threadId, sequence: 51 }),
    ];
    applyLegacyThreadStoreSeed({
      currentThreadId: threadId,
      messages: initialMessages,
      oldestLoadedSequence: { [threadId]: 51 },
      hasMoreMessages: { [threadId]: true },
      isLoadingMore: {},
      persistedFilesChanged: { m3: ["kept.ts"] },
      latestTurnWithChanges: "m3",
    });
    cacheRecord(threadId, {
      ...createEmptyThreadRecord(),
      messages: initialMessages,
      oldestLoadedSequence: 51,
      hasMoreMessages: true,
      persistedFilesChanged: { m3: ["kept.ts"] },
      latestTurnWithChanges: "m3",
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
    expect(getTestThreadPersistedFilesChanged(threadId)[mOldId]).toEqual(["legacy.ts"]);

    const cached = getCachedRecord(threadId);
    expect(cached?.persistedFilesChanged[mOldId]).toEqual(["legacy.ts"]);
    expect(cached?.persistedFilesChanged.m3).toEqual(["kept.ts"]);
  });

  it("loadOlderMessages resets isLoadingMore on network error", async () => {
    applyLegacyThreadStoreSeed({
      currentThreadId: threadId,
      messages: [createMockMessage({ id: "m2", thread_id: threadId, sequence: 2 })],
      oldestLoadedSequence: { [threadId]: 2 },
      hasMoreMessages: { [threadId]: true },
    });

    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Network error"),
    );

    await useThreadStore.getState().loadOlderMessages(threadId);

    expect(getTestThreadIsLoadingMore(threadId)).toBe(false);
    expect(getTestActiveMessages()).toHaveLength(1);
  });
});
