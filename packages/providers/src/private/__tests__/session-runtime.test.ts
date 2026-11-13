import { describe, expect, it, vi } from "vitest";
import { SessionRuntime, type ProtocolAdapter } from "../session-runtime.js";
import { diag } from "@mcode/shared/diagnostics";
import type { ProviderSessionOccupancyPort } from "../../host-ports.js";

function epochOccupancy() {
  const records = new Map<string, { epoch: number; open: boolean }>();
  const occupancy: ProviderSessionOccupancyPort = {
    openSession(key) {
      const id = JSON.stringify([key.providerId, key.threadId]);
      const previous = records.get(id);
      if (previous?.open) return previous.epoch;
      const epoch = (previous?.epoch ?? 0) + 1;
      records.set(id, { epoch, open: true });
      return epoch;
    },
    closeSession(key, epoch) {
      const record = records.get(JSON.stringify([key.providerId, key.threadId]));
      if (record?.epoch === epoch) record.open = false;
    },
    nativeChanged: () => {},
    read: () => ({ held: false, lastActivityAt: null, lastUserTurnAt: null }),
  };
  return { records, occupancy };
}

describe("SessionRuntime", () => {
  it("closes occupancy for a spawn that finishes between a stop request and its teardown", async () => {
    const { records, occupancy } = epochOccupancy();
    let finishSpawn!: (result: { state: string; pids: number[] }) => void;
    const spawned = new Promise<{ state: string; pids: number[] }>((resolve) => { finishSpawn = resolve; });
    let spawnCalled!: () => void;
    const spawning = new Promise<void>((resolve) => { spawnCalled = resolve; });
    const runtime = new SessionRuntime<string>({
      spawn: () => { spawnCalled(); return spawned; },
      isBusy: () => false, isStale: () => false, interrupt: () => {}, close: () => {},
    }, { providerId: "test", occupancy,
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => {} },
      envService: { getEnv: () => ({}) },
    });
    try {
      const acquiring = runtime.acquire({ sessionId: "racing", threadId: "thread", cwd: ".", permissionMode: "default" });
      await spawning;
      finishSpawn({ state: "racing", pids: [] });
      const stopping = runtime.stop("racing");
      await Promise.allSettled([acquiring, stopping]);
      expect(records.get(JSON.stringify(["test", "thread"]))).toEqual({ epoch: 1, open: false });
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps replacement occupancy open when an old session is stopped again during teardown", async () => {
    const { records, occupancy } = epochOccupancy();
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let closeStarted!: () => void;
    const closing = new Promise<void>((resolve) => { closeStarted = resolve; });
    const adapter: ProtocolAdapter<string> = {
      spawn: async ({ sessionId }) => ({ state: sessionId, pids: [] }),
      isBusy: () => false, isStale: () => false, interrupt: () => {},
      close: async (sessionId) => {
        if (sessionId === "old") {
          closeStarted();
          await closeGate;
        }
      },
    };
    const runtime = new SessionRuntime(adapter, { providerId: "test", occupancy,
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => {} },
      envService: { getEnv: () => ({}) },
    });
    const request = { threadId: "thread", cwd: ".", permissionMode: "default" };
    const keyId = JSON.stringify(["test", "thread"]);
    try {
      await runtime.acquire({ ...request, sessionId: "old" });
      const stopping = runtime.stop("old");
      await closing;
      expect(records.get(keyId)?.open).toBe(false);
      await runtime.acquire({ ...request, sessionId: "replacement" });
      const lateStop = runtime.stop("old");
      releaseClose();
      await Promise.all([stopping, lateStop]);
      expect(records.get(keyId)?.open).toBe(true);
      await runtime.stop("replacement");
      expect(records.get(keyId)?.open).toBe(false);
    } finally {
      releaseClose();
      await runtime.shutdown();
    }
  });

  it("never opens occupancy for a session stopped while spawning", async () => {
    let release!: () => void;
    const spawning = new Promise<void>((resolve) => { release = resolve; });
    const openSession = vi.fn(() => 1);
    const runtime = new SessionRuntime({
      spawn: async () => { await spawning; return { state: {}, pids: [] }; },
      isBusy: () => false, isStale: () => false, interrupt: () => {}, close: () => {},
    }, { providerId: "test", occupancy: { openSession, closeSession: () => {}, nativeChanged: () => {}, read: () => ({ held: false, lastActivityAt: null, lastUserTurnAt: null }) }, jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => {} }, envService: { getEnv: () => ({}) } });
    const acquisition = expect(runtime.acquire({ sessionId: "session", threadId: "thread", cwd: ".", permissionMode: "default" })).rejects.toThrow();
    const stopping = runtime.stop("session");
    await Promise.resolve();
    release();
    await Promise.all([acquisition, stopping]);
    expect(runtime.size).toBe(0);
    expect(openSession).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  const teardownPaths: Record<string, (runtime: SessionRuntime<{}>) => Promise<unknown>> = {
    stop: (runtime) => runtime.stop("session"),
    idle: () => vi.advanceTimersByTimeAsync(60_000),
    pressure: (runtime) => runtime.evictNonBusy("critical"),
    shutdown: (runtime) => runtime.shutdown(),
  };

  it.each(Object.entries(teardownPaths))("closes occupancy synchronously before native teardown: %s", async (path, startTeardown) => {
    vi.useFakeTimers({ now: 0 });
    let open = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter: ProtocolAdapter<{}> = {
      spawn: async () => ({ state: {}, pids: [] }), isBusy: () => false, isStale: () => false,
      interrupt: () => { expect(open).toBe(false); }, close: () => gate,
    };
    const runtime = new SessionRuntime(adapter, {
      providerId: "test", idleTtlMs: 1,
      occupancy: { openSession: () => { open = true; return 1; }, closeSession: () => { open = false; }, nativeChanged: () => {}, read: () => ({ held: false, lastActivityAt: null, lastUserTurnAt: null }) },
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => {} }, envService: { getEnv: () => ({}) },
    });
    try {
      await runtime.acquire({ sessionId: "session", threadId: "thread", cwd: ".", permissionMode: "default" });
      const stopping = startTeardown(runtime);
      if (path !== "idle") expect(open).toBe(false);
      release();
      await stopping;
      expect(open).toBe(false);
      expect(runtime.size).toBe(0);
    } finally { release(); await runtime.shutdown(); vi.useRealTimers(); }
  });

  it("reports only protected sessions at shutdown and still closes every session", async () => {
    const emit = vi.spyOn(diag, "emit");
    const closed: string[] = [];
    const runtime = new SessionRuntime({
      spawn: async ({ threadId }) => ({ state: threadId, pids: [] }), isBusy: () => false, isStale: () => false,
      backgroundTasks: (id) => id === "held" ? [{ taskId: "bench", label: "Bench", startedAt: Date.now() }] : [],
      interrupt: () => {}, close: (id) => { closed.push(id); },
    }, { providerId: "test", occupancy: { openSession: () => 1, closeSession: () => {}, nativeChanged: () => {}, read: () => ({ held: false, lastActivityAt: null, lastUserTurnAt: null }) }, jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => {} }, envService: { getEnv: () => ({}) } });
    try {
      for (const id of ["held", "idle"]) await runtime.acquire({ sessionId: id, threadId: id, cwd: ".", permissionMode: "default" });
      await runtime.shutdown();
      expect(closed.sort()).toEqual(["held", "idle"]);
      const reports = emit.mock.calls.filter(([name]) => name === "session.shutdown-held");
      expect(reports.map(([, context, payload]) => [context, payload?.()])).toEqual([
        [{ th: "held" }, { held: false, nativeTasks: 1, nativeProtecting: 1 }],
      ]);
    } finally { await runtime.shutdown(); emit.mockRestore(); }
  });

  it("records the reason and counts of idle and memory-pressure evictions", async () => {
    vi.useFakeTimers({ now: 0 });
    const emit = vi.spyOn(diag, "emit");
    const runtime = new SessionRuntime({
      spawn: async ({ threadId }) => ({ state: threadId, pids: [] }), isBusy: () => false, isStale: () => false,
      backgroundTasks: () => [{ taskId: "expired", label: "Expired", startedAt: 0 }],
      interrupt: () => {}, close: () => {},
    }, { providerId: "test", idleTtlMs: 30_000, nativeCapMs: 1_000,
      occupancy: { openSession: () => 1, closeSession: () => {}, nativeChanged: () => {}, read: () => ({ held: false, lastActivityAt: null, lastUserTurnAt: null }) },
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => {} }, envService: { getEnv: () => ({}) } });
    try {
      await runtime.acquire({ sessionId: "pressure", threadId: "pressure", cwd: ".", permissionMode: "default" });
      await vi.advanceTimersByTimeAsync(5_000);
      await runtime.evictNonBusy("critical");
      await runtime.acquire({ sessionId: "idle", threadId: "idle", cwd: ".", permissionMode: "default" });
      await vi.advanceTimersByTimeAsync(55_000);
      expect(runtime.size).toBe(0);
      const evictions = emit.mock.calls.filter(([name]) => name === "session.evict");
      const counts = { turnBusy: false, nativeTasks: 1, nativeProtecting: 0, held: false };
      expect(evictions.map(([, context, payload]) => [context, payload?.()])).toEqual([
        [{ th: "pressure" }, { reason: "memory-pressure", idleMs: 5_000, ...counts }],
        [{ th: "idle" }, { reason: "idle", idleMs: 55_000, ...counts }],
      ]);
    } finally { await runtime.shutdown(); emit.mockRestore(); vi.useRealTimers(); }
  });

  it("preserves admitted preparation and native busy sessions while evicting an idle peer", async () => {
    const adapter: ProtocolAdapter<{ id: string; busy: boolean }> = {
      spawn: async ({ sessionId }) => ({ state: { id: sessionId, busy: sessionId === "busy" }, pids: [] }),
      isBusy: (state) => state.busy,
      interrupt: () => undefined,
      close: vi.fn(),
      isStale: () => false,
    };
    const runtime = new SessionRuntime(adapter, { providerId: "test", occupancy: { read: () => ({ held: false, lastActivityAt: null, lastUserTurnAt: null }), openSession: () => 1, closeSession: () => {}, nativeChanged: () => {} },
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      envService: { getEnv: () => ({}) },
    });
    const admitted = new Set(["preparing"]);
    try {
      for (const sessionId of ["preparing", "idle", "busy"]) {
        await runtime.acquire({ sessionId, threadId: sessionId, cwd: ".", permissionMode: "full" });
      }
      expect(await runtime.evictNonBusy("critical", (sessionId) => admitted.has(sessionId))).toEqual({ before: 3, after: 2, evicted: ["idle"] });
      expect(adapter.close).toHaveBeenCalledExactlyOnceWith({ id: "idle", busy: false });
      admitted.delete("preparing");
      expect(await runtime.evictNonBusy("critical", (sessionId) => admitted.has(sessionId))).toEqual({ before: 2, after: 1, evicted: ["preparing"] });
      expect(runtime.get("busy")).toBeDefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it("rechecks admission protection after awaiting an earlier peer teardown", async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const adapter: ProtocolAdapter<{ id: string }> = {
      spawn: async ({ sessionId }) => ({ state: { id: sessionId }, pids: [] }),
      isBusy: () => false,
      interrupt: () => undefined,
      close: vi.fn((state) => state.id === "first" ? closeGate : Promise.resolve()),
      isStale: () => false,
    };
    const runtime = new SessionRuntime(adapter, { providerId: "test", occupancy: { read: () => ({ held: false, lastActivityAt: null, lastUserTurnAt: null }), openSession: () => 1, closeSession: () => {}, nativeChanged: () => {} },
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      envService: { getEnv: () => ({}) },
    });
    const admitted = new Set<string>();
    try {
      for (const sessionId of ["first", "later"]) {
        await runtime.acquire({ sessionId, threadId: sessionId, cwd: ".", permissionMode: "full" });
      }
      const shedding = runtime.evictNonBusy("critical", (sessionId) => admitted.has(sessionId));
      await vi.waitFor(() => expect(adapter.close).toHaveBeenCalledExactlyOnceWith({ id: "first" }));
      admitted.add("later");
      releaseClose();
      expect(await shedding).toEqual({ before: 2, after: 1, evicted: ["first"] });
      expect(adapter.close).toHaveBeenCalledOnce();
      expect(runtime.get("later")).toEqual({ id: "later" });
    } finally {
      releaseClose();
      await runtime.shutdown();
    }
  });

  it("preserves a replacement created while an earlier peer teardown is pending", async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let generation = 0;
    const adapter: ProtocolAdapter<{ id: string; generation: number; busy: boolean }> = {
      spawn: async ({ sessionId }) => ({ state: { id: sessionId, generation: ++generation, busy: false }, pids: [] }),
      isBusy: (state) => state.busy,
      interrupt: () => undefined,
      close: vi.fn((state) => state.id === "first" ? closeGate : Promise.resolve()),
      isStale: () => false,
    };
    const runtime = new SessionRuntime(adapter, { providerId: "test", occupancy: { read: () => ({ held: false, lastActivityAt: null, lastUserTurnAt: null }), openSession: () => 1, closeSession: () => {}, nativeChanged: () => {} },
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      envService: { getEnv: () => ({}) },
    });
    const request = { sessionId: "later", threadId: "later", cwd: ".", permissionMode: "full" };
    try {
      await runtime.acquire({ ...request, sessionId: "first", threadId: "first" });
      const original = await runtime.acquire(request);
      const shedding = runtime.evictNonBusy("critical");
      await vi.waitFor(() => expect(adapter.close).toHaveBeenCalledExactlyOnceWith({ id: "first", generation: 1, busy: false }));
      await runtime.stop(request.sessionId);
      const replacement = await runtime.acquire(request);
      replacement.busy = true;
      releaseClose();
      expect(await shedding).toEqual({ before: 2, after: 1, evicted: ["first"] });
      expect(runtime.get(request.sessionId)).toBe(replacement);
      expect(adapter.close).toHaveBeenCalledTimes(2);
      expect(adapter.close).toHaveBeenCalledWith(original);
      expect(adapter.close).not.toHaveBeenCalledWith(replacement);
    } finally {
      releaseClose();
      await runtime.shutdown();
    }
  });

  it("keeps acquisitions pending through slow teardown and starts one replacement after close", async () => {
    vi.useFakeTimers();
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let generation = 0;
    const adapter: ProtocolAdapter<{ generation: number }> = {
      spawn: vi.fn(async () => ({ state: { generation: ++generation }, pids: [] })),
      isBusy: () => false,
      interrupt: () => undefined,
      close: vi.fn((state) => state.generation === 1 ? closeGate : Promise.resolve()),
      isStale: () => false,
    };
    const runtime = new SessionRuntime(adapter, { providerId: "test", occupancy: { read: () => ({ held: false, lastActivityAt: null, lastUserTurnAt: null }), openSession: () => 1, closeSession: () => {}, nativeChanged: () => {} },
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      envService: { getEnv: () => ({}) },
    });
    const request = { sessionId: "session", threadId: "thread", cwd: ".", permissionMode: "default" };
    try {
      expect(await runtime.acquire(request)).toEqual({ generation: 1 });
      const stopping = runtime.stop(request.sessionId);
      await vi.advanceTimersByTimeAsync(0);
      let acquired = false;
      const acquiring = Promise.all([runtime.acquire(request), runtime.acquire(request)]).then((states) => { acquired = true; return states; });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(acquired).toBe(false);
      expect(adapter.spawn).toHaveBeenCalledOnce();
      expect(runtime.get(request.sessionId)).toBeUndefined();

      let repeatedStopFinished = false;
      const repeatedStop = runtime.stop(request.sessionId).then(() => { repeatedStopFinished = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(repeatedStopFinished).toBe(false);
      expect(adapter.close).toHaveBeenCalledOnce();

      releaseClose();
      await Promise.all([stopping, repeatedStop]);
      const states = await acquiring;
      expect(states).toEqual([{ generation: 2 }, { generation: 2 }]);
      expect(states[0]).toBe(states[1]);
      expect(adapter.spawn).toHaveBeenCalledTimes(2);
      await runtime.shutdown();
      await expect(runtime.acquire(request)).rejects.toThrow("shutting down");
    } finally {
      releaseClose();
      await runtime.shutdown();
      vi.useRealTimers();
    }
  });

  it("waits for an existing teardown and prevents a waiting acquire from respawning during shutdown", async () => {
    let releaseClose!: () => void;
    const state = { id: "state" };
    const adapter: ProtocolAdapter<typeof state> = {
      spawn: vi.fn(async () => ({ state, pids: [] })),
      isBusy: () => false,
      interrupt: () => undefined,
      close: vi.fn(() => new Promise<void>((resolve) => { releaseClose = resolve; })),
      isStale: () => false,
    };
    const runtime = new SessionRuntime(adapter, { providerId: "test", occupancy: { read: () => ({ held: false, lastActivityAt: null, lastUserTurnAt: null }), openSession: () => 1, closeSession: () => {}, nativeChanged: () => {} },
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      envService: { getEnv: () => ({}) },
    });
    const request = { sessionId: "session", threadId: "thread", cwd: ".", permissionMode: "default" };
    await runtime.acquire(request);
    const stopping = runtime.stop(request.sessionId);
    await vi.waitFor(() => expect(adapter.close).toHaveBeenCalledOnce());
    const acquiring = expect(runtime.acquire(request)).rejects.toThrow("shutting down");
    let shutdownFinished = false;
    const shutdown = runtime.shutdown().then(() => { shutdownFinished = true; });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    releaseClose();
    await Promise.all([stopping, shutdown, acquiring]);
    expect(adapter.spawn).toHaveBeenCalledOnce();
    expect(adapter.close).toHaveBeenCalledOnce();
  });

  it("finishes a healthy peer close before reporting a process cleanup failure", async () => {
    let releasePeer!: () => void;
    const adapter: ProtocolAdapter<{ id: string }> = {
      spawn: async ({ sessionId }) => ({ state: { id: sessionId }, pids: [sessionId === "failed" ? 401 : 402] }),
      isBusy: () => false,
      interrupt: () => undefined,
      close: vi.fn((state) => state.id === "peer" ? new Promise<void>((resolve) => { releasePeer = resolve; }) : Promise.resolve()),
      isStale: () => false,
    };
    const runtime = new SessionRuntime(adapter, { providerId: "test", occupancy: { read: () => ({ held: false, lastActivityAt: null, lastUserTurnAt: null }), openSession: () => 1, closeSession: () => {}, nativeChanged: () => {} },
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      processes: { open: () => { throw new Error("session-runtime.test.ts fixture does not support process sessions"); }, run: async () => { throw new Error("session-runtime.test.ts fixture does not support process runs"); }, attach: () => undefined, terminateTree: async (pid) => { if (pid === 401) throw new Error("failed process cleanup"); } },
      envService: { getEnv: () => ({}) },
    });
    for (const sessionId of ["failed", "peer"]) await runtime.acquire({ sessionId, threadId: sessionId, cwd: ".", permissionMode: "default" });
    let settled = false;
    const closing = runtime.shutdown().finally(() => { settled = true; });
    const failure = expect(closing).rejects.toMatchObject({ errors: [expect.objectContaining({ errors: [expect.objectContaining({ message: "failed process cleanup" })] })] });
    await vi.waitFor(() => expect(adapter.close).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    releasePeer();
    await failure;
  });

  it("uses the server process port for spawned session ownership and cleanup", async () => {
    const state = { id: "state" };
    const adapter: ProtocolAdapter<typeof state> = {
      spawn: vi.fn(async () => ({ state, pids: [401] })),
      isBusy: () => false,
      interrupt: vi.fn(),
      close: vi.fn(),
      isStale: () => false,
    };
    const attach = vi.fn();
    const terminateTree = vi.fn(async () => undefined);
    const runtime = new SessionRuntime(adapter, { providerId: "test", occupancy: { read: () => ({ held: false, lastActivityAt: null, lastUserTurnAt: null }), openSession: () => 1, closeSession: () => {}, nativeChanged: () => {} },
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      processes: { open: () => { throw new Error("session-runtime.test.ts fixture does not support process sessions"); }, run: async () => { throw new Error("session-runtime.test.ts fixture does not support process runs"); }, attach, terminateTree },
      envService: { getEnv: () => ({}) },
    });

    await runtime.acquire({
      sessionId: "mcode-session",
      threadId: "thread",
      cwd: ".",
      permissionMode: "default",
    });
    await runtime.stop("mcode-session");

    expect(attach).toHaveBeenCalledExactlyOnceWith(401, "mcode session mcode-session");
    expect(adapter.interrupt).toHaveBeenCalledExactlyOnceWith(state);
    expect(adapter.close).toHaveBeenCalledExactlyOnceWith(state);
    expect(terminateTree).toHaveBeenCalledExactlyOnceWith(401);
  });
});
