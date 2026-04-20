import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSkillsStore } from "./skillsStore";

const FAKE_SKILLS = [
  { name: "a", description: "A", kind: "skill" as const, source: "user" as const },
];

// Hoist the mock so the invalidate-then-reload test can assert call counts.
// Without a stable reference, every getTransport() call would return a fresh
// vi.fn() and the second load() would never be observable.
const listSkillsMock = vi.fn(async () => FAKE_SKILLS);

vi.mock("@/transport", () => ({
  getTransport: () => ({
    listSkills: listSkillsMock,
  }),
}));

describe("skillsStore", () => {
  beforeEach(() => {
    listSkillsMock.mockClear();
    useSkillsStore.getState().reset();
  });

  it("loads skills and caches them per cwd", async () => {
    await useSkillsStore.getState().load("/foo");
    expect(useSkillsStore.getState().skills).toEqual(FAKE_SKILLS);
    expect(useSkillsStore.getState().cwd).toBe("/foo");
  });

  it("single-flights concurrent load() calls", async () => {
    const p1 = useSkillsStore.getState().load("/foo");
    const p2 = useSkillsStore.getState().load("/foo");
    expect(p1).toBe(p2); // same in-flight promise
    await Promise.all([p1, p2]);
  });

  it("invalidate() clears cache so next load() re-fetches", async () => {
    await useSkillsStore.getState().load("/foo");
    useSkillsStore.getState().invalidate();
    expect(useSkillsStore.getState().skills).toBeNull();

    // The visible-state assertion above is necessary but not sufficient: if
    // invalidate() left the module-scoped TTL or in-flight reference behind,
    // the next load() could short-circuit to the stale promise without ever
    // hitting transport. Calling load() again and asserting two transport
    // hits is what actually proves the cache was cleared.
    await useSkillsStore.getState().load("/foo");
    expect(listSkillsMock).toHaveBeenCalledTimes(2);
    expect(useSkillsStore.getState().skills).toEqual(FAKE_SKILLS);
  });

  it("does not single-flight loads for different cwds", async () => {
    // Two concurrent loads with different cwds must NOT share a promise:
    // workspace B would receive workspace A's data otherwise.
    const p1 = useSkillsStore.getState().load("/foo");
    const p2 = useSkillsStore.getState().load("/bar");
    expect(p1).not.toBe(p2);
    await Promise.all([p1, p2]);
  });

  it("invalidate() fences a load() that's still in flight", async () => {
    // Slow the next mock response so we can race invalidate() against it.
    let resolveListSkills!: (v: typeof FAKE_SKILLS) => void;
    listSkillsMock.mockImplementationOnce(
      () => new Promise((res) => { resolveListSkills = res; }),
    );

    const loadPromise = useSkillsStore.getState().load("/foo");
    // While load is in flight, an external watcher fires invalidate().
    useSkillsStore.getState().invalidate();
    // Now resolve the in-flight fetch with data — it must NOT rehydrate
    // the store, because invalidate() bumped the load epoch.
    resolveListSkills(FAKE_SKILLS);
    await loadPromise;

    // Store stays cleared: the late resolution was dropped.
    expect(useSkillsStore.getState().skills).toBeNull();
    expect(useSkillsStore.getState().cwd).toBeUndefined();
  });

  it("tracks cwd on failure so the consumer can detect cwd changes", async () => {
    listSkillsMock.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await expect(useSkillsStore.getState().load("/foo")).rejects.toThrow("boom");
    // cwd must reflect the *attempted* path even though no skills loaded.
    // Without this, useSlashCommand cannot distinguish "retry same cwd"
    // (don't auto-loop) from "user switched workspace" (must reload).
    expect(useSkillsStore.getState().cwd).toBe("/foo");
    expect(useSkillsStore.getState().error?.message).toBe("boom");
  });

  it("retries once after WebSocket disconnect", async () => {
    const calls: number[] = [];
    vi.doMock("@/transport", () => ({
      getTransport: () => ({
        listSkills: vi.fn(async () => {
          calls.push(Date.now());
          if (calls.length === 1) throw new Error("WebSocket disconnected");
          return FAKE_SKILLS;
        }),
        waitForConnection: async () => undefined,
      }),
    }));

    vi.resetModules();
    const { useSkillsStore: store } = await import("./skillsStore");
    store.getState().reset();
    const result = await store.getState().load("/foo");
    expect(result).toEqual(FAKE_SKILLS);
    expect(calls.length).toBe(2);
  });
});
