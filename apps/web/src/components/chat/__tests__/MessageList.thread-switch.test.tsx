/**
 * Tests for MessageList thread-switch behavior: cache-hit detection,
 * virtualizer measurement optimization, scroll position restoration, and
 * synchronous bottom positioning when a prefetched thread has no saved offset.
 *
 * A cache hit occurs when threadStore has messages already loaded (loading: false
 * synchronously after activeThreadId changes). On cache hit, we skip virtualizer.measure()
 * to preserve cached row heights. Without a remembered scroll offset, we still call
 * scrollToIndex (instant) on switch so the list does not animate from a stale position.
 */
import { render, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const measureSpy = vi.fn();
const scrollToIndexSpy = vi.fn();

const mockVirtualizer = {
  getVirtualItems: () => [],
  getTotalSize: () => 0,
  measure: measureSpy,
  scrollToIndex: scrollToIndexSpy,
  measureElement: () => {},
  shouldAdjustScrollPositionOnItemSizeChange: undefined,
};

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn(() => mockVirtualizer),
}));

// Minimal store mocks; control `loading` and `activeThreadId` between renders.
let loadingValue = false;
let activeThreadIdValue = "thread-A";
let messagesValue: { id: string; sequence: number }[] = [{ id: "m1", sequence: 1 }];

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      messages: messagesValue,
      loading: loadingValue,
      runningThreadIds: new Set(),
      agentStartTimes: {},
      streamingPreviewByThread: {},
      toolCallsByThread: {},
      persistedToolCallCounts: {},
      serverMessageIds: {},
      persistedFilesChanged: {},
      latestTurnWithChanges: null,
      hasMoreMessages: {},
      isLoadingMore: {},
      loadOlderMessages: vi.fn(),
      permissionsByThread: {},
    }),
  ),
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ activeThreadId: activeThreadIdValue }),
  ),
}));

// Stub heavy children.
vi.mock("../MessageBubble", () => ({ MessageBubble: () => null }));
vi.mock("../ToolCallCard", () => ({ ToolCallCard: () => null }));
vi.mock("../StreamingIndicator", () => ({ StreamingIndicator: () => null }));
vi.mock("../StreamingCard", () => ({ StreamingCard: () => null }));
vi.mock("../ToolCallSummary", () => ({ ToolCallSummary: () => null }));
vi.mock("../TurnChangeSummary", () => ({ TurnChangeSummary: () => null }));
vi.mock("../PermissionRequestCard", () => ({ PermissionRequestCard: () => null }));

import { MessageList } from "../MessageList";
import { rememberScrollTop, recallScrollTop, clearScrollMemory } from "../scrollPositionMemory";

beforeEach(() => {
  measureSpy.mockClear();
  scrollToIndexSpy.mockClear();
  clearScrollMemory();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MessageList thread switch", () => {
  it("does not call virtualizer.measure() on a cache-hit switch", () => {
    loadingValue = false;            // cache hit ⇒ loading is false synchronously
    messagesValue = [{ id: "m1", sequence: 1 }];
    activeThreadIdValue = "thread-A";
    const { rerender } = render(<MessageList />);

    measureSpy.mockClear();          // ignore the first-mount call (allowed)
    activeThreadIdValue = "thread-B";
    rerender(<MessageList />);

    expect(measureSpy).not.toHaveBeenCalled();
  });

  it("calls virtualizer.measure() on a cache-miss switch", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    const { rerender } = render(<MessageList />);

    measureSpy.mockClear();
    loadingValue = true;             // cache miss ⇒ loading flips to true
    activeThreadIdValue = "thread-B";
    rerender(<MessageList />);

    expect(measureSpy).toHaveBeenCalledTimes(1);
  });

  it("scrolls to bottom with instant behavior on cache-hit switch without remembered scroll", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m-a", sequence: 1 }];
    const { rerender } = render(<MessageList />);

    scrollToIndexSpy.mockClear();
    activeThreadIdValue = "thread-B";
    messagesValue = [{ id: "m-b", sequence: 1 }];
    act(() => {
      rerender(<MessageList />);
    });

    expect(scrollToIndexSpy).toHaveBeenCalled();
    const matchingCalls = scrollToIndexSpy.mock.calls.filter(
      (call) =>
        call[1] != null
        && typeof call[1] === "object"
        && (call[1] as { align?: string; behavior?: string }).align === "end"
        && (call[1] as { align?: string; behavior?: string }).behavior === "auto",
    );
    expect(matchingCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does not schedule throttled smooth scroll after cache-hit switch without remembered scroll", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m-a", sequence: 1 }];
    const { rerender } = render(<MessageList />);

    scrollToIndexSpy.mockClear();
    activeThreadIdValue = "thread-B";
    messagesValue = [{ id: "m-b", sequence: 1 }];
    act(() => {
      rerender(<MessageList />);
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    const smoothCalls = scrollToIndexSpy.mock.calls.filter(
      (call) => (call[1] as { behavior?: string } | undefined)?.behavior === "smooth",
    );
    expect(smoothCalls.length).toBe(0);
  });

  it("restores remembered scrollTop on a cache-hit switch", () => {
    loadingValue = false;
    activeThreadIdValue = "thread-A";
    messagesValue = [{ id: "m1", sequence: 1 }];
    const { rerender, container } = render(<MessageList />);

    // Pretend the user scrolled and we returned to thread B which has memory.
    rememberScrollTop("thread-B", 1500);
    expect(recallScrollTop("thread-B")).toBe(1500); // verify memory works

    const scrollEl = container.querySelector(".overflow-y-auto") as HTMLDivElement | null;
    expect(scrollEl).not.toBeNull();

    // Mock scrollTop setter to track if it's called with the right value
    let setScrollTopValue: number | null = null;
    Object.defineProperty(scrollEl!, "scrollTop", {
      set: (value: number) => {
        setScrollTopValue = value;
      },
      get: () => setScrollTopValue ?? 0,
      configurable: true,
    });

    activeThreadIdValue = "thread-B";
    act(() => {
      rerender(<MessageList />);
    });

    // The scroll restoration effect should have called scrollTop setter with 1500
    expect(setScrollTopValue).toBe(1500);
  });
});
