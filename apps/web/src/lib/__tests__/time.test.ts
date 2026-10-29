// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRelativeTime } from "../time";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

describe("useRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves every subscriber from one ticker and stops it when the last one leaves", () => {
    const at = new Date(NOW - 2 * 60_000).toISOString();
    const hooks = [renderHook(() => useRelativeTime(at)), renderHook(() => useRelativeTime(at)), renderHook(() => useRelativeTime(at))];
    expect(vi.getTimerCount()).toBe(1);
    expect(hooks.map((hook) => hook.result.current)).toEqual(["2m", "2m", "2m"]);

    act(() => vi.advanceTimersByTime(60_000));
    expect(hooks.map((hook) => hook.result.current)).toEqual(["3m", "3m", "3m"]);

    hooks[0]!.unmount();
    hooks[1]!.unmount();
    expect(vi.getTimerCount()).toBe(1);
    hooks[2]!.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
