import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "@/transport/types";
import { useToolCallTransitions } from "../useToolCallTransitions";
import { expandTranscriptNarrative } from "../transcript-narrative-items";

const call = (id: string, isComplete = false): ToolCall => ({
  id, toolName: "Bash", toolInput: { command: "echo fixture" }, output: null, isComplete, isError: false,
});

describe("live tool presentation transitions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("animates a new call, then retains its completed row until regrouping", () => {
    const initialCalls: ToolCall[] = [];
    const { result, rerender } = renderHook(({ calls }: { calls: ToolCall[] }) => ({
      transitions: useToolCallTransitions(calls),
      calls,
    }), { initialProps: { calls: initialCalls } });
    rerender({ calls: [call("one")] });
    expect(result.current.transitions.get("one")?.phase).toBe("entering");
    act(() => vi.advanceTimersByTime(250));
    expect(result.current.transitions.size).toBe(0);
    rerender({ calls: [call("one", true)] });
    const rows = () => expandTranscriptNarrative([{
      type: "narrative-flow", key: "live", toolCalls: result.current.calls,
      hooks: [], thoughtSegments: [], streamingText: "", isAgentRunning: true, startTime: 1,
    }], {}, undefined, result.current.transitions);
    const closing = rows()[0];
    expect(closing).toMatchObject({ transition: "exiting", item: { type: "active-tool", toolCall: { isComplete: true } } });
    act(() => vi.advanceTimersByTime(249));
    expect(rows()[0].key).toBe(closing.key);
    act(() => vi.advanceTimersByTime(1));
    expect(rows()[0]).toMatchObject({ item: { type: "tool-group", group: { calls: [{ id: "one", isComplete: true }] } } });
  });

  it("does not postpone an earlier exit when overlapping calls complete", () => {
    const { result, rerender } = renderHook(({ calls }) => useToolCallTransitions(calls), {
      initialProps: { calls: [call("one"), call("two")] },
    });
    expect(result.current.size).toBe(0);
    rerender({ calls: [call("one", true), call("two")] });
    act(() => vi.advanceTimersByTime(100));
    rerender({ calls: [call("one", true), call("two", true)] });
    act(() => vi.advanceTimersByTime(150));
    expect(result.current.has("one")).toBe(false);
    expect(result.current.get("two")?.phase).toBe("exiting");
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.size).toBe(0);
  });

  it("removes transitions when calls disappear or reduced motion is enabled", () => {
    const { result, rerender } = renderHook(({ calls }) => useToolCallTransitions(calls), {
      initialProps: { calls: [call("one")] },
    });
    rerender({ calls: [call("one", true)] });
    rerender({ calls: [] });
    expect(result.current.size).toBe(0);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(window, "matchMedia").mockReturnValue({ ...media, matches: true });
    rerender({ calls: [call("two")] });
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.size).toBe(0);
  });
});
