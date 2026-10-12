import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStatusLineExit } from "../status-line-exit";

describe("useStatusLineExit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds the row for the 240ms fade after the line stops being live", () => {
    const { result, rerender } = renderHook(({ live }) => useStatusLineExit("thread-1", live), { initialProps: { live: true } });
    expect(result.current).toBe(false);

    rerender({ live: false });
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(239));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
  });

  it("stops holding when the thread goes live again mid-fade", () => {
    const { result, rerender } = renderHook(({ live }) => useStatusLineExit("thread-1", live), { initialProps: { live: true } });
    rerender({ live: false });
    rerender({ live: true });
    expect(result.current).toBe(false);
  });

  it("does not fade when switching from a live thread to an idle one", () => {
    const { result, rerender } = renderHook(({ threadId, live }) => useStatusLineExit(threadId, live), { initialProps: { threadId: "thread-1", live: true } });
    rerender({ threadId: "thread-2", live: false });
    expect(result.current).toBe(false);
  });
});
