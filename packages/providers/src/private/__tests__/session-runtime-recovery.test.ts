import { describe, expect, it, vi } from "vitest";
import { SessionRuntime, type ProtocolAdapter } from "../session-runtime.js";

const request = { sessionId: "session", threadId: "thread", cwd: ".", permissionMode: "default" };
const jobObject = { isWindowsJob: false, assign: () => false, setDescription: () => undefined };
const envService = { getEnv: () => ({}) };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}

function adapter(close: ProtocolAdapter<number>["close"], interrupt: ProtocolAdapter<number>["interrupt"] = () => undefined): ProtocolAdapter<number> {
  let generation = 0;
  return {
    spawn: vi.fn(async () => ({ state: ++generation, pids: [generation] })),
    isBusy: () => false,
    interrupt,
    close,
    isStale: () => false,
  };
}

describe("SessionRuntime recovery", () => {
  it("escalates a stuck interrupt and close but waits for verified retirement before replacement", async () => {
    vi.useFakeTimers();
    const interruption = deferred();
    const close = deferred();
    const retired = deferred();
    const protocol = adapter((state) => state === 1 ? close.promise : undefined, (state) => state === 1 ? interruption.promise : undefined);
    const terminateTree = vi.fn(async (pid: number) => {
      if (pid !== 1) return;
      close.resolve();
      interruption.resolve();
      await retired.promise;
    });
    const runtime = new SessionRuntime(protocol, { jobObject, envService, processes: { attach: () => undefined, terminateTree } });
    try {
      await runtime.acquire(request);
      const stopping = runtime.stop(request.sessionId);
      const acquiring = runtime.acquire(request);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(terminateTree).not.toHaveBeenCalled();
      expect(protocol.spawn).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(terminateTree).toHaveBeenCalledExactlyOnceWith(1);
      expect(protocol.spawn).toHaveBeenCalledOnce();
      retired.resolve();
      await stopping;
      expect(await acquiring).toBe(2);
      expect(protocol.spawn).toHaveBeenCalledTimes(2);
    } finally {
      interruption.resolve(); close.resolve(); retired.resolve();
      await runtime.shutdown();
      vi.useRealTimers();
    }
  });

  it("cancels one pending acquisition without cancelling cleanup or another caller", async () => {
    const close = deferred();
    const protocol = adapter((state) => state === 1 ? close.promise : undefined);
    const runtime = new SessionRuntime(protocol, { jobObject, envService, processes: { attach: () => undefined, terminateTree: async () => undefined } });
    try {
      await runtime.acquire(request);
      const stopping = runtime.stop(request.sessionId);
      const controller = new AbortController();
      const cancelled = expect(runtime.acquire({ ...request, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      const acquiring = runtime.acquire(request);
      controller.abort();
      await cancelled;
      expect(protocol.spawn).toHaveBeenCalledOnce();
      close.resolve();
      await stopping;
      expect(await acquiring).toBe(2);
      expect(protocol.spawn).toHaveBeenCalledTimes(2);
    } finally { close.resolve(); await runtime.shutdown(); }
  });

  it("does not drop shared spawn ownership when its first caller cancels", async () => {
    const spawning = deferred();
    const protocol = adapter(() => undefined);
    const spawn = vi.fn(async () => { await spawning.promise; return { state: 1, pids: [1] }; });
    protocol.spawn = spawn;
    const runtime = new SessionRuntime(protocol, { jobObject, envService, processes: { attach: () => undefined, terminateTree: async () => undefined } });
    try {
      const controller = new AbortController();
      const cancelled = expect(runtime.acquire({ ...request, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await cancelled;
      const acquiring = runtime.acquire(request);
      expect(spawn).toHaveBeenCalledOnce();
      spawning.resolve();
      expect(await acquiring).toBe(1);
      expect(spawn).toHaveBeenCalledOnce();
    } finally { spawning.resolve(); await runtime.shutdown(); }
  });

  it("revalidates permission and cwd when joining a cancelled caller's shared spawn", async () => {
    const spawning = deferred();
    const protocol: ProtocolAdapter<{ cwd: string; permissionMode: string }> = {
      spawn: vi.fn(async (args) => { await spawning.promise; return { state: { cwd: args.cwd, permissionMode: args.permissionMode }, pids: [] }; }),
      isBusy: () => false,
      interrupt: () => undefined,
      close: vi.fn(),
      isStale: (state, args) => state.cwd !== args.cwd || state.permissionMode !== args.permissionMode,
    };
    const runtime = new SessionRuntime(protocol, { jobObject, envService });
    try {
      const controller = new AbortController();
      const cancelled = expect(runtime.acquire({ ...request, permissionMode: "full", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await cancelled;
      const acquiring = runtime.acquire({ ...request, cwd: "another-repo", permissionMode: "supervised" });
      spawning.resolve();
      expect(await acquiring).toEqual({ cwd: "another-repo", permissionMode: "supervised" });
      expect(protocol.spawn).toHaveBeenCalledTimes(2);
      expect(protocol.close).toHaveBeenCalledExactlyOnceWith({ cwd: ".", permissionMode: "full" });
    } finally { spawning.resolve(); await runtime.shutdown(); }
  });

  it("keeps replacement fenced when owned process termination fails", async () => {
    const protocol = adapter(() => undefined);
    const terminateTree = vi.fn(async () => { throw new Error("process still alive"); });
    const runtime = new SessionRuntime(protocol, { jobObject, envService, processes: { attach: () => undefined, terminateTree } });
    await runtime.acquire(request);
    await expect(runtime.stop(request.sessionId)).rejects.toThrow("retirement failed");
    await expect(runtime.acquire(request)).rejects.toThrow("retirement failed");
    await expect(runtime.shutdown()).rejects.toThrow("shutdown failed");
    expect(protocol.spawn).toHaveBeenCalledOnce();
    expect(terminateTree).toHaveBeenCalledOnce();
  });

  it("keeps empty-PID replacement fenced when adapter disposal fails", async () => {
    const protocol = adapter(() => { throw new Error("SDK disposal failed"); });
    protocol.spawn = vi.fn(async () => ({ state: 1, pids: [] }));
    const runtime = new SessionRuntime(protocol, { jobObject, envService });
    await runtime.acquire(request);
    await expect(runtime.stop(request.sessionId)).rejects.toThrow("SDK disposal failed");
    await expect(runtime.acquire(request)).rejects.toThrow("SDK disposal failed");
    await expect(runtime.shutdown()).rejects.toThrow("shutdown failed");
    expect(protocol.spawn).toHaveBeenCalledOnce();
  });

  it("keeps retirement fenced when a stopped pending spawn cannot be cleaned up", async () => {
    const spawning = deferred();
    const protocol = adapter(() => undefined);
    let generation = 0;
    protocol.spawn = vi.fn(async () => { await spawning.promise; return { state: ++generation, pids: [generation] }; });
    const runtime = new SessionRuntime(protocol, { jobObject, envService, processes: {
      attach: () => undefined,
      terminateTree: async () => { throw new Error("old process remains alive"); },
    } });
    const acquisition = expect(runtime.acquire(request)).rejects.toThrow("retirement failed during spawn");
    const stopping = expect(runtime.stop(request.sessionId)).rejects.toThrow("retirement failed");
    await Promise.resolve();
    spawning.resolve();
    await Promise.all([acquisition, stopping]);
    await expect(runtime.acquire(request)).rejects.toThrow("retirement failed");
    await expect(runtime.shutdown()).rejects.toThrow("shutdown failed");
    expect(protocol.spawn).toHaveBeenCalledOnce();
  });

  it("allows a later acquisition when a stopped spawn failed before creating a process", async () => {
    const spawning = deferred();
    const protocol = adapter(() => undefined);
    protocol.spawn = vi.fn().mockImplementationOnce(async () => { await spawning.promise; throw new Error("failed before process spawn"); })
      .mockResolvedValueOnce({ state: 2, pids: [] });
    const runtime = new SessionRuntime(protocol, { jobObject, envService });
    const acquisition = expect(runtime.acquire(request)).rejects.toThrow("failed before process spawn");
    const stopping = runtime.stop(request.sessionId);
    await Promise.resolve();
    spawning.resolve();
    await Promise.all([acquisition, stopping]);
    expect(await runtime.acquire(request)).toBe(2);
    await runtime.shutdown();
    expect(protocol.spawn).toHaveBeenCalledTimes(2);
  });

  it("reports failed background eviction without dropping the retirement fence", async () => {
    vi.useFakeTimers();
    const protocol = adapter(() => undefined);
    const warn = vi.fn();
    const runtime = new SessionRuntime(protocol, {
      jobObject, envService, idleTtlMs: 1,
      logger: { debug: () => undefined, info: () => undefined, warn },
      processes: { attach: () => undefined, terminateTree: async () => { throw new Error("process still alive"); } },
    });
    try {
      await runtime.acquire(request);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(warn).toHaveBeenCalledExactlyOnceWith("SessionRuntime idle eviction failed", { error: "Provider process retirement failed" });
      await expect(runtime.acquire(request)).rejects.toThrow("retirement failed");
      expect(protocol.spawn).toHaveBeenCalledOnce();
    } finally {
      await expect(runtime.shutdown()).rejects.toThrow("shutdown failed");
      vi.useRealTimers();
    }
  });
});
