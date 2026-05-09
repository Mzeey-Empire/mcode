import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getCachedSnapshot,
  cacheSnapshot,
  evictThread,
  clearMessageCache,
  resizeMessageCache,
  MESSAGE_CACHE_SIZE,
  type MessageCacheSnapshot,
} from "@/stores/messageCache";
import {
  rememberScrollTop,
  recallScrollTop,
  clearScrollMemory,
} from "@/components/chat/scrollPositionMemory";
import { LruCache } from "@/lib/lru-cache";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

function makeSnapshot(id: string): MessageCacheSnapshot {
  return {
    messages: [
      {
        id: `${id}-msg-1`,
        thread_id: id,
        role: "user",
        content: "hi",
        tool_calls: null,
        files_changed: null,
        cost_usd: null,
        tokens_used: null,
        timestamp: new Date().toISOString(),
        sequence: 1,
        attachments: null,
      },
    ],
    oldestLoadedSequence: 1,
    hasMoreMessages: false,
    persistedToolCallCounts: {},
    persistedFilesChanged: {},
    latestTurnWithChanges: null,
    answeredPlanMessageIds: [],
  };
}

describe("messageCache", () => {
  beforeEach(() => {
    clearMessageCache();
    clearScrollMemory();
  });

  it("returns undefined for a thread that was never cached", () => {
    expect(getCachedSnapshot("missing")).toBeUndefined();
  });

  it("caches and retrieves a snapshot by threadId", () => {
    const snap = makeSnapshot("t1");
    cacheSnapshot("t1", snap);
    expect(getCachedSnapshot("t1")).toEqual(snap);
  });

  it("evicts a single thread without affecting others", () => {
    cacheSnapshot("t1", makeSnapshot("t1"));
    cacheSnapshot("t2", makeSnapshot("t2"));
    evictThread("t1");
    expect(getCachedSnapshot("t1")).toBeUndefined();
    expect(getCachedSnapshot("t2")).toBeDefined();
  });

  it("respects the LRU capacity", () => {
    for (let i = 0; i < MESSAGE_CACHE_SIZE + 3; i++) {
      cacheSnapshot(`t${i}`, makeSnapshot(`t${i}`));
    }
    // The 3 oldest entries should be evicted; the rest remain.
    expect(getCachedSnapshot("t0")).toBeUndefined();
    expect(getCachedSnapshot("t1")).toBeUndefined();
    expect(getCachedSnapshot("t2")).toBeUndefined();
    expect(getCachedSnapshot(`t${MESSAGE_CACHE_SIZE + 2}`)).toBeDefined();
  });

  it("refreshes LRU recency on get", () => {
    for (let i = 0; i < MESSAGE_CACHE_SIZE; i++) {
      cacheSnapshot(`t${i}`, makeSnapshot(`t${i}`));
    }
    // Touch t0 to make it most-recent.
    void getCachedSnapshot("t0");
    // Insert one more — should evict t1, not t0.
    cacheSnapshot("new", makeSnapshot("new"));
    expect(getCachedSnapshot("t0")).toBeDefined();
    expect(getCachedSnapshot("t1")).toBeUndefined();
  });

  it("clearMessageCache removes everything", () => {
    cacheSnapshot("t1", makeSnapshot("t1"));
    clearMessageCache();
    expect(getCachedSnapshot("t1")).toBeUndefined();
  });

  it("cleans up scroll memory when evicting via LRU capacity", () => {
    for (let i = 0; i < MESSAGE_CACHE_SIZE; i++) {
      cacheSnapshot(`t${i}`, makeSnapshot(`t${i}`));
      rememberScrollTop(`t${i}`, i * 100);
    }
    // Verify scroll positions are stored.
    expect(recallScrollTop("t0")).toBe(0);
    expect(recallScrollTop(`t${MESSAGE_CACHE_SIZE - 1}`)).toBe(
      (MESSAGE_CACHE_SIZE - 1) * 100
    );

    // Seed the new thread's scroll position before the eviction-triggering
    // insert so this test exercises cleanup at the moment of eviction rather
    // than just verifying that a value can be written afterward.
    rememberScrollTop("new", 9999);

    // Trigger eviction by adding one more thread.
    cacheSnapshot("new", makeSnapshot("new"));

    // t0 should be evicted and its scroll position forgotten.
    expect(getCachedSnapshot("t0")).toBeUndefined();
    expect(recallScrollTop("t0")).toBeUndefined();

    // Other threads should still be cached and have scroll positions.
    expect(getCachedSnapshot("t1")).toBeDefined();
    expect(recallScrollTop("t1")).toBe(100);

    // New thread should have its scroll position intact.
    expect(recallScrollTop("new")).toBe(9999);
  });

  it("resizeMessageCache shrinks the active cache and evicts oldest entries", () => {
    for (let i = 0; i < MESSAGE_CACHE_SIZE; i++) {
      cacheSnapshot(`t${i}`, makeSnapshot(`t${i}`));
    }
    resizeMessageCache(2);
    // Only the two most recent entries survive.
    expect(getCachedSnapshot("t0")).toBeUndefined();
    expect(getCachedSnapshot(`t${MESSAGE_CACHE_SIZE - 1}`)).toBeDefined();
    expect(getCachedSnapshot(`t${MESSAGE_CACHE_SIZE - 2}`)).toBeDefined();
    // Reset for sibling tests.
    resizeMessageCache(MESSAGE_CACHE_SIZE);
  });

  it("resizeMessageCache grows the cache without dropping entries", () => {
    cacheSnapshot("t1", makeSnapshot("t1"));
    cacheSnapshot("t2", makeSnapshot("t2"));
    resizeMessageCache(25);
    expect(getCachedSnapshot("t1")).toBeDefined();
    expect(getCachedSnapshot("t2")).toBeDefined();
    resizeMessageCache(MESSAGE_CACHE_SIZE);
  });

  it("resizeMessageCache forgets scroll positions for evicted threads", () => {
    for (let i = 0; i < MESSAGE_CACHE_SIZE; i++) {
      cacheSnapshot(`t${i}`, makeSnapshot(`t${i}`));
      rememberScrollTop(`t${i}`, i * 100);
    }
    resizeMessageCache(2);
    // Surviving threads keep their scroll memory.
    expect(recallScrollTop(`t${MESSAGE_CACHE_SIZE - 1}`)).toBe(
      (MESSAGE_CACHE_SIZE - 1) * 100,
    );
    // Evicted threads' scroll memory is gone.
    expect(recallScrollTop("t0")).toBeUndefined();
    expect(recallScrollTop(`t${MESSAGE_CACHE_SIZE - 3}`)).toBeUndefined();
    resizeMessageCache(MESSAGE_CACHE_SIZE);
  });
});

describe("selective cache eviction in handleAgentEvent", () => {
  const THREAD_ID = "thread-evict-test";

  beforeEach(() => {
    clearMessageCache();
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set([THREAD_ID]),
      loading: false,
      errorByThread: {},
      streamingByThread: {},
      streamingPreviewByThread: {},
      toolCallsByThread: {},
      agentStartTimes: { [THREAD_ID]: Date.now() },
      currentThreadId: THREAD_ID,
      currentTurnMessageIdByThread: {},
      isCompactingByThread: {},
      lastFallbackByThread: {},
      contextByThread: {},
    });
  });

  it("streaming textDelta events do NOT evict the cache", () => {
    cacheSnapshot(THREAD_ID, makeSnapshot(THREAD_ID));
    expect(getCachedSnapshot(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent(THREAD_ID, {
      method: "session.textDelta",
      params: { delta: "hello " },
    });

    expect(getCachedSnapshot(THREAD_ID)).toBeDefined();
  });

  it("streaming toolUse events do NOT evict the cache", () => {
    cacheSnapshot(THREAD_ID, makeSnapshot(THREAD_ID));
    expect(getCachedSnapshot(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent(THREAD_ID, {
      method: "session.toolUse",
      params: { id: "tool-1", name: "Read", input: "{}" },
    });

    expect(getCachedSnapshot(THREAD_ID)).toBeDefined();
  });

  it("session.turnComplete evicts the cache", () => {
    cacheSnapshot(THREAD_ID, makeSnapshot(THREAD_ID));
    expect(getCachedSnapshot(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent(THREAD_ID, {
      method: "session.turnComplete",
      params: {},
    });

    expect(getCachedSnapshot(THREAD_ID)).toBeUndefined();
  });

  it("session.message evicts the cache", () => {
    cacheSnapshot(THREAD_ID, makeSnapshot(THREAD_ID));
    expect(getCachedSnapshot(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent(THREAD_ID, {
      method: "session.message",
      params: { role: "assistant", content: "done" },
    });

    expect(getCachedSnapshot(THREAD_ID)).toBeUndefined();
  });

  it("session.error evicts the cache", () => {
    cacheSnapshot(THREAD_ID, makeSnapshot(THREAD_ID));
    expect(getCachedSnapshot(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent(THREAD_ID, {
      method: "session.error",
      error: "Something broke",
    });

    expect(getCachedSnapshot(THREAD_ID)).toBeUndefined();
  });

  it("session.ended evicts the cache", () => {
    cacheSnapshot(THREAD_ID, makeSnapshot(THREAD_ID));
    expect(getCachedSnapshot(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent(THREAD_ID, {
      method: "session.ended",
      params: {},
    });

    expect(getCachedSnapshot(THREAD_ID)).toBeUndefined();
  });

  it("many streaming events preserve the cache throughout", () => {
    cacheSnapshot(THREAD_ID, makeSnapshot(THREAD_ID));

    const { handleAgentEvent } = useThreadStore.getState();
    for (let i = 0; i < 100; i++) {
      handleAgentEvent(THREAD_ID, {
        method: "session.textDelta",
        params: { delta: `token-${i} ` },
      });
    }

    expect(getCachedSnapshot(THREAD_ID)).toBeDefined();
  });
});

describe("LruCache.delete", () => {
  it("removes the entry and returns true when present", () => {
    const c = new LruCache<string, number>(3);
    c.set("a", 1);
    expect(c.delete("a")).toBe(true);
    expect(c.get("a")).toBeUndefined();
  });

  it("returns false when key is absent", () => {
    const c = new LruCache<string, number>(3);
    expect(c.delete("missing")).toBe(false);
  });
});
