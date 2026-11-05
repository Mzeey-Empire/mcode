import * as NodeEvents from "node:events";
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import { CanonicalLiveEventPublisher } from "../../../canonical-live-event-publisher.js";
import { ProviderRuntimeEventSchema, providerRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import { describe, expect, it, vi } from "vitest";
import type { Client, ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { AcpSessionRuntime, SessionRecoveryFailedError } from "../acp-session-runtime.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

function fakeChild() {
  return Object.assign(new NodeEvents.EventEmitter(), {
    kill: vi.fn(() => true),
    pid: 1234,
  }) as unknown as NodeChildProcess.ChildProcess;
}

function fakeProcesses() {
  return {
    attach: vi.fn(),
    terminateTree: vi.fn(async () => undefined),
  };
}

describe("AcpSessionRuntime", () => {
  it.each([
    ["cursor", "stop"], ["cursor", "close"], ["devin", "stop"], ["devin", "close"],
  ] as const)("drains %s ACP output and its real end on %s while paused", async (providerId, action) => {
    const child = new NodeChildProcess.ChildProcess();
    const input = new NodeStream.PassThrough();
    const output = new NodeStream.PassThrough();
    child.stdin = input;
    child.stdout = output;
    const spawn = vi.mocked(NodeChildProcess.spawn).mockReturnValue(child);
    const held = Promise.withResolvers<void>();
    const paused = Promise.withResolvers<void>();
    const received: string[] = [];
    let admitted = 0;
    let promptId: number | undefined;
    const route = { threadId: "thread", turnId: "turn", executionId: "11111111-1111-4111-8111-111111111111", deliveryAttempt: 1 };
    const publisher = new CanonicalLiveEventPublisher("unbounded", providerId, { submit: async (batch) => {
      await held.promise;
      for (const draft of batch.events) {
        if (draft.payload.type !== "item.recorded") throw new Error("Missing event");
        const runtime = ProviderRuntimeEventSchema().parse(draft.payload.item.payload.runtimeEvent);
        if (runtime.event.type !== "textDelta") throw new Error("Missing text");
        received.push(runtime.event.delta);
      }
      return { commit: { outcome: "accepted", acceptedThrough: 1, eventCount: 1,
        progressPosition: { epoch: "epoch", sequence: 1 } }, delivery: { ingress: "not-required" } };
    } });
    const write = (value: unknown): void => { output.write(JSON.stringify(value) + "\n"); };
    input.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString());
      if (request.method === "initialize") write({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      if (request.method === "session/new") write({ jsonrpc: "2.0", id: request.id, result: { sessionId: "native" } });
      if (request.method === "session/prompt") promptId = request.id;
      if (request.method === "session/cancel") writeTail();
    });
    const writeTail = (): void => {
      for (let index = 256; index < 1_500; index++) writeUpdate(index);
      write({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      output.end();
      child.emit("exit", 0, null);
    };
    const writeUpdate = (index: number): void => write({ jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "native", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: String(index) } } } });
    let runtime: AcpSessionRuntime | undefined;
    try {
      runtime = await AcpSessionRuntime.start({
        spawnSpec: { command: "fixture", args: [], cwd: ".", env: {} }, processes: fakeProcesses(),
        waitForOutputCapacity: async (signal) => {
          const capacity = publisher.waitForCapacity(route.threadId, signal);
          if (admitted >= 256) paused.resolve();
          await capacity;
        },
        callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
          onSessionUpdate: async ({ update }) => {
            if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") throw new Error("Unexpected update");
            admitted++;
            publisher.publish(route, providerRuntimeEvent({ type: "textDelta", threadId: "thread", delta: update.content.text }), []);
          } },
      });
      await runtime.initialize();
      await runtime.openSession({ cwd: ".", mcpServers: [] });
      const prompt = runtime.prompt({ prompt: [] });
      for (let index = 0; index < 256; index++) writeUpdate(index);
      await paused.promise;
      const stopping = action === "stop" ? runtime.cancel() : runtime.close();
      if (action === "close") writeTail();
      await stopping;
      await runtime.drainOutput();
      expect(await prompt).toEqual({ stopReason: "end_turn" });
      held.resolve();
      await publisher.stopAdmissionAndDrain();
      expect(received).toEqual(Array.from({ length: 1_500 }, (_, index) => String(index)));
    } finally {
      held.resolve();
      output.end();
      await runtime?.close();
      spawn.mockRestore();
    }
  });

  it.each(["stop", "close"])("%s releases a paused native ending while saves remain held", async (action) => {
    const child = new NodeChildProcess.ChildProcess();
    const input = new NodeStream.PassThrough();
    const output = new NodeStream.PassThrough();
    child.stdin = input;
    child.stdout = output;
    const spawn = vi.mocked(NodeChildProcess.spawn).mockReturnValue(child);
    const held = Promise.withResolvers<void>();
    const paused = Promise.withResolvers<void>();
    const route = { threadId: "held", turnId: "turn", executionId: "11111111-1111-4111-8111-111111111111", deliveryAttempt: 1 };
    const publisher = new CanonicalLiveEventPublisher("unbounded", "cursor", { submit: async () => {
      await held.promise;
      return { commit: { outcome: "accepted", acceptedThrough: 1, eventCount: 1,
        progressPosition: { epoch: "epoch", sequence: 1 } }, delivery: { ingress: "not-required" } };
    } });
    const write = (value: unknown): void => { output.write(JSON.stringify(value) + "\n"); };
    let promptId = 0;
    let admitted = 0;
    input.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString());
      if (request.method === "initialize") write({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      if (request.method === "session/new") write({ jsonrpc: "2.0", id: request.id, result: { sessionId: "native" } });
      if (request.method === "session/prompt") promptId = request.id;
    });
    const runtime = await AcpSessionRuntime.start({
      spawnSpec: { command: "fixture", args: [], cwd: ".", env: {} }, processes: fakeProcesses(),
      waitForOutputCapacity: (signal) => {
        if (admitted >= 256) paused.resolve();
        return publisher.waitForCapacity(route.threadId, signal);
      },
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
        onSessionUpdate: async () => {
          admitted++;
          publisher.publish(route, providerRuntimeEvent({ type: "textDelta", threadId: "held", delta: "x" }), []);
        } },
    });
    try {
      await runtime.initialize();
      await runtime.openSession({ cwd: ".", mcpServers: [] });
      const prompt = runtime.prompt({ prompt: [] });
      await vi.waitFor(() => expect(promptId).not.toBe(0));
      for (let i = 0; i < 256; i++) write({ jsonrpc: "2.0", method: "session/update",
        params: { sessionId: "native", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } });
      await paused.promise;
      write({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
      const stopping = action === "stop" ? runtime.cancel() : runtime.close();
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
      if (action === "stop") {
        for (let i = 0; i < 1000; i++) write({ jsonrpc: "2.0", method: "session/update",
          params: { sessionId: "native", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ignored cancel" } } } });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(admitted).toBeLessThanOrEqual(257);
      }
      await stopping;
    } finally {
      output.end();
      await runtime.close();
      held.resolve();
      await publisher.stopAdmissionAndDrain();
      spawn.mockRestore();
    }
  });

  it("negotiates auth, falls back from load, serializes prompts, and cancels the active session", async () => {
    const child = fakeChild();
    const promptResolvers: Array<(value: unknown) => void> = [];
    const calls: string[] = [];
    const updates: SessionNotification[] = [];
    let client!: Client;
    const connection = {
      initialize: vi.fn(async () => ({
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "login" }],
      })),
      authenticate: vi.fn(async () => { calls.push("auth"); }),
      loadSession: vi.fn(async () => { calls.push("load"); throw new Error("stale"); }),
      newSession: vi.fn(async () => { calls.push("new"); return { sessionId: "acp-1" }; }),
      prompt: vi.fn(({ sessionId }: { sessionId: string }) => {
        calls.push(`prompt:${sessionId}`);
        return new Promise((resolve) => promptResolvers.push(resolve));
      }),
      cancel: vi.fn(async ({ sessionId }: { sessionId: string }) => { calls.push(`cancel:${sessionId}`); }),
    } as unknown as ClientSideConnection;

    const runtime = await AcpSessionRuntime.start({
      waitForOutputCapacity: async () => {},
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: {
        onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
        onSessionUpdate: async (update) => { updates.push(update); },
      },
      clientFactory: (handlers) => {
        client = {
          requestPermission: handlers.onPermissionRequest,
          sessionUpdate: handlers.onSessionUpdate,
          readTextFile: async () => ({ content: "" }),
          writeTextFile: async () => ({}),
          extMethod: async () => ({}),
          extNotification: async () => {},
        };
        return client;
      },
      transportFactory: async () => ({ child, connection }),
    });

    await runtime.initialize();
    await client.sessionUpdate({ sessionId: "pre-open", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
    expect(updates).toHaveLength(0);
    const opened = await runtime.openSession({ resumeFrom: "old", cwd: ".", mcpServers: [] });
    expect(opened).toEqual({ sessionId: "acp-1", reloaded: false });
    expect(calls.slice(0, 3)).toEqual(["auth", "load", "new"]);
    await client.sessionUpdate({ sessionId: "other", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
    await client.sessionUpdate({ sessionId: "acp-1", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
    expect(updates.map((update) => update.sessionId)).toEqual(["acp-1"]);

    const first = runtime.prompt({ prompt: [] });
    const second = runtime.prompt({ prompt: [] });
    await Promise.resolve();
    expect(calls).toContain("prompt:acp-1");
    promptResolvers.shift()?.({ stopReason: "end_turn" });
    await first;
    expect(calls.filter((call) => call === "prompt:acp-1")).toHaveLength(2);
    promptResolvers.shift()?.({ stopReason: "end_turn" });
    await second;
    await runtime.cancel();
    expect(calls).toContain("cancel:acp-1");
  });

  it("creates a fresh session without calling load when the capability is absent", async () => {
    const child = fakeChild();
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: {}, authMethods: [] })),
      resumeSession: vi.fn(async () => ({})),
      loadSession: vi.fn(async () => ({ sessionId: "unexpected" })),
      newSession: vi.fn(async () => ({ sessionId: "fresh" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      waitForOutputCapacity: async () => {},
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child, connection }),
    });
    await runtime.initialize();
    await runtime.openSession({ resumeFrom: "old", cwd: ".", mcpServers: [] });
    expect(connection.resumeSession).not.toHaveBeenCalled();
    expect(connection.loadSession).not.toHaveBeenCalled();
    expect(connection.newSession).toHaveBeenCalledTimes(1);
  });

  it("forwards matching load replay updates before the load response installs the active session", async () => {
    const child = fakeChild();
    let client!: Client;
    let finishLoad!: () => void;
    const updates: SessionNotification[] = [];
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
      loadSession: vi.fn(async () => {
        await client.sessionUpdate({ sessionId: "resume-1", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
        await new Promise<void>((resolve) => { finishLoad = resolve; });
      }),
      newSession: vi.fn(async () => ({ sessionId: "fresh" })),
    } as unknown as ClientSideConnection;

    const runtime = await AcpSessionRuntime.start({
      waitForOutputCapacity: async () => {},
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: {
        onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
        onSessionUpdate: async (update) => { updates.push(update); },
      },
      clientFactory: (handlers) => {
        client = {
          requestPermission: handlers.onPermissionRequest,
          sessionUpdate: handlers.onSessionUpdate,
          readTextFile: async () => ({ content: "" }),
          writeTextFile: async () => ({}),
          extMethod: async () => ({}),
          extNotification: async () => {},
        };
        return client;
      },
      transportFactory: async () => ({ child, connection }),
      sessionLoadTimeoutMs: 100,
    });

    await runtime.initialize();
    const opening = runtime.openSession({ resumeFrom: "resume-1", cwd: ".", mcpServers: [] });
    await Promise.resolve();
    await client.sessionUpdate({ sessionId: "other", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
    expect(updates.map((update) => update.sessionId)).toEqual(["resume-1"]);
    expect(runtime.state.sessionId).toBe("");

    finishLoad();
    await expect(opening).resolves.toEqual({ sessionId: "resume-1", reloaded: true });
    await client.sessionUpdate({ sessionId: "resume-1", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
    expect(updates.map((update) => update.update)).toEqual([
      { sessionUpdate: "session_info_update" },
      { sessionUpdate: "session_info_update" },
    ]);
  });

  it("preserves the generic fallback after a rejected load recovery", async () => {
    const child = fakeChild();
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
      loadSession: vi.fn(async () => { throw new Error("stale"); }),
      newSession: vi.fn(async () => ({ sessionId: "fresh-after-failure" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      waitForOutputCapacity: async () => {},
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child, connection }),
    });

    await runtime.initialize();
    await expect(runtime.openSession({ resumeFrom: "stalled", cwd: ".", mcpServers: [] })).resolves.toEqual({
      sessionId: "fresh-after-failure",
      reloaded: false,
    });
    expect(connection.newSession).toHaveBeenCalledTimes(1);
  });

  it("preserves the generic fallback after a recovery inactivity timeout", async () => {
    vi.useFakeTimers();
    try {
      const connection = {
        initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
        loadSession: vi.fn(() => new Promise<never>(() => {})),
        newSession: vi.fn(async () => ({ sessionId: "fresh-after-timeout" })),
      } as unknown as ClientSideConnection;
      const runtime = await AcpSessionRuntime.start({
        waitForOutputCapacity: async () => {},
        spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
        processes: fakeProcesses(),
        callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
        transportFactory: async () => ({ child: fakeChild(), connection }),
        recoveryInactivityTimeoutMs: 50,
      });

      await runtime.initialize();
      const opening = runtime.openSession({ resumeFrom: "stalled", cwd: ".", mcpServers: [] });
      await vi.advanceTimersByTimeAsync(50);
      await expect(opening).resolves.toEqual({ sessionId: "fresh-after-timeout", reloaded: false });
      expect(connection.newSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a closed never-resolving recovery without creating a replacement session", async () => {
    const terminateTree = vi.fn(async () => undefined);
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
      loadSession: vi.fn(() => new Promise<never>(() => {})),
      newSession: vi.fn(async () => ({ sessionId: "replacement" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      waitForOutputCapacity: async () => {},
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: { attach: vi.fn(), terminateTree },
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child: fakeChild(), connection }),
    });

    await runtime.initialize();
    const opening = runtime.openSession({ resumeFrom: "preserved", cwd: ".", mcpServers: [] });
    await vi.waitFor(() => expect(connection.loadSession).toHaveBeenCalledOnce());
    await runtime.close();

    await expect(opening).rejects.toBeInstanceOf(SessionRecoveryFailedError);
    expect(terminateTree).toHaveBeenCalledExactlyOnceWith(1234);
    expect(connection.newSession).not.toHaveBeenCalled();
  });

  it("prefers advertised session resume over load and new", async () => {
    const connection = {
      initialize: vi.fn(async () => ({
        agentCapabilities: { sessionCapabilities: { resume: {} }, loadSession: true },
        authMethods: [],
      })),
      resumeSession: vi.fn(async () => ({})),
      loadSession: vi.fn(async () => ({ sessionId: "unexpected" })),
      newSession: vi.fn(async () => ({ sessionId: "unexpected" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      waitForOutputCapacity: async () => {},
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child: fakeChild(), connection }),
    });

    await runtime.initialize();
    await expect(runtime.openSession({ resumeFrom: "resume-1", cwd: ".", mcpServers: [] })).resolves.toEqual({
      sessionId: "resume-1",
      reloaded: true,
    });
    expect(connection.resumeSession).toHaveBeenCalledWith({ sessionId: "resume-1", cwd: ".", mcpServers: [] });
    expect(connection.loadSession).not.toHaveBeenCalled();
    expect(connection.newSession).not.toHaveBeenCalled();
  });

  it("uses load only when resume is not advertised", async () => {
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
      resumeSession: vi.fn(async () => ({})),
      loadSession: vi.fn(async () => ({})),
      newSession: vi.fn(async () => ({ sessionId: "unexpected" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      waitForOutputCapacity: async () => {},
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child: fakeChild(), connection }),
    });

    await runtime.initialize();
    await runtime.openSession({ resumeFrom: "resume-1", cwd: ".", mcpServers: [] });
    expect(connection.resumeSession).not.toHaveBeenCalled();
    expect(connection.loadSession).toHaveBeenCalledWith({
      sessionId: "resume-1",
      cwd: ".",
      mcpServers: [],
    });
    expect(connection.newSession).not.toHaveBeenCalled();
  });

  it("fails closed without replacing a Cursor recovery session", async () => {
    const terminateTree = vi.fn(async () => undefined);
    const connection = {
      initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
      loadSession: vi.fn(async () => { throw new Error("provider failure"); }),
      newSession: vi.fn(async () => ({ sessionId: "replacement" })),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      waitForOutputCapacity: async () => {},
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: { attach: vi.fn(), terminateTree },
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child: fakeChild(), connection }),
      recoveryFailurePolicy: "fail-without-replacement",
    });

    await runtime.initialize();
    await expect(runtime.openSession({ resumeFrom: "preserved", cwd: ".", mcpServers: [] })).rejects.toBeInstanceOf(
      SessionRecoveryFailedError,
    );
    expect(connection.newSession).not.toHaveBeenCalled();
    expect(terminateTree).toHaveBeenCalledExactlyOnceWith(1234);
  });

  it("resets recovery inactivity only for matching replay updates", async () => {
    vi.useFakeTimers();
    try {
      let client!: Client;
      const terminateTree = vi.fn(async () => undefined);
      const updates: SessionNotification[] = [];
      const connection = {
        initialize: vi.fn(async () => ({ agentCapabilities: { loadSession: true }, authMethods: [] })),
        loadSession: vi.fn(() => new Promise<never>(() => {})),
        newSession: vi.fn(async () => ({ sessionId: "replacement" })),
      } as unknown as ClientSideConnection;
      const runtime = await AcpSessionRuntime.start({
        waitForOutputCapacity: async () => {},
        spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
        processes: { attach: vi.fn(), terminateTree },
        callbacks: {
          onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
          onSessionUpdate: async (update) => { updates.push(update); },
        },
        clientFactory: (handlers) => {
          client = {
            requestPermission: handlers.onPermissionRequest,
            sessionUpdate: handlers.onSessionUpdate,
            readTextFile: async () => ({ content: "" }),
            writeTextFile: async () => ({}),
            extMethod: async () => ({}),
            extNotification: async () => {},
          };
          return client;
        },
        transportFactory: async () => ({ child: fakeChild(), connection }),
        recoveryFailurePolicy: "fail-without-replacement",
        recoveryInactivityTimeoutMs: 50,
      });

      await runtime.initialize();
      const opening = runtime.openSession({ resumeFrom: "preserved", cwd: ".", mcpServers: [] });
      const recoveryFailure = expect(opening).rejects.toBeInstanceOf(SessionRecoveryFailedError);
      await vi.advanceTimersByTimeAsync(40);
      await client.sessionUpdate({ sessionId: "preserved", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
      await vi.advanceTimersByTimeAsync(40);
      await client.sessionUpdate({ sessionId: "foreign", update: { sessionUpdate: "session_info_update" } } as SessionNotification);
      await vi.advanceTimersByTimeAsync(10);

      await recoveryFailure;
      expect(updates.map((update) => update.sessionId)).toEqual(["preserved"]);
      expect(connection.newSession).not.toHaveBeenCalled();
      expect(terminateTree).toHaveBeenCalledExactlyOnceWith(1234);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the process authority when initialization fails", async () => {
    const child = fakeChild();
    const terminateTree = vi.fn(async () => undefined);
    const connection = {
      initialize: vi.fn(async () => { throw new Error("handshake failed"); }),
    } as unknown as ClientSideConnection;
    const runtime = await AcpSessionRuntime.start({
      waitForOutputCapacity: async () => {},
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: { attach: vi.fn(), terminateTree },
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({ child, connection }),
    });
    await expect(runtime.initialize()).rejects.toThrow("handshake failed");
    expect(terminateTree).toHaveBeenCalledExactlyOnceWith(1234);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("rejects malformed nested ACP data before it reaches provider mapping", async () => {
    const child = fakeChild();
    let client!: Client;
    const updates: SessionNotification[] = [];
    const runtime = await AcpSessionRuntime.start({
      waitForOutputCapacity: async () => {},
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: {
        onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
        onSessionUpdate: async (update) => { updates.push(update); },
      },
      clientFactory: (handlers) => {
        client = {
          requestPermission: handlers.onPermissionRequest,
          sessionUpdate: handlers.onSessionUpdate,
          readTextFile: async () => ({ content: "" }),
          writeTextFile: async () => ({}),
          extMethod: async () => ({}),
          extNotification: async () => {},
        };
        return client;
      },
      transportFactory: async () => ({
        child,
        connection: {
          initialize: vi.fn(async () => ({ agentCapabilities: {}, authMethods: [] })),
          newSession: vi.fn(async () => ({ sessionId: "acp-1" })),
        } as unknown as ClientSideConnection,
      }),
    });

    await runtime.initialize();
    await runtime.openSession({ cwd: ".", mcpServers: [] });
    await expect(client.sessionUpdate({
      sessionId: "acp-1",
      update: { sessionUpdate: "agent_message_chunk", content: null },
    } as never)).rejects.toMatchObject({ code: "INVALID_ACP_PAYLOAD" });
    expect(updates).toEqual([]);
  });

  it("rejects malformed nested capabilities during initialization", async () => {
    const runtime = await AcpSessionRuntime.start({
      waitForOutputCapacity: async () => {},
      spawnSpec: { command: "fake", args: [], cwd: ".", env: {} },
      processes: fakeProcesses(),
      callbacks: { onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }), onSessionUpdate: async () => {} },
      transportFactory: async () => ({
        child: fakeChild(),
        connection: {
          initialize: vi.fn(async () => ({ agentCapabilities: { mcpCapabilities: { http: "yes" } } })),
        } as unknown as ClientSideConnection,
      }),
    });

    await expect(runtime.initialize()).rejects.toMatchObject({ code: "INVALID_ACP_PAYLOAD" });
  });
});
