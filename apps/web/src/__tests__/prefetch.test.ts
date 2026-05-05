import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getCachedSnapshot,
  cacheSnapshot,
  clearMessageCache,
  type MessageCacheSnapshot,
} from "@/stores/messageCache";
import { mockTransport, createMockMessage } from "./mocks/transport";

vi.mock("@/transport", () => ({
  getTransport: () => mockTransport,
}));

function makeSnapshot(id: string): MessageCacheSnapshot {
  return {
    messages: [
      createMockMessage({
        id: `${id}-msg-1`,
        thread_id: id,
        sequence: 1,
      }),
    ],
    oldestLoadedSequence: 1,
    hasMoreMessages: false,
    persistedToolCallCounts: {},
    persistedFilesChanged: {},
    latestTurnWithChanges: null,
  };
}

describe("prefetch", () => {
  let schedulePrefetch: typeof import("@/lib/prefetch").schedulePrefetch;
  let cancelPrefetch: typeof import("@/lib/prefetch").cancelPrefetch;
  let resetPrefetch: typeof import("@/lib/prefetch").__resetPrefetchForTests;

  beforeEach(async () => {
    vi.useFakeTimers();
    clearMessageCache();
    vi.mocked(mockTransport.getMessages).mockReset();
    vi.mocked(mockTransport.getMessages).mockResolvedValue({
      messages: [
        createMockMessage({ id: "m1", thread_id: "t1", sequence: 1 }),
      ],
      hasMore: false,
    });

    // Dynamic import to get fresh module state after mocks are set up
    const mod = await import("@/lib/prefetch");
    schedulePrefetch = mod.schedulePrefetch;
    cancelPrefetch = mod.cancelPrefetch;
    resetPrefetch = mod.__resetPrefetchForTests;
  });

  afterEach(() => {
    resetPrefetch();
    vi.useRealTimers();
  });

  it("fires prefetch after 150ms debounce", async () => {
    schedulePrefetch("t1");

    // Not yet fired
    expect(mockTransport.getMessages).not.toHaveBeenCalled();

    // Advance past debounce
    vi.advanceTimersByTime(150);
    expect(mockTransport.getMessages).toHaveBeenCalledWith("t1", 100);

    // Let the async prefetch settle
    await vi.runAllTimersAsync();
    expect(getCachedSnapshot("t1")).toBeDefined();
  });

  it("cancel stops a pending prefetch", () => {
    schedulePrefetch("t1");
    cancelPrefetch();

    vi.advanceTimersByTime(200);
    expect(mockTransport.getMessages).not.toHaveBeenCalled();
  });

  it("skips threads that are already cached", () => {
    cacheSnapshot("t1", makeSnapshot("t1"));

    schedulePrefetch("t1");
    vi.advanceTimersByTime(150);

    expect(mockTransport.getMessages).not.toHaveBeenCalled();
  });

  it("prevents duplicate in-flight requests", async () => {
    // First prefetch: resolved after a tick
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveFirst!: (v: any) => void;
    vi.mocked(mockTransport.getMessages).mockImplementationOnce(
      () => new Promise((r) => { resolveFirst = r; }),
    );

    schedulePrefetch("t1");
    vi.advanceTimersByTime(150);
    expect(mockTransport.getMessages).toHaveBeenCalledTimes(1);

    // Schedule a second prefetch for the same thread while the first is in flight
    schedulePrefetch("t1");
    vi.advanceTimersByTime(150);
    // Should not fire a second RPC
    expect(mockTransport.getMessages).toHaveBeenCalledTimes(1);

    // Resolve the first to clean up
    resolveFirst({
      messages: [createMockMessage({ id: "m1", thread_id: "t1", sequence: 1 })],
      hasMore: false,
    });
    await vi.runAllTimersAsync();
  });

  it("does not throw on failed prefetch", async () => {
    vi.mocked(mockTransport.getMessages).mockRejectedValueOnce(
      new Error("network error"),
    );

    schedulePrefetch("t1");
    vi.advanceTimersByTime(150);

    // Should not throw; the error is swallowed
    await vi.runAllTimersAsync();

    // Cache should remain empty
    expect(getCachedSnapshot("t1")).toBeUndefined();
  });

  it("debounces rapid successive calls", () => {
    schedulePrefetch("t1");
    vi.advanceTimersByTime(50);
    schedulePrefetch("t2");
    vi.advanceTimersByTime(50);
    schedulePrefetch("t3");

    // Only the last one should fire after full debounce
    vi.advanceTimersByTime(150);
    expect(mockTransport.getMessages).toHaveBeenCalledTimes(1);
    expect(mockTransport.getMessages).toHaveBeenCalledWith("t3", 100);
  });
});
