import { createMockThread } from "@mcode/contracts/testing";
import { describe, expect, it } from "vitest";
import { selectPreparingThreadIds, selectSidebarFacts, selectThreadIndex } from "../thread-index";

describe("selectSidebarFacts", () => {
  it("returns the same facts array when only a thread's status changed", () => {
    const threads = [createMockThread({ id: "a", status: "active" }), createMockThread({ id: "b" })];
    const first = selectSidebarFacts(threads);
    const statusOnly = threads.map((thread) => (thread.id === "a" ? { ...thread, status: "paused" as const } : thread));

    expect(selectSidebarFacts(statusOnly)).toBe(first);
  });

  it("returns new facts when activity moves, keeping the untouched thread's object", () => {
    const threads = [createMockThread({ id: "a", last_activity_at: "2026-10-01T00:00:00.000Z" }), createMockThread({ id: "b" })];
    const first = selectSidebarFacts(threads);
    const moved = selectSidebarFacts([{ ...threads[0]!, last_activity_at: "2026-10-02T00:00:00.000Z" }, threads[1]!]);

    expect(moved).not.toBe(first);
    expect(moved[0]?.activityMs).toBe(Date.parse("2026-10-02T00:00:00.000Z"));
    expect(moved[1]).toBe(first[1]);
  });
});

describe("selectPreparingThreadIds", () => {
  it("keeps the same set until a thread starts or stops preparing", () => {
    const threads = [createMockThread({ id: "a" }), { ...createMockThread({ id: "b" }), clientPreparing: true }];
    const first = selectPreparingThreadIds(threads);
    const statusOnly = threads.map((thread) => (thread.id === "a" ? { ...thread, status: "paused" as const } : thread));

    expect(selectPreparingThreadIds(statusOnly)).toBe(first);
    expect([...selectPreparingThreadIds([threads[0]!, { ...threads[1]!, clientPreparing: false }])]).toEqual([]);
  });
});

describe("selectThreadIndex", () => {
  it("builds one index per threads array", () => {
    const threads = [createMockThread({ id: "a" })];

    expect(selectThreadIndex(threads)).toBe(selectThreadIndex(threads));
    expect(selectThreadIndex(threads).get("a")).toBe(threads[0]);
  });
});
