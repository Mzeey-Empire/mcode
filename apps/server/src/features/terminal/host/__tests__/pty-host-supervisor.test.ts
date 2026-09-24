import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vitest";
import { InMemoryPtyHostCleanupLedger } from "../../testing/in-memory-pty-host-cleanup-ledger.js";
import type {
  PtyHostEvent,
  PtyHostServerMessage,
} from "../pty-host-protocol.js";
import { PtyHostSupervisor, type PtyHostChild } from "../pty-host-supervisor.js";

const UUID = "abcdef12-abcd-4abc-8abc-abcdefabcdef";
const createRequest = {
  sessionId: UUID,
  hostGeneration: "1",
  launch: {
    requestedProfileId: "automatic" as const,
    resolvedProfile: {
      id: "certified:windows-powershell-7" as const,
      name: "PowerShell 7",
      executable: "pwsh.exe",
      arguments: [],
      source: "certified" as const,
      platform: "windows" as const,
    },
    scope: { kind: "workspace" as const, workspaceId: UUID },
    arguments: [],
  },
  cwd: "C:\\repo",
  protectedEnv: [],
  cols: 80,
  rows: 24,
};

class FakeHostChild extends NodeEvents.EventEmitter implements PtyHostChild {
  readonly pid = 42;
  readonly connected = true;
  respondToInspection = true;
  respondToHandshake = true;
  readonly send = vi.fn(
    (
      message: PtyHostServerMessage,
      callback?: (error: Error | null) => void,
    ) => {
      queueMicrotask(() => callback?.(null));
      if (message.kind === "shutdown") {
        this.emit("exit", 0, null);
        return true;
      }
      if (message.kind === "inspectChildren" && this.respondToInspection) {
        queueMicrotask(() => {
          this.emitMessage({
            contractVersion: 1,
            kind: "children",
            sessionId: message.sessionId,
            hostGeneration: message.hostGeneration,
            hasChildren: true,
          });
        });
        return true;
      }
      if (message.kind !== "handshake") return true;
      if (!this.respondToHandshake) return true;
      queueMicrotask(() => {
        this.emitMessage({
          contractVersion: 1,
          kind: "ready",
          hostGeneration: message.requestedGeneration,
          platform: message.platform,
          nativeAbi: "fake-v1",
          capabilities: {
            pty: message.platform === "windows" ? "conpty" : "posix-pty",
            containment:
              message.platform === "windows" ? "job-object" : "process-group",
            maxSessions: 20,
            protocolVersion: 1,
          },
        });
        this.emitMessage({
          contractVersion: 1,
          kind: "heartbeat",
          hostGeneration: message.requestedGeneration,
          monotonicMs: "1",
          activeSessions: 0,
          queueBytes: 0,
          rssBytes: "1",
        });
      });
      return true;
    },
  );
  readonly kill = vi.fn(() => true);
  readonly disposeContainment = vi.fn();

  emitMessage(event: PtyHostEvent): void {
    this.emit("message", event);
  }

  crash(): void {
    this.emit("exit", 1, null);
  }
}

describe("PtyHostSupervisor", () => {
  it("waits for graceful host exit beyond the normal operation deadline", async () => {
    vi.useFakeTimers();
    const child = new FakeHostChild();
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      spawnHost: () => child,
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
    });
    try {
      await supervisor.start();
      child.send.mockImplementation((_message, callback) => {
        callback?.(null);
        return true;
      });
      const stopped = supervisor.shutdown();
      await vi.advanceTimersByTimeAsync(7_600);
      expect(child.kill).not.toHaveBeenCalled();
      Object.defineProperty(child, "connected", { value: false });
      child.emit("exit", 0, null);
      await stopped;
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts one healthy generation and replaces one crashed host", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
    });
    const events: PtyHostEvent[] = [];
    supervisor.subscribe((event) => events.push(event));

    await expect(supervisor.start()).resolves.toEqual({
      hostGeneration: "1",
      state: "healthy",
    });
    expect(supervisor.diagnostics()).toMatchObject({
      lastHeartbeatMsAgo: 0,
      queueBytes: 0,
      eventLoopLagMs: 0,
      hostRssBytes: "1",
    });
    expect(children).toHaveLength(1);

    children[0]!.crash();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "failure",
        hostGeneration: "1",
        code: "HOST_UNHEALTHY",
        recoverable: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(children[0]!.disposeContainment).toHaveBeenCalledOnce();
    await expect(supervisor.whenHealthy()).resolves.toEqual({
      hostGeneration: "2",
      state: "healthy",
    });
    expect(children).toHaveLength(2);

    children[1]!.crash();
    await vi.advanceTimersByTimeAsync(250);
    expect(supervisor.health()).toEqual({
      hostGeneration: "2",
      state: "unhealthy",
    });
    expect(children).toHaveLength(2);
    await supervisor.shutdown();
    vi.useRealTimers();
  });

  it("probes a missed heartbeat and replaces the unresponsive host once", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
    });
    await supervisor.start();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(supervisor.health().state).toBe("degraded");
    expect(children[0]!.send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "probe" }),
      expect.any(Function),
    );

    await vi.advanceTimersByTimeAsync(5_250);
    await expect(supervisor.whenHealthy()).resolves.toMatchObject({
      hostGeneration: "2",
      state: "healthy",
    });
    expect(children).toHaveLength(2);
    await supervisor.shutdown();
    vi.useRealTimers();
  });

  it("accepts a running session after a delayed server create timer", async () => {
    vi.useFakeTimers();
    const child = new FakeHostChild();
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      operationTimeoutMs: 10,
      heartbeatDegradedMs: 2_000,
      heartbeatUnhealthyMs: 3_000,
      spawnHost: () => child,
    });
    try {
      await supervisor.start();
      const creating = supervisor.create(createRequest);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 1_000);
      await vi.advanceTimersByTimeAsync(10);
      clock.mockRestore();
      child.emitMessage({
        contractVersion: 1,
        kind: "running",
        sessionId: UUID,
        hostGeneration: "1",
        rootPid: 123,
        processGroupId: "job-123",
        containment: "job-object",
      });
      await expect(creating).resolves.toMatchObject({ state: "running" });
    } finally {
      await supervisor.shutdown().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("accepts a running session beyond five seconds under the default create deadline", async () => {
    vi.useFakeTimers();
    const child = new FakeHostChild();
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => child,
    });
    try {
      await supervisor.start();
      const creating = supervisor.create(createRequest);
      const settled = vi.fn();
      void creating.then(settled, settled);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(settled).not.toHaveBeenCalled();
      child.emitMessage({
        contractVersion: 1,
        kind: "heartbeat",
        hostGeneration: "1",
        monotonicMs: "2",
        activeSessions: 0,
        queueBytes: 0,
        rssBytes: "1",
      });
      child.emitMessage({
        contractVersion: 1,
        kind: "running",
        sessionId: UUID,
        hostGeneration: "1",
        rootPid: 123,
        processGroupId: "job-123",
        containment: "job-object",
      });
      await expect(creating).resolves.toMatchObject({ state: "running" });
    } finally {
      await supervisor.shutdown().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("keeps a live host through a four-second server stall", async () => {
    vi.useFakeTimers();
    const child = new FakeHostChild();
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => child,
    });
    try {
      await supervisor.start();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(supervisor.health().state).toBe("healthy");
      child.emitMessage({
        contractVersion: 1,
        kind: "heartbeat",
        hostGeneration: "1",
        monotonicMs: "2",
        activeSessions: 0,
        queueBytes: 0,
        rssBytes: "1",
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(supervisor.health().state).toBe("healthy");
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      await supervisor.shutdown().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("closes a session that reports running after its create deadline", async () => {
    vi.useFakeTimers();
    const child = new FakeHostChild();
    const ledger = new InMemoryPtyHostCleanupLedger();
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: ledger,
      operationTimeoutMs: 10,
      spawnHost: () => child,
    });
    await supervisor.start();

    const creating = supervisor.create(createRequest);
    const rejection = expect(creating).rejects.toThrow("PTY create exceeded 10ms");
    await vi.advanceTimersByTimeAsync(10);
    await rejection;

    child.emitMessage({
      contractVersion: 1,
      kind: "running",
      sessionId: UUID,
      hostGeneration: "1",
      rootPid: 123,
      processGroupId: "job-123",
      containment: "job-object",
    });

    expect(ledger.list()).toEqual([
      expect.objectContaining({ sessionId: UUID, hostGeneration: "1" }),
    ]);
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "close",
        sessionId: UUID,
        closeSeq: "1",
        reason: "scope-reset",
      }),
      expect.any(Function),
    );

    child.emitMessage({
      contractVersion: 1,
      kind: "exit",
      sessionId: UUID,
      hostGeneration: "1",
      finalOutputSeq: "0",
      code: 0,
      signal: null,
      reason: "user-close",
    });
    expect(ledger.list()).toEqual([]);
    await supervisor.shutdown();
    vi.useRealTimers();
  });

  it("waits for running and exit events at the adapter boundary", async () => {
    const child = new FakeHostChild();
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => child,
    });
    await supervisor.start();

    const creating = supervisor.create(createRequest);
    child.emitMessage({
      contractVersion: 1,
      kind: "running",
      sessionId: UUID,
      hostGeneration: "1",
      rootPid: 123,
      processGroupId: "job-123",
      containment: "job-object",
    });
    await expect(creating).resolves.toMatchObject({ state: "running" });
    await expect(supervisor.inspectChildren(UUID, "1")).resolves.toEqual({
      hasChildren: true,
    });
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "inspectChildren", sessionId: UUID }),
      expect.any(Function),
    );

    let closed = false;
    const closing = supervisor
      .close({
        sessionId: UUID,
        hostGeneration: "1",
        closeSeq: "1",
        reason: "user",
      })
      .then(() => {
        closed = true;
      });
    await Promise.resolve();
    expect(closed).toBe(false);
    child.emitMessage({
      contractVersion: 1,
      kind: "exit",
      sessionId: UUID,
      hostGeneration: "1",
      finalOutputSeq: "0",
      code: 0,
      signal: null,
      reason: "user-close",
    });
    await closing;
    await supervisor.shutdown();
  });

  it("rejects startup when the handshake channel is unavailable", async () => {
    const child = new FakeHostChild();
    Object.defineProperty(child, "connected", { value: false });
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => child,
    });

    await expect(supervisor.start()).rejects.toThrow(
      "PTY host channel is unavailable",
    );
    expect(supervisor.health().state).toBe("unhealthy");
  });

  it("clears a rejected startup when spawning the host throws", async () => {
    const spawnError = new Error("PTY host executable is unavailable");
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        throw spawnError;
      },
    });

    const starting = supervisor.start();
    await expect(starting).rejects.toBe(spawnError);
    expect(supervisor.health().state).toBe("unhealthy");
    const whenHealthy = supervisor.whenHealthy();
    expect(whenHealthy).not.toBe(starting);
    await expect(whenHealthy).rejects.toBeInstanceOf(Error);
    await supervisor.shutdown();
  });

  it("settles a synchronous replacement spawn failure without retaining its rejection", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const spawnHost = vi.fn(() => {
      if (children.length > 0) {
        throw new Error("PTY host executable is unavailable");
      }
      const child = new FakeHostChild();
      children.push(child);
      return child;
    });
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost,
    });

    await supervisor.start();
    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(250);

    expect(supervisor.health()).toEqual({
      hostGeneration: "2",
      state: "unhealthy",
    });
    expect(children[0]!.disposeContainment).toHaveBeenCalledOnce();
    await expect(supervisor.whenHealthy()).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(500);
    expect(spawnHost).toHaveBeenCalledTimes(2);
    await supervisor.shutdown();
    expect(children[0]!.disposeContainment).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("rejects child inspection when the session exits before the host responds", async () => {
    const child = new FakeHostChild();
    child.respondToInspection = false;
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => child,
    });
    await supervisor.start();
    const creating = supervisor.create(createRequest);
    child.emitMessage({
      contractVersion: 1,
      kind: "running",
      sessionId: UUID,
      hostGeneration: "1",
      rootPid: 123,
      processGroupId: "job-123",
      containment: "job-object",
    });
    await creating;

    const inspection = supervisor.inspectChildren(UUID, "1");
    child.emitMessage({
      contractVersion: 1,
      kind: "exit",
      sessionId: UUID,
      hostGeneration: "1",
      finalOutputSeq: "0",
      code: 0,
      signal: null,
      reason: "natural",
    });

    await expect(inspection).rejects.toThrow("PTY session exited");
    await supervisor.shutdown();
  });

  it("retains failed cleanup records and blocks replacement", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const reapProcessTree = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
      reapProcessTree,
    });
    const events: PtyHostEvent[] = [];
    supervisor.subscribe((event) => events.push(event));
    await supervisor.start();
    const creating = supervisor.create(createRequest);
    children[0]!.emitMessage({
      contractVersion: 1,
      kind: "running",
      sessionId: UUID,
      hostGeneration: "1",
      rootPid: 123,
      processGroupId: "job-123",
      containment: "job-object",
    });
    await creating;

    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(250);

    expect(reapProcessTree).toHaveBeenCalledOnce();
    expect(children).toHaveLength(1);
    expect(supervisor.health().state).toBe("unhealthy");
    expect(events.filter((event) => event.kind === "failure").at(-1)).toMatchObject({
      kind: "failure",
      hostGeneration: "1",
      code: "HOST_UNHEALTHY",
      recoverable: false,
    });
    await expect(supervisor.shutdown()).rejects.toThrow(
      "PTY host shutdown cleanup failed",
    );
    expect(reapProcessTree).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("reaps durable records before it starts a new host generation", async () => {
    const ledger = new InMemoryPtyHostCleanupLedger();
    ledger.record({
      sessionId: UUID,
      hostGeneration: "7",
      rootPid: 123,
      processGroupId: "job-123",
      containment: "job-object",
    });
    const order: string[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: ledger,
      reapProcessTree: vi.fn(async () => {
        order.push("reap");
      }),
      spawnHost: () => {
        order.push("spawn");
        return new FakeHostChild();
      },
    });

    await expect(supervisor.start()).resolves.toMatchObject({
      hostGeneration: "1",
      state: "healthy",
    });
    expect(order).toEqual(["reap", "spawn"]);
    expect(ledger.list()).toEqual([]);
    await supervisor.shutdown();
  });

  it("reaps sessions that do not confirm exit before host shutdown", async () => {
    const ledger = new InMemoryPtyHostCleanupLedger();
    const child = new FakeHostChild();
    const reapProcessTree = vi.fn(async () => undefined);
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: ledger,
      reapProcessTree,
      spawnHost: () => child,
    });
    await supervisor.start();
    const creating = supervisor.create(createRequest);
    child.emitMessage({
      contractVersion: 1,
      kind: "running",
      sessionId: UUID,
      hostGeneration: "1",
      rootPid: 123,
      processGroupId: "job-123",
      containment: "job-object",
    });
    await creating;

    await supervisor.shutdown();

    expect(reapProcessTree).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: UUID, hostGeneration: "1" }),
    );
    expect(ledger.list()).toEqual([]);
  });

  it("restarts after the replacement budget is exhausted", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
    });
    try {
      await supervisor.start();
      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(250);
      children[1]!.crash();
      await vi.advanceTimersByTimeAsync(250);
      expect(supervisor.health().state).toBe("unhealthy");

      await expect(supervisor.start()).resolves.toEqual({
        hostGeneration: "3",
        state: "healthy",
      });
      expect(children).toHaveLength(3);

      children[2]!.crash();
      await vi.advanceTimersByTimeAsync(250);
      await expect(supervisor.whenHealthy()).resolves.toEqual({
        hostGeneration: "4",
        state: "healthy",
      });
      expect(children).toHaveLength(4);
    } finally {
      await supervisor.shutdown().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("restarts after a host failure during startup", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      startupTimeoutMs: 100,
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        const child = new FakeHostChild();
        child.respondToHandshake = children.length > 0;
        children.push(child);
        return child;
      },
    });
    try {
      const starting = supervisor.start();
      const rejection = expect(starting).rejects.toThrow(
        "PTY host startup exceeded 100ms",
      );
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(supervisor.health().state).toBe("unhealthy");

      await expect(supervisor.start()).resolves.toEqual({
        hostGeneration: "2",
        state: "healthy",
      });
      expect(children).toHaveLength(2);
    } finally {
      await supervisor.shutdown().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("accepts a queued heartbeat after a delayed server watchdog timer", async () => {
    vi.useFakeTimers();
    const child = new FakeHostChild();
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      heartbeatDegradedMs: 750,
      heartbeatUnhealthyMs: 1_000,
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => child,
    });
    try {
      await supervisor.start();
      await vi.advanceTimersByTimeAsync(750);
      expect(supervisor.health().state).toBe("degraded");
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 1_000);
      await vi.advanceTimersByTimeAsync(250);
      clock.mockRestore();
      expect(supervisor.health().state).toBe("degraded");
      child.emitMessage({
        contractVersion: 1,
        kind: "heartbeat",
        hostGeneration: "1",
        monotonicMs: "2",
        activeSessions: 0,
        queueBytes: 0,
        rssBytes: "1",
      });
      expect(supervisor.health().state).toBe("healthy");
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      await supervisor.shutdown().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("accepts a ready host after a delayed server startup timer", async () => {
    vi.useFakeTimers();
    const child = new FakeHostChild();
    child.respondToHandshake = false;
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      startupTimeoutMs: 100,
      heartbeatDegradedMs: 2_000,
      heartbeatUnhealthyMs: 3_000,
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => child,
    });
    try {
      const starting = supervisor.start();
      await vi.advanceTimersByTimeAsync(0);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 1_000);
      await vi.advanceTimersByTimeAsync(100);
      clock.mockRestore();
      expect(supervisor.health().state).toBe("starting");
      child.emitMessage({
        contractVersion: 1,
        kind: "ready",
        hostGeneration: "1",
        platform: "windows",
        nativeAbi: "fake-v1",
        capabilities: { pty: "conpty", containment: "job-object", maxSessions: 20, protocolVersion: 1 },
      });
      child.emitMessage({
        contractVersion: 1,
        kind: "heartbeat",
        hostGeneration: "1",
        monotonicMs: "1",
        activeSessions: 0,
        queueBytes: 0,
        rssBytes: "1",
      });
      await expect(starting).resolves.toMatchObject({ state: "healthy" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      await supervisor.shutdown().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("does not double-spawn when a manual start races a pending replacement", async () => {
    vi.useFakeTimers();
    const children: FakeHostChild[] = [];
    const reapResolvers: Array<() => void> = [];
    const supervisor = new PtyHostSupervisor({
      platform: "windows",
      cleanupLedger: new InMemoryPtyHostCleanupLedger(),
      spawnHost: () => {
        const child = new FakeHostChild();
        children.push(child);
        return child;
      },
      reapProcessTree: vi.fn(
        () => new Promise<void>((resolve) => reapResolvers.push(resolve)),
      ),
    });
    try {
      await supervisor.start();
      // A running session leaves a durable record so the manual restart's reap
      // stays pending long enough for the replacement timer to fire.
      const creating = supervisor.create(createRequest);
      children[0]!.emitMessage({
        contractVersion: 1,
        kind: "running",
        sessionId: UUID,
        hostGeneration: "1",
        rootPid: 123,
        processGroupId: "job-123",
        containment: "job-object",
      });
      await creating;

      children[0]!.crash();
      // The deferred replacement fires first and parks inside its reap; the
      // manual start lands while that reap is still in flight.
      await vi.advanceTimersByTimeAsync(250);
      const manual = supervisor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(reapResolvers).toHaveLength(2);
      reapResolvers.forEach((resolve) => resolve());
      await vi.advanceTimersByTimeAsync(0);

      expect(children).toHaveLength(2);
      await expect(manual).resolves.toEqual({
        hostGeneration: "2",
        state: "healthy",
      });
    } finally {
      reapResolvers.forEach((resolve) => resolve());
      await supervisor.shutdown().catch(() => undefined);
      vi.useRealTimers();
    }
  });
});
