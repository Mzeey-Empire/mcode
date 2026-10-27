// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCause, SidebarItem, SidebarModel } from "../sidebar-model";
import { CLOSE_MS, planTransitions, useSidebarMotion, type MotionEnvironment, type SidebarTransition } from "../sidebar-motion";

function threadItem(id: string): SidebarItem {
  return { kind: "thread", key: `thread:${id}`, threadId: id, section: "recent", layout: "grouped", depth: 0, pending: "none" };
}

function model(ids: readonly string[], completed: readonly string[] = []): SidebarModel {
  return {
    scope: "active",
    scopeBar: { visible: completed.length > 0, completedCount: completed.length },
    items: [...ids.map(threadItem), { kind: "end-spacer", key: "end-spacer" }],
    olderBar: null,
    olderIds: new Set(),
    completedIds: new Set(completed),
    nextBoundaryAt: null,
  };
}

const ON_SCREEN = { visibleKeys: new Set(["thread:a", "thread:b"]), reducedMotion: false };
const BEFORE = model(["a", "b"]);
const A_COMPLETED = model(["b"], ["a"]);

describe("planTransitions", () => {
  it("closes an on-screen completed row and flies it to the Completed segment", () => {
    expect(planTransitions(BEFORE, A_COMPLETED, "push", ON_SCREEN)).toEqual([
      { type: "close-row", key: "thread:a" },
      { type: "fly", key: "thread:a", threadId: "a", to: "completed-segment", delayMs: 0 },
    ]);
  });

  it("closes an off-screen completed row without a flight", () => {
    expect(planTransitions(BEFORE, A_COMPLETED, "push", { ...ON_SCREEN, visibleKeys: new Set() })).toEqual([{ type: "close-row", key: "thread:a" }]);
  });

  it.each<[string, ModelCause, boolean]>([
    ["reduced motion", "push", true],
    ["a snapshot", "snapshot", false],
    ["a layout change", "layout", false],
  ])("plans nothing under %s", (_name, cause, reducedMotion) => {
    expect(planTransitions(BEFORE, A_COMPLETED, cause, { ...ON_SCREEN, reducedMotion })).toEqual([]);
  });

  it("plans nothing for a row that left without completing", () => {
    expect(planTransitions(BEFORE, model(["b"]), "push", ON_SCREEN)).toEqual([]);
  });
});

describe("useSidebarMotion", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Copies land only when the test says so. */
  const landings: Array<() => void> = [];

  function environment(reducedMotion: boolean): MotionEnvironment {
    return {
      visibleKeys: () => ON_SCREEN.visibleKeys,
      reducedMotion: () => reducedMotion,
      fly: (_transition: Extract<SidebarTransition, { type: "fly" }>) => new Promise<void>((resolve) => landings.push(resolve)),
    };
  }

  it("shows the Completed count one behind the model until the copy lands", async () => {
    const env = environment(false);
    const { result, rerender } = renderHook(({ next }) => useSidebarMotion(next, "push", env), { initialProps: { next: BEFORE } });

    rerender({ next: A_COMPLETED });
    expect(result.current.completedCount).toBe(0);
    expect(result.current.items.map((item) => item.key)).toContain("thread:a");

    await act(() => vi.advanceTimersByTimeAsync(CLOSE_MS));
    expect(result.current.completedCount).toBe(0);

    await act(async () => landings.splice(0).forEach((land) => land()));
    expect(result.current.completedCount).toBe(1);
    expect(result.current.items.map((item) => item.key)).not.toContain("thread:a");
  });

  it("lands the copy and drops the closed row under StrictMode", async () => {
    const env = environment(false);
    const { result, rerender } = renderHook(({ next }) => useSidebarMotion(next, "push", null, env), { initialProps: { next: BEFORE }, wrapper: StrictMode });

    rerender({ next: A_COMPLETED });
    await act(() => vi.advanceTimersByTimeAsync(CLOSE_MS));
    await act(async () => landings.splice(0).forEach((land) => land()));

    expect(result.current.completedCount).toBe(1);
    expect(result.current.items.map((item) => item.key)).not.toContain("thread:a");
  });

  it("updates the count at once under reduced motion", () => {
    const env = environment(true);
    const { result, rerender } = renderHook(({ next }) => useSidebarMotion(next, "push", env), { initialProps: { next: BEFORE } });

    rerender({ next: A_COMPLETED });

    expect(result.current.completedCount).toBe(1);
    expect(result.current.items.map((item) => item.key)).not.toContain("thread:a");
  });
});
