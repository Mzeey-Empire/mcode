import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { SessionOccupancyRegistry, type UserMessageStamp } from "../session-occupancy-registry.js";
import { SessionRuntime } from "../../providers/runtime/session-runtime.js";

const key = { providerId: "claude", threadId: "thread" };

function openStamp(registry: SessionOccupancyRegistry): UserMessageStamp {
  const stamp = registry.stamp(key);
  if (!stamp) throw new Error("Expected an open session");
  return stamp;
}

describe("session occupancy registry", () => {
  it("rejects closed and stale-epoch deliveries and keeps user time monotonic", () => {
    let now = 10;
    const registry = new SessionOccupancyRegistry({ now: () => now });
    expect(registry.stamp(key)).toBeNull();
    const epoch = registry.openSession(key);
    expect(registry.openSession(key)).toBe(epoch);
    const first = openStamp(registry);
    now = 20;
    registry.userMessaged(key, openStamp(registry));
    registry.userMessaged(key, first);
    expect(registry.read(key, now)).toEqual({ held: false, lastActivityAt: 20, lastUserTurnAt: 20 });
    registry.closeSession(key, epoch);
    now = 30;
    registry.userMessaged(key, first);
    expect(registry.stamp(key)).toBeNull();
    const next = registry.openSession(key);
    expect(next).toBeGreaterThan(epoch);
    registry.closeSession(key, epoch);
    registry.userMessaged(key, first);
    expect(registry.stamp(key)).toEqual({ at: 30, epoch: next });
    expect(registry.read(key, now).lastUserTurnAt).toBeNull();
  });

  it("forgets a closed session's activity and never reuses its epoch for another key", () => {
    let now = 10;
    const registry = new SessionOccupancyRegistry({ now: () => now });
    const other = { providerId: "codex", threadId: "thread" };
    const epoch = registry.openSession(key);
    registry.touch(key);
    registry.closeSession(key, epoch);
    expect(registry.read(key, now)).toEqual({ held: false, lastActivityAt: null, lastUserTurnAt: null });
    now = 20;
    const otherEpoch = registry.openSession(other);
    expect(otherEpoch).not.toBe(epoch);
    registry.closeSession(other, epoch);
    expect(registry.stamp(other)).toEqual({ at: 20, epoch: otherEpoch });
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
