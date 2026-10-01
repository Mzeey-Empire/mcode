import { describe, expect, it, vi } from "vitest";
import { SessionRuntime, type ProtocolAdapter } from "../session-runtime.js";

describe("SessionRuntime", () => {
  it("rejects a timed-out teardown wait without spawning an overlapping session", async () => {
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
    const runtime = new SessionRuntime(adapter, {
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      envService: { getEnv: () => ({}) },
    });
    const request = { sessionId: "session", threadId: "thread", cwd: ".", permissionMode: "default" };
    try {
      expect(await runtime.acquire(request)).toEqual({ generation: 1 });
      const stopping = runtime.stop(request.sessionId);
      await vi.advanceTimersByTimeAsync(0);
      const acquiring = Promise.allSettled([runtime.acquire(request)]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await acquiring).toEqual([{ status: "rejected", reason: expect.objectContaining({ message: "Provider session teardown is still pending: session" }) }]);
      expect(adapter.spawn).toHaveBeenCalledOnce();
      expect(runtime.get(request.sessionId)).toBeUndefined();

      let repeatedStopFinished = false;
      const repeatedStop = runtime.stop(request.sessionId).then(() => { repeatedStopFinished = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(repeatedStopFinished).toBe(false);
      expect(adapter.close).toHaveBeenCalledOnce();

      releaseClose();
      await Promise.all([stopping, repeatedStop]);
      expect(await runtime.acquire(request)).toEqual({ generation: 2 });
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
    const runtime = new SessionRuntime(adapter, {
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
    const runtime = new SessionRuntime(adapter, {
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      processes: { attach: () => undefined, terminateTree: async (pid) => { if (pid === 401) throw new Error("failed process cleanup"); } },
      envService: { getEnv: () => ({}) },
    });
    for (const sessionId of ["failed", "peer"]) await runtime.acquire({ sessionId, threadId: sessionId, cwd: ".", permissionMode: "default" });
    let settled = false;
    const closing = runtime.shutdown().finally(() => { settled = true; });
    const failure = expect(closing).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "failed process cleanup" })] });
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
    const runtime = new SessionRuntime(adapter, {
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      processes: { attach, terminateTree },
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
