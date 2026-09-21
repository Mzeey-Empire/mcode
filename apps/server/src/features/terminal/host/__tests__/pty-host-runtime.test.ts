import { describe, expect, it, vi } from "vitest";
import type { IDisposable, IPty } from "node-pty";
import type { PtyHostEvent } from "../pty-host-protocol.js";
import {
  PtyHostProcessRuntime,
  type PtyProcessScope,
} from "../pty-host-runtime.js";

const SESSION_ID = "abcdef12-abcd-4abc-8abc-abcdefabcdef";
const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64" } as const;

class FakePty implements IPty {
  readonly pid = 123;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = "pwsh.exe";
  handleFlowControl = false;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener:
    ((event: { exitCode: number; signal?: number }) => void) | null = null;
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly clear = vi.fn();
  readonly kill = vi.fn();

  readonly onData = (listener: (data: string) => void): IDisposable => {
    this.dataListener = listener;
    return {
      dispose: () => {
        this.dataListener = null;
      },
    };
  };

  readonly onExit = (
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): IDisposable => {
    this.exitListener = listener;
    return {
      dispose: () => {
        this.exitListener = null;
      },
    };
  };

  emitData(data: string): void {
    this.dataListener?.(data);
  }

  emitExit(exitCode = 0): void {
    this.exitListener?.({ exitCode });
  }
}

function createScope(established = true): PtyProcessScope {
  return {
    mechanism: "job-object",
    processGroupId: "job-123",
    establish: vi.fn(async () => established),
    hasChildren: vi.fn(async () => false),
    close: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

describe("PtyHostProcessRuntime", () => {
  it("runs a contained PTY through create, I/O, resize, inspection, and close", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const scope = createScope();
    const events: PtyHostEvent[] = [];
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      hostRuntime: TEST_HOST_RUNTIME,
      nativeAbi: "fake-v1",
      publish: (event) => events.push(event),
      spawnPty: vi.fn(() => pty),
      createScope: vi.fn(() => scope),
    });

    await runtime.receive({
      contractVersion: 1,
      kind: "handshake",
      requestedGeneration: "7",
      platform: "windows",
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "create",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      scope: { kind: "workspace", workspaceId: SESSION_ID },
      executable: "pwsh.exe",
      arguments: [],
      cwd: "C:\\repo",
      cols: 80,
      rows: 24,
      env: [],
    });
    expect(events.map((event) => event.kind).slice(0, 3)).toEqual([
      "ready",
      "containment",
      "running",
    ]);

    await runtime.receive({
      contractVersion: 1,
      kind: "command.input",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "1",
      dataBase64: Buffer.from("echo ok\r").toString("base64"),
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "command.resize",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "2",
      cols: 100,
      rows: 30,
    });
    pty.emitData("ok\r\n");
    await vi.advanceTimersByTimeAsync(2);
    expect(pty.write).toHaveBeenCalledWith(Buffer.from("echo ok\r"));
    expect(pty.resize).toHaveBeenCalledWith(100, 30);
    expect(events.map((event) => event.kind)).toContain("output");

    await runtime.receive({
      contractVersion: 1,
      kind: "inspectChildren",
      sessionId: SESSION_ID,
      hostGeneration: "7",
    });
    expect(scope.hasChildren).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({
      contractVersion: 1,
      kind: "children",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      hasChildren: false,
    });

    const close = runtime.receive({
      contractVersion: 1,
      kind: "close",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      closeSeq: "3",
      reason: "user",
    });
    pty.emitExit();
    await close;
    expect(scope.close).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ kind: "exit", reason: "user-close" });
    await runtime.dispose();
    vi.useRealTimers();
  });

  it("uses the host graceful close path for app shutdown", async () => {
    const pty = new FakePty();
    const scope = createScope();
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      hostRuntime: TEST_HOST_RUNTIME,
      nativeAbi: "fake-v1",
      publish: () => undefined,
      spawnPty: () => pty,
      createScope: () => scope,
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "handshake",
      requestedGeneration: "7",
      platform: "windows",
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "create",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      scope: { kind: "workspace", workspaceId: SESSION_ID },
      executable: "pwsh.exe",
      arguments: [],
      cwd: "C:\\repo",
      cols: 80,
      rows: 24,
      env: [],
    });

    const close = runtime.receive({
      contractVersion: 1,
      kind: "close",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      closeSeq: "1",
      reason: "app-shutdown",
    });
    pty.emitExit();
    await close;

    expect(scope.close).toHaveBeenCalledWith(true);
    await runtime.dispose();
  });

  it("uses the graceful close path while the host shuts down", async () => {
    const pty = new FakePty();
    const scope = createScope();
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      hostRuntime: TEST_HOST_RUNTIME,
      nativeAbi: "fake-v1",
      publish: () => undefined,
      spawnPty: () => pty,
      createScope: () => scope,
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "handshake",
      requestedGeneration: "7",
      platform: "windows",
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "create",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      scope: { kind: "workspace", workspaceId: SESSION_ID },
      executable: "pwsh.exe",
      arguments: [],
      cwd: "C:\\repo",
      cols: 80,
      rows: 24,
      env: [],
    });

    const shutdown = runtime.receive({
      contractVersion: 1,
      kind: "shutdown",
      hostGeneration: "7",
      reason: "app-shutdown",
    });
    pty.emitExit();
    await shutdown;

    expect(scope.close).toHaveBeenCalledWith(true);
  });

  it("fails closed when authoritative containment cannot be established", async () => {
    const pty = new FakePty();
    const scope = createScope(false);
    const events: PtyHostEvent[] = [];
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      hostRuntime: TEST_HOST_RUNTIME,
      nativeAbi: "fake-v1",
      publish: (event) => events.push(event),
      spawnPty: () => pty,
      createScope: () => scope,
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "handshake",
      requestedGeneration: "7",
      platform: "windows",
    });

    await runtime.receive({
      contractVersion: 1,
      kind: "create",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      scope: { kind: "workspace", workspaceId: SESSION_ID },
      executable: "pwsh.exe",
      arguments: [],
      cwd: "C:\\repo",
      cols: 80,
      rows: 24,
      env: [],
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "containment",
        established: false,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "failure",
        boundary: "containment",
        code: "CONTAINMENT_FAILED",
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: "running" }),
    );
    expect(scope.close).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  const createRunningSession = async (
    pty: FakePty,
    events: PtyHostEvent[],
    queueBytes?: () => number,
  ): Promise<PtyHostProcessRuntime> => {
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      hostRuntime: TEST_HOST_RUNTIME,
      nativeAbi: "fake-v1",
      publish: (event) => events.push(event),
      queueBytes,
      spawnPty: vi.fn(() => pty),
      createScope: vi.fn(() => createScope()),
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "handshake",
      requestedGeneration: "7",
      platform: "windows",
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "create",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      scope: { kind: "workspace", workspaceId: SESSION_ID },
      executable: "pwsh.exe",
      arguments: [],
      cwd: "C:\\repo",
      cols: 80,
      rows: 24,
      env: [],
    });
    events.length = 0;
    return runtime;
  };

  const outputEvents = (events: readonly PtyHostEvent[]) =>
    events.filter((event): event is Extract<PtyHostEvent, { kind: "output" }> => event.kind === "output");

  it("coalesces a synchronous output burst into one event", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const events: PtyHostEvent[] = [];
    const runtime = await createRunningSession(pty, events);

    pty.emitData("a");
    pty.emitData("b");
    pty.emitData("c");
    await vi.advanceTimersByTimeAsync(2);

    const outputs = outputEvents(events);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.outputSeq).toBe("1");
    expect(Buffer.from(outputs[0]!.dataBase64, "base64").toString()).toBe("abc");
    await runtime.dispose();
    vi.useRealTimers();
  });

  it("flushes a full-sized chunk without waiting for the batch window", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const events: PtyHostEvent[] = [];
    const runtime = await createRunningSession(pty, events);

    pty.emitData("x".repeat(65_536 + 10));

    const outputs = outputEvents(events);
    expect(outputs).toHaveLength(2);
    expect(Buffer.from(outputs[0]!.dataBase64, "base64").length).toBe(65_536);
    expect(Buffer.from(outputs[1]!.dataBase64, "base64").length).toBe(10);
    await runtime.dispose();
    vi.useRealTimers();
  });

  it("pauses a flooding PTY while IPC is saturated and resumes after drain", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const events: PtyHostEvent[] = [];
    let queued = 800 * 1024;
    const runtime = await createRunningSession(pty, events, () => queued);

    pty.emitData("flood");
    await vi.advanceTimersByTimeAsync(4);
    // One pause at spawn, one from backpressure.
    expect(pty.pause).toHaveBeenCalledTimes(2);
    expect(outputEvents(events)).toHaveLength(0);

    queued = 0;
    await vi.advanceTimersByTimeAsync(4);
    expect(pty.resume).toHaveBeenCalled();
    const outputs = outputEvents(events);
    expect(outputs).toHaveLength(1);
    expect(Buffer.from(outputs[0]!.dataBase64, "base64").toString()).toBe("flood");
    await runtime.dispose();
    vi.useRealTimers();
  });

  it("flushes pending output before the exit event", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const events: PtyHostEvent[] = [];
    const runtime = await createRunningSession(pty, events);

    pty.emitData("tail");
    pty.emitExit(3);

    const outputs = outputEvents(events);
    expect(outputs).toHaveLength(1);
    const exit = events.at(-1);
    expect(exit).toMatchObject({ kind: "exit", code: 3, finalOutputSeq: "1" });
    await runtime.dispose();
    vi.useRealTimers();
  });

  it("kills a session whose pending output exceeds the per-session bound", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const events: PtyHostEvent[] = [];
    const runtime = await createRunningSession(pty, events, () => 900 * 1024);

    pty.emitData("x".repeat(64 * 1024 * 1024 + 1));
    expect(pty.kill).toHaveBeenCalledOnce();
    await runtime.dispose();
    vi.useRealTimers();
  });

  it("keeps a paused session paused inside the hysteresis band", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const events: PtyHostEvent[] = [];
    let queued = 800 * 1024;
    const runtime = await createRunningSession(pty, events, () => queued);

    pty.emitData("flood");
    await vi.advanceTimersByTimeAsync(4);
    expect(pty.pause).toHaveBeenCalledTimes(2);

    queued = 600 * 1024;
    await vi.advanceTimersByTimeAsync(6);
    expect(pty.resume).toHaveBeenCalledTimes(1);
    expect(outputEvents(events)).toHaveLength(0);

    queued = 400 * 1024;
    await vi.advanceTimersByTimeAsync(4);
    expect(outputEvents(events)).toHaveLength(1);
    await runtime.dispose();
    vi.useRealTimers();
  });

  it("defers the exit event behind pending output while pressured, then publishes in order", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const events: PtyHostEvent[] = [];
    let queued = 800 * 1024;
    const runtime = await createRunningSession(pty, events, () => queued);

    pty.emitData("tail");
    pty.emitExit(3);
    await vi.advanceTimersByTimeAsync(4);
    expect(events.map((event) => event.kind)).not.toContain("exit");

    queued = 0;
    await vi.advanceTimersByTimeAsync(4);
    expect(events.map((event) => event.kind)).toEqual(["output", "exit"]);
    expect(events.at(-1)).toMatchObject({ kind: "exit", finalOutputSeq: "1" });
    await runtime.dispose();
    vi.useRealTimers();
  });

  it("publishes a pressured exit by deadline when IPC never drains", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const events: PtyHostEvent[] = [];
    const runtime = await createRunningSession(pty, events, () => 900 * 1024);

    pty.emitData("dropped");
    pty.emitExit(0);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(events.at(-1)).toMatchObject({ kind: "exit", finalOutputSeq: "0" });
    await runtime.dispose();
    vi.useRealTimers();
  });
});
