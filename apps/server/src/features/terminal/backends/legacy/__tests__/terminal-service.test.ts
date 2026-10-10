import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type {
  PtyHostAdapter,
  PtyHostClose,
  PtyHostCommand,
  PtyHostCreate,
  PtyHostDiagnostics,
  PtyHostHealth,
  PtyHostRunning,
} from "../../../host/pty-host-adapter.js";
import {
  PtyHostEventSchema,
  type PtyHostEvent,
} from "../../../host/pty-host-protocol.js";
import { InMemoryPtyHostAdapter } from "../../../testing/in-memory-pty-host-adapter.js";
import { TerminalService } from "../terminal-service.js";

class FakeHost implements PtyHostAdapter {
  readonly creates: PtyHostCreate[] = [];
  readonly commands: PtyHostCommand[] = [];
  readonly closes: PtyHostClose[] = [];
  closeError: Error | undefined;
  shutdownError: Error | undefined;
  startError: Error | undefined;
  closeGate: Promise<void> | undefined;
  sendGate: Promise<void> | undefined;
  onCreate: ((input: PtyHostCreate) => void) | undefined;
  readonly shutdown = vi.fn(async () => {
    if (this.shutdownError) throw this.shutdownError;
  });
  private listener: (event: PtyHostEvent) => void = () => undefined;

  async start(): Promise<PtyHostHealth> {
    if (this.startError) throw this.startError;
    return { hostGeneration: "1", state: "healthy" };
  }

  async create(input: PtyHostCreate): Promise<PtyHostRunning> {
    this.creates.push(input);
    this.onCreate?.(input);
    return {
      sessionId: input.sessionId,
      hostGeneration: "1",
      state: "running",
      containment: "job-object",
    };
  }

  async send(command: PtyHostCommand): Promise<void> {
    this.commands.push(command);
    await this.sendGate;
  }

  async inspectChildren(): Promise<{ hasChildren: boolean }> {
    return { hasChildren: false };
  }

  async close(input: PtyHostClose): Promise<void> {
    this.closes.push(input);
    await this.closeGate;
    if (this.closeError) throw this.closeError;
  }

  subscribe(listener: (event: PtyHostEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = () => undefined;
    };
  }

  diagnostics(): PtyHostDiagnostics {
    return {
      lastHeartbeatMsAgo: 0,
      queueBytes: 0,
      eventLoopLagMs: 0,
      hostRssBytes: "0",
    };
  }

  emit(event: unknown): void {
    this.listener(PtyHostEventSchema().parse(event));
  }
}

function createService(options: {
  readonly environment?: Record<string, string>;
  readonly sessionLimit?: number;
  readonly host?: PtyHostAdapter;
} = {}) {
  const environment = options.environment ?? { PATH: process.env.PATH ?? "" };
  const host = new FakeHost();
  const settings = {
    get: () => ({
      terminal: {
        behavior: { scrollback: 1_000, sessionLimit: options.sessionLimit ?? 20 },
        flowControl: { serverHighBytes: 1_024, serverLowBytes: 512 },
      },
    }),
    on: () => () => undefined,
  };
  const service = new TerminalService(
    {
      findById: (id: string) => id.startsWith("thread")
        ? { id, workspace_id: "workspace", mode: "direct", worktree_path: null }
        : null,
    } as never,
    { findById: () => ({ path: process.cwd() }) } as never,
    { resolveWorkingDir: () => process.cwd() } as never,
    settings as never,
    { getEnv: () => environment } as never,
    options.host ?? host,
  );
  const launch: Parameters<TerminalService["create"]>[1] = {
    executable: "pwsh.exe",
    arguments: [],
    requestedProfileId: "automatic",
    resolvedProfile: {
      id: "certified:windows-powershell-7",
      name: "PowerShell 7",
      executable: "pwsh.exe",
      arguments: [],
      source: "certified",
      platform: "windows",
    },
  };
  return { host, service, launch };
}

function output(sessionId: string, text: string, outputSeq = "1") {
  return {
    contractVersion: 1,
    kind: "output" as const,
    sessionId,
    hostGeneration: "1",
    outputSeq,
    dataBase64: Buffer.from(text).toString("base64"),
  };
}

function exit(sessionId: string, code = 0) {
  return {
    contractVersion: 1,
    kind: "exit" as const,
    sessionId,
    hostGeneration: "1",
    finalOutputSeq: "1",
    code,
    signal: null,
    reason: "natural" as const,
  };
}

describe("TerminalService host ownership", () => {
  it("counts host-start reservations and cancels them when their scope is torn down", async () => {
    const host = new InMemoryPtyHostAdapter("1");
    const start = host.start.bind(host);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(host, "start").mockImplementation(async () => { await gate; return start(); });
    const { service, launch } = createService({ host });
    const scope = "00000000-0000-4000-8000-000000000001";
    const creates = Array.from({ length: 8 }, () => service.create(scope, launch));
    const settled = Promise.allSettled(creates);
    await expect(service.create(scope, launch)).rejects.toThrow(/Maximum PTY limit/);
    await service.killByThread(scope);
    release();
    expect((await settled).map((result) => result.status)).toEqual([
      "rejected", "rejected", "rejected", "rejected", "rejected", "rejected", "rejected", "rejected",
    ]);
    expect(service.listActiveSessions()).toEqual([]);
    const replacement = await service.create(scope, launch);
    expect(service.listActiveSessions().map(({ ptyId }) => ptyId)).toEqual([replacement.ptyId]);
    await service.shutdown();
  });

  it("lists literal metadata and replays a naturally exited shell until close", async () => {
    const host = new InMemoryPtyHostAdapter("1");
    const { service, launch } = createService({ host });
    const data = vi.fn();
    service.setSender({ data, json: vi.fn() });
    const scope = "00000000-0000-4000-8000-000000000001";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    try {
      const created = await service.create(scope, launch);
      expect(created).toEqual({
        ptyId: created.ptyId, threadId: scope, shell: "pwsh", cwd: process.cwd(),
        kind: "shell", state: "running", exitCode: null, createdAt: "2026-10-08T12:00:00.000Z",
      });
      host.emitOutput(created.ptyId, new TextEncoder().encode("retained output\r\n"));
      host.emitExit(created.ptyId, 7);
      expect(service.listActiveSessions()).toEqual([{
        ptyId: created.ptyId, threadId: scope, shell: "pwsh", cwd: process.cwd(),
        kind: "shell", state: "exited", exitCode: 7, createdAt: "2026-10-08T12:00:00.000Z",
      }]);
      expect(() => service.write(created.ptyId, "echo bad")).toThrow(/PTY not found/);
      expect(() => service.resize(created.ptyId, 100, 30)).toThrow(/PTY not found/);
      await expect(service.hasChildren(created.ptyId)).resolves.toEqual({ hasChildren: false });
      data.mockClear();
      expect(service.reattach(created.ptyId, -1, true)).toEqual({ mode: "delta" });
      expect(data.mock.calls).toEqual([[created.ptyId, 1, Buffer.from("retained output\r\n")]]);
      await service.kill(created.ptyId);
      expect(service.listActiveSessions()).toEqual([]);
      expect(() => service.reattach(created.ptyId, -1, true)).toThrow(/PTY not found/);
    } finally {
      vi.useRealTimers();
      await service.shutdown();
    }
  });

  it("keeps a retried first shell before the second shell in the server listing", async () => {
    const host = new InMemoryPtyHostAdapter("1");
    const { service, launch } = createService({ host });
    const scope = "00000000-0000-4000-8000-000000000001";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
      const first = await service.create(scope, launch);
      vi.setSystemTime(new Date("2026-10-08T12:01:00.000Z"));
      const second = await service.create(scope, launch);
      host.emitExit(first.ptyId, 7);
      vi.setSystemTime(new Date("2026-10-08T12:02:00.000Z"));
      const replacement = await service.create(scope, launch, first.ptyId);
      expect(replacement.createdAt).toBe("2026-10-08T12:00:00.000Z");
      expect(service.listActiveSessions()).toEqual([
        {
          ptyId: replacement.ptyId, threadId: scope, shell: "pwsh", cwd: process.cwd(),
          kind: "shell", state: "running", exitCode: null, createdAt: "2026-10-08T12:00:00.000Z",
        },
        {
          ptyId: second.ptyId, threadId: scope, shell: "pwsh", cwd: process.cwd(),
          kind: "shell", state: "running", exitCode: null, createdAt: "2026-10-08T12:01:00.000Z",
        },
      ]);
      expect(() => service.reattach(first.ptyId, -1)).toThrow(/PTY not found/);
      await service.kill(first.ptyId);
      expect(service.listActiveSessions().map(({ ptyId }) => ptyId)).toEqual([replacement.ptyId, second.ptyId]);
    } finally {
      vi.useRealTimers();
      await service.shutdown();
    }
  });

  it("replaces an exited shell when all eight scope slots are occupied", async () => {
    const host = new InMemoryPtyHostAdapter("1");
    const { service, launch } = createService({ host });
    const scope = "00000000-0000-4000-8000-000000000001";
    try {
      const first = await service.create(scope, launch);
      await Promise.all(Array.from({ length: 7 }, () => service.create(scope, launch)));
      host.emitExit(first.ptyId, 0);
      const replacement = await service.create(scope, launch, first.ptyId);
      expect(service.listActiveSessions().map(({ state }) => state)).toEqual([
        "running", "running", "running", "running", "running", "running", "running", "running",
      ]);
      expect(service.listActiveSessions().map(({ ptyId }) => ptyId)).toContain(replacement.ptyId);
      expect(() => service.reattach(first.ptyId, -1)).toThrow(/PTY not found/);
      await expect(service.create(scope, launch)).rejects.toThrow(/Maximum PTY limit/);
    } finally {
      await service.shutdown();
    }
  });

  it("ignores a running shell as a replacement without killing it", async () => {
    const host = new InMemoryPtyHostAdapter("1");
    const { service, launch } = createService({ host });
    const scope = "00000000-0000-4000-8000-000000000001";
    try {
      const first = await service.create(scope, launch);
      const second = await service.create(scope, launch, first.ptyId);
      expect(service.listActiveSessions().map(({ ptyId, state }) => [ptyId, state])).toEqual([
        [first.ptyId, "running"], [second.ptyId, "running"],
      ]);
      await service.write(first.ptyId, "echo still running\r");
      await expect(service.hasChildren(first.ptyId)).resolves.toEqual({ hasChildren: false });
    } finally {
      await service.shutdown();
    }
  });

  it.each(["other scope", "unknown"])("ignores an %s replacement id", async (kind) => {
    const host = new InMemoryPtyHostAdapter("1");
    const { service, launch } = createService({ host });
    const scope = "00000000-0000-4000-8000-000000000001";
    const otherScope = "00000000-0000-4000-8000-000000000002";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
      const first = await service.create(otherScope, launch);
      host.emitExit(first.ptyId, 7);
      vi.setSystemTime(new Date("2026-10-08T12:01:00.000Z"));
      const second = await service.create(scope, launch, kind === "other scope" ? first.ptyId : "unknown");
      expect(second.createdAt).toBe("2026-10-08T12:01:00.000Z");
      expect(service.listActiveSessions().map(({ ptyId, state, exitCode }) => [ptyId, state, exitCode])).toEqual([
        [first.ptyId, "exited", 7], [second.ptyId, "running", null],
      ]);
    } finally {
      vi.useRealTimers();
      await service.shutdown();
    }
  });

  it("counts exited shells toward eight records, and close frees a slot", async () => {
    const host = new InMemoryPtyHostAdapter("1");
    const { service, launch } = createService({ host });
    const scope = "00000000-0000-4000-8000-000000000001";
    try {
      const first = await service.create(scope, launch);
      host.emitExit(first.ptyId, 0);
      await Promise.all(Array.from({ length: 7 }, () => service.create(scope, launch)));
      expect(service.listActiveSessions().map(({ kind, state }) => [kind, state])).toEqual([
        ["shell", "exited"], ["shell", "running"],
        ["shell", "running"], ["shell", "running"], ["shell", "running"],
        ["shell", "running"], ["shell", "running"], ["shell", "running"],
      ]);
      await expect(service.create(scope, launch)).rejects.toThrow(/Maximum PTY limit/);
      await service.kill(first.ptyId);
      const replacement = await service.create(scope, launch);
      expect(service.listActiveSessions()).toHaveLength(8);
      expect(service.listActiveSessions().at(-1)?.ptyId).toBe(replacement.ptyId);
      await service.killByThread(scope);
      expect(service.listActiveSessions()).toEqual([]);
      expect(() => service.reattach(replacement.ptyId, -1)).toThrow(/PTY not found/);
    } finally {
      await service.shutdown();
    }
  });

  it("retains and replays output through the legacy sender", async () => {
    const { service, host, launch } = createService();
    const data = vi.fn();
    service.setSender({ data, json: vi.fn() });

    const created = await service.create("thread", launch);
    service.resume(created.ptyId);
    host.emit(output(created.ptyId, "one"));

    expect(service.reattach(created.ptyId, 0)).toEqual({ mode: "delta" });
    expect(data).toHaveBeenCalledWith(created.ptyId, 1, expect.any(Uint8Array));
  });

  it("returns a checkpoint before replaying the retained delta", async () => {
    const { service, host, launch } = createService();
    const data = vi.fn();
    service.setSender({ data, json: vi.fn() });

    const created = await service.create("thread", launch);
    service.resume(created.ptyId);
    host.emit(output(created.ptyId, "one", "1"));
    expect(service.checkpoint(created.ptyId, 1, "screen").accepted).toBe(true);
    host.emit(output(created.ptyId, "two", "2"));

    expect(service.reattach(created.ptyId, -1, true)).toEqual({
      mode: "checkpoint",
      checkpoint: "screen",
      checkpointThrough: 1,
    });
    expect(data).toHaveBeenCalledWith(created.ptyId, 2, expect.any(Uint8Array));
  });

  it("enforces the per-scope session limit while creates are active", async () => {
    const { service, launch } = createService();
    await Promise.all(Array.from({ length: 8 }, () => service.create("thread", launch)));

    await expect(service.create("thread", launch)).rejects.toThrow(
      "Maximum PTY limit (8)",
    );
  });

  it("applies the app-wide action capacity across threads", async () => {
    const { service, launch } = createService({ sessionLimit: 1 });
    await openAction(service, launch, "thread");

    await expect(openAction(service, launch, "thread-two")).rejects.toThrow(
      "app-wide Terminal session limit",
    );
  });

  it("allows shells above the app-wide limit while each scope is below eight", async () => {
    const host = new InMemoryPtyHostAdapter("1");
    const { service, launch } = createService({ host, sessionLimit: 1 });
    const firstScope = "00000000-0000-4000-8000-000000000001";
    const secondScope = "00000000-0000-4000-8000-000000000002";
    try {
      const first = await service.create(firstScope, launch);
      host.emitExit(first.ptyId, 0);
      const second = await service.create(secondScope, launch);
      const third = await service.create(secondScope, launch);
      expect(service.listActiveSessions().map(({ ptyId }) => ptyId)).toEqual([
        first.ptyId, second.ptyId, third.ptyId,
      ]);
    } finally {
      await service.shutdown();
    }
  });

  it("releases a failed host-start reservation without creating a session", async () => {
    const { service, host, launch } = createService();
    host.startError = new Error("host unavailable");

    await expect(service.create("thread", launch)).rejects.toThrow(Error);
    expect(service.listActiveSessions()).toEqual([]);
    expect(host.creates).toEqual([]);
  });

  it("uses one bounded environment snapshot for the host launch", async () => {
    const { service, host, launch } = createService({
      environment: { PATH: "safe", HOME: "home", "ProgramFiles(x86)": "windows" },
    });

    await service.create("thread", launch);

    expect(host.creates[0]?.protectedEnv).toEqual([
      { name: "HOME", value: "home" },
      { name: "PATH", value: "safe" },
    ]);
  });

  it("rejects an environment beyond the host boundary before creating", async () => {
    const { service, host, launch } = createService({
      environment: Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`V${index}`, "x"]),
      ),
    });

    await expect(service.create("thread", launch)).rejects.toThrow(
      "environment exceeds",
    );
    expect(host.creates).toHaveLength(0);
  });

  it("serializes input before resize with host command sequences", async () => {
    const { service, host, launch } = createService();
    const created = await service.create("thread", launch);

    await Promise.all([
      service.write(created.ptyId, "input"),
      service.resize(created.ptyId, 120, 30),
    ]);

    expect(host.commands.map(({ kind, commandSeq }) => [kind, commandSeq])).toEqual([
      ["input", "1"],
      ["resize", "2"],
    ]);
  });

  it("closes after accepted commands and rejects commands admitted after close", async () => {
    const { service, host, launch } = createService();
    const created = await service.create("thread", launch);
    let releaseSend!: () => void;
    host.sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });

    const input = service.write(created.ptyId, "input");
    await Promise.resolve();
    const close = service.kill(created.ptyId);

    expect(() => service.write(created.ptyId, "late")).toThrow(Error);
    expect(() => service.resize(created.ptyId, 120, 30)).toThrow(Error);
    expect(host.closes).toHaveLength(0);

    releaseSend();
    await Promise.all([input, close]);

    expect(host.commands).toMatchObject([{ kind: "input", commandSeq: "1" }]);
    expect(host.closes).toMatchObject([{ closeSeq: "2" }]);
  });

  it("shares one host close attempt across concurrent close requests", async () => {
    const { service, host, launch } = createService();
    const created = await service.create("thread", launch);
    let releaseClose!: () => void;
    host.closeGate = new Promise((resolve) => {
      releaseClose = resolve;
    });

    const first = service.kill(created.ptyId);
    const second = service.kill(created.ptyId);
    await vi.waitFor(() => expect(host.closes).toHaveLength(1));

    releaseClose();
    await Promise.all([first, second]);
    expect(service.listActiveSessions()).toEqual([]);
  });

  it("keeps a session when host close rejects", async () => {
    const { service, host, launch } = createService();
    const created = await service.create("thread", launch);
    host.closeError = new Error("close failed");

    await expect(service.kill(created.ptyId)).rejects.toThrow(Error);
    expect(service.listActiveSessions()).toEqual([
      { ...created, threadId: "thread" },
    ]);
  });

  it("publishes one natural exit when a close rejection races it", async () => {
    const { service, host, launch } = createService();
    const json = vi.fn();
    service.setSender({ data: vi.fn(), json });
    const created = await service.create("thread", launch);
    host.closeError = new Error("close failed");

    await expect(service.kill(created.ptyId)).rejects.toThrow(Error);
    host.emit(exit(created.ptyId, 11));
    host.emit(exit(created.ptyId, 11));

    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith("terminal.exit", {
      ptyId: created.ptyId,
      code: 11,
    });
    expect(service.listActiveSessions()).toEqual([{ ...created, threadId: "thread", state: "exited", exitCode: 11 }]);
  });

  it("publishes a nonzero exit when the host generation fails", async () => {
    const { service, host, launch } = createService();
    const json = vi.fn();
    service.setSender({ data: vi.fn(), json });
    const created = await service.create("thread", launch);

    host.emit({
      contractVersion: 1,
      kind: "failure",
      hostGeneration: "1",
      boundary: "command",
      recoverable: false,
      code: "HOST_UNHEALTHY",
    });

    expect(json).toHaveBeenCalledWith("terminal.exit", {
      ptyId: created.ptyId,
      code: 1,
    });
    expect(service.listActiveSessions()).toEqual([{ ...created, threadId: "thread", state: "exited", exitCode: 1 }]);
  });

  it("notifies connected clients when a terminal is killed", async () => {
    const { service, launch } = createService();
    const json = vi.fn();
    service.setSender({ data: vi.fn(), json });
    const created = await service.create("thread", launch);
    await service.kill(created.ptyId);
    expect(json.mock.calls).toEqual([["terminal.exit", { ptyId: created.ptyId, code: 0, exitCode: null }]]);
    expect(service.listActiveSessions()).toEqual([]);
    await service.shutdown();
  });

  it.each(["start", "create"] as const)("publishes a failed rerun exit and flushes paused output when host %s fails", async (method) => {
    const host = new InMemoryPtyHostAdapter("1");
    const create = vi.spyOn(host, "create");
    const { service, launch } = createService({ host });
    const json = vi.fn();
    const data = vi.fn();
    service.setSender({ data, json });
    const action = await openAction(service, launch, "00000000-0000-4000-8000-000000000001");
    host.emitExit(create.mock.calls[0][0].sessionId, 0);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    if (method === "start") vi.spyOn(host, "start").mockRejectedValueOnce(new Error("host unavailable"));
    else create.mockRejectedValueOnce(new Error("host unavailable"));
    await expect(action.run({ script: "echo rerun" })).rejects.toThrow("host unavailable");
    expect(json.mock.calls).toEqual([["terminal.exit", { ptyId: action.terminalSessionId, code: 0, exitCode: null }]]);
    expect(Buffer.concat(data.mock.calls.map(([, , bytes]) => bytes)).toString()).toContain("echo rerun");
    expect(service.listActiveSessions()).toEqual([expect.objectContaining({
      ptyId: action.terminalSessionId, state: "exited", exitCode: null,
    })]);
    await service.shutdown();
  });

  it("counts action records toward the cap and closes them during thread teardown", async () => {
    const host = new InMemoryPtyHostAdapter("1");
    const { service, launch } = createService({ host });
    const scope = "00000000-0000-4000-8000-000000000001";
    const action = await openAction(service, launch, scope);
    const closed = vi.fn();
    const exits: Array<number | null> = [];
    action.onClosed(closed);
    action.onCommandExit(({ exitCode }) => exits.push(exitCode));
    await Promise.all(Array.from({ length: 7 }, () => service.create(scope, launch)));
    expect(service.listActiveSessions()).toHaveLength(8);
    await expect(service.create(scope, launch)).rejects.toThrow(/Maximum PTY limit/);
    await service.killByThread(scope);
    expect(service.listActiveSessions()).toEqual([expect.objectContaining({ ptyId: action.terminalSessionId, state: "running" })]);
    expect(exits).toEqual([]);
    expect(closed).not.toHaveBeenCalled();
    await service.killByThread(scope, true);
    expect(service.listActiveSessions()).toEqual([]);
    expect(exits).toEqual([130]);
    expect(closed).toHaveBeenCalledOnce();
    await service.shutdown();
  });

  it("hands off to a new host session while retaining metadata, echo, output and monotonic replay", async () => {
    const host = new InMemoryPtyHostAdapter("1");
    const create = vi.spyOn(host, "create");
    const { service, launch } = createService({ host });
    const data = vi.fn();
    const json = vi.fn();
    service.setSender({ data, json });
    const scope = "00000000-0000-4000-8000-000000000001";
    const action = await openAction(service, launch, scope, "vite --open http://localhost:5173/\nnext");
    const commandId = create.mock.calls[0][0].sessionId;
    expect(commandId).not.toBe(action.terminalSessionId);
    expect(service.listActiveSessions()).toEqual([{
      ptyId: action.terminalSessionId, threadId: scope, shell: "pwsh", cwd: process.cwd(),
      kind: "action", actionId: "build", state: "running", exitCode: null,
      createdAt: expect.any(String),
    }]);
    host.emitOutput(commandId, Buffer.from("command output\r\n"));
    host.emitExit(commandId, 2);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const shellId = create.mock.calls[1][0].sessionId;
    expect(shellId).not.toBe(commandId);
    expect(create.mock.calls[1][0].launch.arguments).toEqual([]);
    expect(create.mock.calls[1][0].cwd).toBe(process.cwd());
    host.emitOutput(shellId, Buffer.from("PS> "));
    const output: Uint8Array[] = [];
    const exits: Array<number | null> = [];
    action.onCommandOutput((bytes) => output.push(bytes));
    action.onCommandExit(({ exitCode }) => exits.push(exitCode));
    expect(Buffer.concat(output).toString()).toBe("command output\r\n");
    expect(exits).toEqual([2]);
    expect(data.mock.calls).toEqual([]);
    expect(service.reattach(action.terminalSessionId, -1)).toEqual({ mode: "delta" });
    expect(data.mock.calls.map((call) => call[1])).toEqual([1, 2, 3]);
    expect(Buffer.concat(data.mock.calls.map((call) => call[2])).toString()).toBe(
      `\u001b[90mPS ${process.cwd()}> \u001b[39mvite --open http://localhost:5173/\r\n  next\u001b[0m\r\ncommand output\r\nPS> `,
    );
    expect(json.mock.calls).toEqual([]);
    host.emitExit(shellId, 0);
    expect(service.listActiveSessions()[0]).toMatchObject({ state: "exited", exitCode: 0, kind: "action", actionId: "build" });
    await service.shutdown();
  });

  it("retains a synchronous command exit until its owner attaches", async () => {
    const { service, host, launch } = createService();
    host.onCreate = (input) => {
      if (!input.launch.arguments.includes("-Command")) return;
      host.emit(output(input.sessionId, "complete"));
      host.emit(exit(input.sessionId));
    };
    const action = await openAction(service, launch, "thread");
    const received: Uint8Array[] = [];
    const exits: Array<number | null> = [];
    action.onCommandOutput((data) => received.push(data));
    action.onCommandExit(({ exitCode }) => exits.push(exitCode));
    expect(Buffer.concat(received).toString()).toBe("complete");
    expect(exits).toEqual([0]);
    await vi.waitFor(() => expect(host.creates).toHaveLength(2));
    expect(service.listActiveSessions()[0].state).toBe("running");
    await service.shutdown();
  });

  it("continues shell hand-off when an Action exit listener throws", async () => {
    const { service, host, launch } = createService();
    const action = await openAction(service, launch, "thread");
    action.onCommandExit(() => { throw new Error("persistence failed"); });
    expect(() => host.emit(exit(host.creates[0].sessionId))).not.toThrow();
    await vi.waitFor(() => expect(host.creates).toHaveLength(2));
    expect(service.listActiveSessions()[0].state).toBe("running");
    await service.shutdown();
  });

  it("still opens the shell on natural exit after a rerun fails to stop its command", async () => {
    const { service, host, launch } = createService();
    const action = await openAction(service, launch, "thread");
    host.closeError = new Error("close failed");
    vi.useFakeTimers();
    try {
      const rerun = expect(action.run({ script: "again" })).rejects.toThrow("close failed");
      await vi.advanceTimersByTimeAsync(5000);
      await rerun;
      host.emit(exit(host.creates[0].sessionId, 0));
      await vi.advanceTimersByTimeAsync(0);
      expect(host.creates).toHaveLength(2);
      expect(host.creates[1].launch.arguments).toEqual([]);
      expect(service.listActiveSessions()[0].state).toBe("running");
    } finally {
      vi.useRealTimers();
      await service.shutdown();
    }
  });

  it.each([
    { shell: "cmd.exe", prompt: `${process.cwd()}> ` },
    { shell: "/bin/bash", prompt: "$ " },
  ])("echoes a multiline command with the $shell prompt", async ({ shell, prompt }) => {
    const { service, launch } = createService();
    const chunks: Uint8Array[] = [];
    service.setSender({ data: (_id, _seq, bytes) => chunks.push(bytes), json: () => undefined });
    const action = await openAction(service, {
      ...launch, executable: shell, resolvedProfile: { ...launch.resolvedProfile, executable: shell },
    }, "thread", "first\nsecond");
    service.reattach(action.terminalSessionId, -1);
    expect(Buffer.concat(chunks).toString()).toBe(`\u001b[90m${prompt}\u001b[39mfirst\r\n  second\u001b[0m\r\n`);
    await service.shutdown();
  });

  it("uses graceful host close only after app shutdown enables it", async () => {
    const { service, host, launch } = createService();
    const first = await service.create("thread", launch);
    service.setGracefulKill(true);

    await service.kill(first.ptyId, "app-shutdown");
    const second = await service.create("thread", launch);
    await service.kill(second.ptyId);

    expect(host.closes.map(({ reason }) => reason)).toEqual([
      "app-shutdown",
      "user",
    ]);
  });

  it("retains sessions until bulk host shutdown completes", async () => {
    const { service, host, launch } = createService();
    await service.create("thread", launch);
    await service.create("thread", launch);
    let finish!: () => void;
    host.shutdown.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));

    const shutdown = service.shutdown();
    await vi.waitFor(() => expect(host.shutdown).toHaveBeenCalledOnce());
    expect(host.closes).toEqual([]);
    expect(service.listActiveSessions()).toHaveLength(2);
    finish();
    await shutdown;
    expect(service.listActiveSessions()).toEqual([]);
  });

  it("retains sessions when bulk host shutdown fails", async () => {
    const { service, host, launch } = createService();
    const created = await service.create("thread", launch);
    host.shutdown.mockRejectedValue(new Error("host shutdown failed"));

    await expect(service.shutdown()).rejects.toThrow("host shutdown failed");

    expect(host.shutdown).toHaveBeenCalledOnce();
    expect(service.listActiveSessions()).toEqual([
      { ...created, threadId: "thread" },
    ]);
  });
});

function openAction(
  service: TerminalService, launch: Parameters<TerminalService["create"]>[1], threadId: string,
  script = "bun run build",
) {
  return service.openActionTerminal(
    { threadId, actionId: "build", launch: { script } }, launch,
    async (input, cwd) => ({
      launch: { ...launch, arguments: ["-Command", input.script] },
      snapshot: {
        platform: "windows", script: input.script, checkoutPath: cwd,
        terminal: { executable: launch.executable, arguments: ["-Command", input.script] },
        environmentNames: [],
      },
    }),
  );
}
