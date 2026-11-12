import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { SessionOccupancyRegistry } from "../session-occupancy-registry.js";
import { SessionRuntime } from "../../../../../../packages/providers/src/private/session-runtime.js";
import { isUserSentTurn } from "../../agents/turns/turn-admission-dispatch-coordinator.js";

const key = { providerId: "claude", threadId: "thread" };

describe("session occupancy registry", () => {
  it("rejects closed and stale-epoch deliveries and keeps user time monotonic", () => {
    let now = 10;
    const registry = new SessionOccupancyRegistry({ now: () => now });
    expect(registry.stamp(key)).toBeNull();
    const epoch = registry.openSession(key);
    expect(registry.openSession(key)).toBe(epoch);
    const first = registry.stamp(key)!;
    now = 20;
    registry.userMessaged(key, registry.stamp(key)!);
    registry.userMessaged(key, first);
    expect(registry.read(key, now)).toEqual({ held: false, lastActivityAt: 20, lastUserTurnAt: 20 });
    registry.closeSession(key, epoch);
    now = 30;
    registry.userMessaged(key, first);
    expect(registry.stamp(key)).toBeNull();
    const next = registry.openSession(key);
    expect(next).toBe(epoch + 1);
    registry.closeSession(key, epoch);
    registry.userMessaged(key, first);
    expect(registry.stamp(key)).toEqual({ at: 30, epoch: next });
    expect(registry.read(key, now).lastUserTurnAt).toBeNull();
  });

  it.each([
    [{ providerOriginated: true }, false], [{ delegationWake: true }, false], [{}, true],
  ])("classifies direct user input %j", (flags, expected) => {
    expect(isUserSentTurn({ threadId: "thread", content: "hello", permissionMode: "default", ...flags })).toBe(expected);
  });

  it("replays an 80 minute turn, background work, and TTL after task completion", async () => {
    vi.useFakeTimers({ now: 0 });
    const registry = new SessionOccupancyRegistry({ now: Date.now });
    const state = { busy: true, tasks: [{ taskId: "bench", label: "Benchmark", startedAt: 0 }] };
    const runtime = new SessionRuntime({ spawn: async () => ({ state, pids: [] }), isBusy: (s) => s.busy, backgroundTasks: (s) => s.tasks, interrupt: () => {}, close: () => {}, isStale: () => false }, {
      providerId: "claude", occupancy: registry, idleTtlMs: 600_000,
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => {} }, envService: { getEnv: () => ({}) },
    });
    try {
      await runtime.acquire({ sessionId: "session", threadId: "thread", cwd: ".", permissionMode: "default" });
      await vi.advanceTimersByTimeAsync(80 * 60_000);
      state.busy = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runtime.size).toBe(1);
      state.tasks = [];
      registry.nativeChanged(key);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(runtime.size).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runtime.size).toBe(0);
      expect(registry.stamp(key)).toBeNull();
    } finally { await runtime.shutdown(); vi.useRealTimers(); }
  });
});
