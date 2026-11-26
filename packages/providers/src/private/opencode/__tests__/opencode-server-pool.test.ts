import { describe, expect, it, vi } from "vitest";
import { OpenCodeServerPool, OPENCODE_POOL_IDLE_TTL_MS } from "../opencode-server-pool.js";

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const child = {
    pid: 4242,
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    off: vi.fn(),
    kill: vi.fn(() => true),
  };
  return {
    child,
    listeners,
    deps: {
      spawn: vi.fn(() => child),
      waitForHealth: vi.fn(async () => {}),
      terminateTree: vi.fn(async () => {}),
      waitForPortClosed: vi.fn(async () => {}),
      findFreePort: vi.fn(async () => 4096),
      now: vi.fn(() => 1_000),
      env: vi.fn(() => ({})),
      ...overrides,
    } as never,
  };
}

describe("OpenCodeServerPool", () => {
  it("shares one process across two acquires with the same key", async () => {
    const { deps } = fakeDeps();
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    const first = await pool.acquire(key);
    const second = await pool.acquire(key);
    expect(first.baseUrl).toBe(second.baseUrl);
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(1);
    await pool.shutdown();
  });

  it("isolates a second worktree on its own process", async () => {
    const { deps } = fakeDeps();
    const pool = new OpenCodeServerPool(deps);
    await pool.acquire({ binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" });
    await pool.acquire({ binaryPath: "opencode", cwd: "/w/b", hostname: "127.0.0.1" });
    expect(deps.spawn).toHaveBeenCalledTimes(2);
    expect(pool.size).toBe(2);
    await pool.shutdown();
  });

  it("closes idle entries after the TTL with proven tree termination", async () => {
    const { deps, child } = fakeDeps();
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    await pool.acquire(key);
    pool.release(key);
    const closed = await pool.closeIdle(1_000 + OPENCODE_POOL_IDLE_TTL_MS + 1);
    expect(closed).toHaveLength(1);
    expect(deps.terminateTree).toHaveBeenCalledWith(4242);
    expect(child.kill).not.toHaveBeenCalled();
    expect(pool.size).toBe(0);
    await pool.shutdown();
  });

  it("keeps ownership and reports failure when tree termination fails", async () => {
    const terminateTree = vi.fn(async () => { throw new Error("taskkill failed"); });
    const { deps, child } = fakeDeps({ terminateTree });
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    await pool.acquire(key);
    pool.release(key);
    await expect(pool.closeIdle(1_000 + OPENCODE_POOL_IDLE_TTL_MS + 1)).rejects.toThrow("taskkill failed");
    expect(child.kill).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);
    terminateTree.mockImplementation(async () => {});
    await pool.shutdown();
    expect(pool.size).toBe(0);
  });

  it("cleans up without orphans when the child exits unexpectedly", async () => {
    const { deps, listeners, child } = fakeDeps();
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    await pool.acquire(key);
    pool.release(key);
    for (const listener of listeners.get("exit") ?? []) listener(null, null);
    await vi.waitFor(() => expect(pool.size).toBe(0));
    expect(pool.size).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
    await pool.shutdown();
  });

  it("waits for health before sharing a server with a concurrent acquire", async () => {
    let finishHealth: (() => void) | undefined;
    const health = new Promise<void>((resolve) => { finishHealth = resolve; });
    const { deps } = fakeDeps({ waitForHealth: vi.fn(() => health) });
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    const first = pool.acquire(key);
    await vi.waitFor(() => expect(pool.entryFor(key)?.ready).toBe(false));
    let secondResolved = false;
    const second = pool.acquire(key).then((entry) => { secondResolved = true; return entry; });
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    finishHealth?.();
    const [firstEntry, secondEntry] = await Promise.all([first, second]);
    expect(firstEntry).toBe(secondEntry);
    expect(firstEntry.refs).toBe(2);
    expect(firstEntry.ready).toBe(true);
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    await pool.shutdown();
  });

  it("waits for closing to finish before acquiring a replacement server", async () => {
    let finishTermination: (() => void) | undefined;
    const termination = new Promise<void>((resolve) => { finishTermination = resolve; });
    const terminateTree = vi.fn().mockImplementationOnce(() => termination).mockResolvedValue(undefined);
    const { deps } = fakeDeps({ terminateTree });
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    await pool.acquire(key);
    const closing = pool.close(key);
    await vi.waitFor(() => expect(terminateTree).toHaveBeenCalledTimes(1));
    let acquired = false;
    const replacement = pool.acquire(key).then((entry) => { acquired = true; return entry; });
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    finishTermination?.();
    await closing;
    const entry = await replacement;
    expect(entry.ready).toBe(true);
    expect(entry.refs).toBe(1);
    expect(deps.spawn).toHaveBeenCalledTimes(2);
    await pool.shutdown();
  });

  it("keeps an active server owned when its shell wrapper exits", async () => {
    const { deps, listeners } = fakeDeps();
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    await pool.acquire(key);
    for (const listener of listeners.get("exit") ?? []) listener(null, null);
    expect(pool.size).toBe(1);
    expect(pool.entryFor(key)?.refs).toBe(1);
    await pool.shutdown();
    expect(pool.size).toBe(0);
  });

  it("waits for a pending start and refuses new work during shutdown", async () => {
    let finishHealth: (() => void) | undefined;
    const health = new Promise<void>((resolve) => { finishHealth = resolve; });
    const { deps } = fakeDeps({ waitForHealth: vi.fn(() => health) });
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    const acquire = pool.acquire(key);
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledTimes(1));
    const shutdown = pool.shutdown();
    await expect(pool.acquire({ ...key, cwd: "/w/b" })).rejects.toThrow("shutting down");
    expect(pool.size).toBe(1);
    finishHealth?.();
    await expect(acquire).rejects.toThrow("shutting down");
    await shutdown;
    expect(pool.size).toBe(0);
    expect(deps.terminateTree).toHaveBeenCalledWith(4242);
  });

  it("does not spawn after shutdown overtakes free-port allocation", async () => {
    let finishPort: ((port: number) => void) | undefined;
    const port = new Promise<number>((resolve) => { finishPort = resolve; });
    const { deps } = fakeDeps({ findFreePort: vi.fn(() => port) });
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    const acquire = pool.acquire(key);
    const shutdown = pool.shutdown();
    finishPort?.(4096);
    await expect(acquire).rejects.toThrow("shutting down");
    await shutdown;
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(pool.size).toBe(0);
  });

  it("owns the shell and descendants in a scope before declaring ready", async () => {
    const events: string[] = [];
    const scope = {
      ready: true,
      assign: vi.fn((_pid: number) => { events.push("assign"); return { ok: true }; }),
      reconcile: vi.fn(async (_pid: number) => { events.push("reconcile"); return { ok: true }; }),
      terminate: vi.fn(() => { events.push("terminate"); return { ok: true }; }),
      waitForEmpty: vi.fn(async () => { events.push("empty"); return { ok: true }; }),
      close: vi.fn(() => { events.push("scope-close"); }),
    };
    const { deps } = fakeDeps({
      createScope: () => scope,
      waitForHealth: vi.fn(async () => { events.push("health"); }),
      waitForPortClosed: vi.fn(async () => { events.push("port-closed"); }),
    });
    const pool = new OpenCodeServerPool(deps);
    await pool.acquire({ binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" });
    await pool.shutdown();
    expect(events).toEqual(["assign", "reconcile", "health", "terminate", "empty", "port-closed", "scope-close"]);
    expect(deps.terminateTree).not.toHaveBeenCalled();
  });

  it("does not spawn when its Windows process scope is unavailable", async () => {
    const close = vi.fn();
    const { deps } = fakeDeps({ createScope: () => ({ ready: false, close }) });
    const pool = new OpenCodeServerPool(deps);
    await expect(pool.acquire({ binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" }))
      .rejects.toThrow("process scope unavailable");
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    await pool.shutdown();
  });

  it("retains ownership when the port remains open after termination", async () => {
    const waitForPortClosed = vi.fn(async () => { throw new Error("port 4096 remained open"); });
    const { deps } = fakeDeps({ waitForPortClosed });
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    await pool.acquire(key);
    await expect(pool.close(key)).rejects.toThrow("port 4096 remained open");
    expect(pool.size).toBe(1);
    waitForPortClosed.mockImplementation(async () => {});
    await pool.close(key);
    expect(pool.size).toBe(0);
    await pool.shutdown();
  });

  it("rejects the acquire when the child fails to spawn instead of crashing", async () => {
    const { deps, listeners } = fakeDeps({
      waitForHealth: vi.fn(async () => {
        for (const listener of listeners.get("error") ?? []) listener(new Error("spawn opencode ENOENT"));
      }),
    });
    const pool = new OpenCodeServerPool(deps);
    await expect(pool.acquire({ binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" }))
      .rejects.toThrow("OpenCode serve failed to start");
    expect(pool.size).toBe(0);
    await pool.shutdown();
  });
});
