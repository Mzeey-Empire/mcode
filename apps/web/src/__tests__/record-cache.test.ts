import {
  applyLegacyThreadStoreSeed,
} from "@/stores/thread-store-test-utils";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getCachedRecord,
  cacheRecord,
  evictCachedRecord,
  clearRecordCache,
  resizeRecordCache,
  RECORD_CACHE_SIZE,
} from "@/lib/thread-hydrator/record-cache";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
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

function makeRecord(id: string): ThreadRecord {
  return {
    ...createEmptyThreadRecord(),
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
  };
}

describe("recordCache", () => {
  beforeEach(() => {
    clearRecordCache();
    clearScrollMemory();
  });

  it("returns undefined for a thread that was never cached", () => {
    expect(getCachedRecord("missing")).toBeUndefined();
  });

  it("caches and retrieves a record by threadId", () => {
    const rec = makeRecord("t1");
    cacheRecord("t1", rec);
    expect(getCachedRecord("t1")).toEqual(rec);
  });

  it("evicts a single thread without affecting others", () => {
    cacheRecord("t1", makeRecord("t1"));
    cacheRecord("t2", makeRecord("t2"));
    evictCachedRecord("t1");
    expect(getCachedRecord("t1")).toBeUndefined();
    expect(getCachedRecord("t2")).toBeDefined();
  });

  it("respects the LRU capacity", () => {
    for (let i = 0; i < RECORD_CACHE_SIZE + 3; i++) {
      cacheRecord(`t${i}`, makeRecord(`t${i}`));
    }
    expect(getCachedRecord("t0")).toBeUndefined();
    expect(getCachedRecord("t1")).toBeUndefined();
    expect(getCachedRecord("t2")).toBeUndefined();
    expect(getCachedRecord(`t${RECORD_CACHE_SIZE + 2}`)).toBeDefined();
  });

  it("refreshes LRU recency on get", () => {
    for (let i = 0; i < RECORD_CACHE_SIZE; i++) {
      cacheRecord(`t${i}`, makeRecord(`t${i}`));
    }
    void getCachedRecord("t0");
    cacheRecord("new", makeRecord("new"));
    expect(getCachedRecord("t0")).toBeDefined();
    expect(getCachedRecord("t1")).toBeUndefined();
  });

  it("clearRecordCache removes everything", () => {
    cacheRecord("t1", makeRecord("t1"));
    clearRecordCache();
    expect(getCachedRecord("t1")).toBeUndefined();
  });

  it("cleans up scroll memory when evicting via LRU capacity", () => {
    for (let i = 0; i < RECORD_CACHE_SIZE; i++) {
      cacheRecord(`t${i}`, makeRecord(`t${i}`));
      rememberScrollTop(`t${i}`, i * 100);
    }
    expect(recallScrollTop("t0")).toBe(0);
    expect(recallScrollTop(`t${RECORD_CACHE_SIZE - 1}`)).toBe(
      (RECORD_CACHE_SIZE - 1) * 100
    );

    rememberScrollTop("new", 9999);

    cacheRecord("new", makeRecord("new"));

    expect(getCachedRecord("t0")).toBeUndefined();
    expect(recallScrollTop("t0")).toBeUndefined();

    expect(getCachedRecord("t1")).toBeDefined();
    expect(recallScrollTop("t1")).toBe(100);

    expect(recallScrollTop("new")).toBe(9999);
  });

  it("resizeRecordCache shrinks the active cache and evicts oldest entries", () => {
    for (let i = 0; i < RECORD_CACHE_SIZE; i++) {
      cacheRecord(`t${i}`, makeRecord(`t${i}`));
    }
    resizeRecordCache(2);
    expect(getCachedRecord("t0")).toBeUndefined();
    expect(getCachedRecord(`t${RECORD_CACHE_SIZE - 1}`)).toBeDefined();
    expect(getCachedRecord(`t${RECORD_CACHE_SIZE - 2}`)).toBeDefined();
    resizeRecordCache(RECORD_CACHE_SIZE);
  });

  it("resizeRecordCache grows the cache without dropping entries", () => {
    cacheRecord("t1", makeRecord("t1"));
    cacheRecord("t2", makeRecord("t2"));
    resizeRecordCache(25);
    expect(getCachedRecord("t1")).toBeDefined();
    expect(getCachedRecord("t2")).toBeDefined();
    resizeRecordCache(RECORD_CACHE_SIZE);
  });

  it("resizeRecordCache forgets scroll positions for evicted threads", () => {
    for (let i = 0; i < RECORD_CACHE_SIZE; i++) {
      cacheRecord(`t${i}`, makeRecord(`t${i}`));
      rememberScrollTop(`t${i}`, i * 100);
    }
    resizeRecordCache(2);
    expect(recallScrollTop(`t${RECORD_CACHE_SIZE - 1}`)).toBe(
      (RECORD_CACHE_SIZE - 1) * 100,
    );
    expect(recallScrollTop("t0")).toBeUndefined();
    expect(recallScrollTop(`t${RECORD_CACHE_SIZE - 3}`)).toBeUndefined();
    resizeRecordCache(RECORD_CACHE_SIZE);
  });
});

describe("selective cache eviction in handleAgentEvent", () => {
  const THREAD_ID = "thread-evict-test";

  beforeEach(() => {
    clearRecordCache();
    applyLegacyThreadStoreSeed({
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
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));
    expect(getCachedRecord(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent(THREAD_ID, {
      method: "session.textDelta",
      params: { delta: "hello " },
    });

    expect(getCachedRecord(THREAD_ID)).toBeDefined();
  });

  it("streaming toolUse events do NOT evict the cache", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));
    expect(getCachedRecord(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent(THREAD_ID, {
      method: "session.toolUse",
      params: { id: "tool-1", name: "Read", input: "{}" },
    });

    expect(getCachedRecord(THREAD_ID)).toBeDefined();
  });

  it("session.turnComplete evicts the cache", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));
    expect(getCachedRecord(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent(THREAD_ID, {
      method: "session.turnComplete",
      params: {},
    });

    expect(getCachedRecord(THREAD_ID)).toBeUndefined();
  });

  it("session.message evicts the cache", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));
    expect(getCachedRecord(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent(THREAD_ID, {
      method: "session.message",
      params: { role: "assistant", content: "done" },
    });

    expect(getCachedRecord(THREAD_ID)).toBeUndefined();
  });

  it("session.error evicts the cache", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));
    expect(getCachedRecord(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent(THREAD_ID, {
      method: "session.error",
      error: "Something broke",
    });

    expect(getCachedRecord(THREAD_ID)).toBeUndefined();
  });

  it("session.ended evicts the cache", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));
    expect(getCachedRecord(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent(THREAD_ID, {
      method: "session.ended",
      params: {},
    });

    expect(getCachedRecord(THREAD_ID)).toBeUndefined();
  });

  it("many streaming events preserve the cache throughout", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));

    const { handleAgentEvent } = useThreadStore.getState();
    for (let i = 0; i < 100; i++) {
      handleAgentEvent(THREAD_ID, {
        method: "session.textDelta",
        params: { delta: `token-${i} ` },
      });
    }

    expect(getCachedRecord(THREAD_ID)).toBeDefined();
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
