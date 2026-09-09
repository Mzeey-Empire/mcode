import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTranscriptGroupExpansion } from "../useTranscriptGroupExpansion";

describe("transcript group transitions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retains closing rows, then removes them after the transition", () => {
    const { result } = renderHook(() => useTranscriptGroupExpansion(() => new Set(["group"])));
    expect(result.current.entering.has("group")).toBe(false);
    act(() => result.current.toggle("group"));
    expect(result.current.expanded.has("group")).toBe(false);
    expect(result.current.present.has("group")).toBe(true);
    act(() => vi.advanceTimersByTime(249));
    expect(result.current.present.has("group")).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.present.has("group")).toBe(false);
  });

  it("reverses an interrupted entrance without removing or restarting the row", () => {
    const { result } = renderHook(() => useTranscriptGroupExpansion(() => new Set()));
    act(() => result.current.toggle("group"));
    expect(result.current.entering.has("group")).toBe(true);
    act(() => vi.advanceTimersByTime(50));
    act(() => result.current.toggle("group"));
    expect(result.current.present.has("group")).toBe(true);
    act(() => vi.advanceTimersByTime(50));
    act(() => result.current.toggle("group"));
    act(() => vi.advanceTimersByTime(250));
    expect(result.current.expanded.has("group")).toBe(true);
    expect(result.current.present.has("group")).toBe(true);
    expect(result.current.entering.has("group")).toBe(false);
  });

  it("does not wait for motion when reduced motion is enabled", () => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(window, "matchMedia").mockReturnValue({ ...media, matches: true });
    const { result } = renderHook(() => useTranscriptGroupExpansion(() => new Set(["group"])));
    act(() => result.current.toggle("group"));
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.present.has("group")).toBe(false);
  });
});
