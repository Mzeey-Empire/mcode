import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedSnapshot,
  cacheSnapshot,
  evictThread,
  clearMessageCache,
  MESSAGE_CACHE_SIZE,
  type MessageCacheSnapshot,
} from "@/stores/messageCache";
import { LruCache } from "@/lib/lru-cache";

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
  };
}

describe("messageCache", () => {
  beforeEach(() => clearMessageCache());

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
