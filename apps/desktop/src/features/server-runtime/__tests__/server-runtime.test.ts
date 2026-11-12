import * as NodeHTTP from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
  },
}));

import { ServerRuntime } from "../index.js";

type RuntimeDependencies = ConstructorParameters<typeof ServerRuntime>[0];

function createManager(
  port: number,
  start: RuntimeDependencies["manager"]["start"] = vi.fn(async () => ({ port, authToken: "test-token" })),
): RuntimeDependencies["manager"] {
  return {
    port,
    authToken: "test-token",
    ipcPath: "test-ipc-path",
    onUnexpectedExit: null,
    start,
    isHealthy: vi.fn(async () => true),
    restart: vi.fn(async () => undefined),
    forceReplace: vi.fn(async () => undefined),
    stopServerHeldByLock: vi.fn(async () => undefined),
  };
}

function createWindow() {
  return {
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
    once: vi.fn(),
  };
}

function createRuntime(port = 43123, overrides: Partial<RuntimeDependencies> = {}): ServerRuntime {
  return new ServerRuntime({
    platform: "linux",
    manager: createManager(port),
    ipcMain: { handle: vi.fn() },
    getMainWindow: () => null,
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    app: { quit: vi.fn() },
    notification: {
      isSupported: () => false,
      create: vi.fn(),
    },
    powerMonitor: { on: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
    getCookieStore: () => ({ set: vi.fn() }),
    ...overrides,
  });
}

describe("ServerRuntime Desktop Window seam", () => {
  const originalFetch = globalThis.fetch;
  const servers: NodeHTTP.Server[] = [];

  async function listen(handler: NodeHTTP.RequestListener): Promise<number> {
    const server = NodeHTTP.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no port");
    return address.port;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
  });

  it("attaches the server relay to a window once when the server is ready first", async () => {
    const relayStarter = vi.fn(() => vi.fn());
    const runtime = createRuntime(43123, { relayStarter });
    const window = createWindow();

    runtime.beginStart();
    await new Promise((resolve) => setImmediate(resolve));
    runtime.attachWindow(window);
    await runtime.connectWindow(window);

    expect(relayStarter).toHaveBeenCalledOnce();
  });

  it("joins an early start instead of starting the server again", async () => {
    const start = vi.fn(async () => ({ port: 43123, authToken: "test-token" }));
    const runtime = createRuntime(43123, {
      manager: createManager(43123, start),
      relayStarter: () => vi.fn(),
    });

    runtime.beginStart();

    await expect(runtime.connectWindow(createWindow())).resolves.toBe(43123);
    expect(start).toHaveBeenCalledOnce();
  });

  it("reports an early start failure when the window connects", async () => {
    const error = new Error("Server failed to start");
    const runtime = createRuntime(43123, {
      manager: createManager(43123, vi.fn().mockRejectedValue(error)),
    });

    runtime.beginStart();
    await new Promise((resolve) => setImmediate(resolve));

    await expect(runtime.connectWindow(createWindow())).rejects.toBe(error);
  });

  it("withholds the server URL until the window has its auth cookie and relay", async () => {
    vi.useFakeTimers();
    let finishCookieInstallation!: () => void;
    const cookieInstallation = new Promise<void>((resolve) => {
      finishCookieInstallation = resolve;
    });
    const window = createWindow();
    type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown;
    const handlers = new Map<string, Handler>();
    let cookieInstalled = false;
    let relayWindow: unknown = null;
    let relayIpcPath = "";
    const cookieSet = vi.fn(async () => {
      await cookieInstallation;
      cookieInstalled = true;
    });
    const runtime = createRuntime(43123, {
      ipcMain: {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
      },
      getMainWindow: () => window,
      getCookieStore: () => ({ set: cookieSet }),
      relayStarter: (ipcPath, attachedWindow) => {
        relayIpcPath = ipcPath;
        relayWindow = attachedWindow;
        return vi.fn();
      },
    });
    runtime.registerConnectionHandlers();
    const getServerUrl = handlers.get("get-server-url");
    if (!getServerUrl) throw new Error("get-server-url handler was not registered");

    let resolved = false;
    const response = Promise.resolve(getServerUrl({ sender: window.webContents })).then((connection) => {
      resolved = true;
      return { connection, cookieInstalled, relayWindow, relayIpcPath };
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    const connecting = runtime.connectWindow(window);
    await vi.advanceTimersByTimeAsync(0);
    expect(cookieSet).toHaveBeenCalledOnce();
    expect(resolved).toBe(false);

    finishCookieInstallation();
    await expect(response).resolves.toEqual({
      connection: {
        url: "ws://127.0.0.1:43123?token=test-token",
        ipcPath: "test-ipc-path",
      },
      cookieInstalled: true,
      relayWindow: window,
      relayIpcPath: "test-ipc-path",
    });
    await expect(connecting).resolves.toBe(43123);
  });

  it("holds the launch-telemetry read until the server answers and sends the connection credential", async () => {
    const requests: NodeHTTP.IncomingMessage[] = [];
    const answers: Array<() => void> = [];
    const port = await listen((request, response) => {
      requests.push(request);
      answers.push(() => response.end(JSON.stringify({ held: true })));
    });
    let settled = false;

    const read = createRuntime(port).fetchLaunchTelemetry(1_000).finally(() => { settled = true; });

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.url).toBe("/__mcode/launch-telemetry?usableAt=1000");
    expect(requests[0]?.headers.authorization).toBe("Bearer test-token");
    expect(settled).toBe(false);
    answers[0]?.();
    const response = await read;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ held: true });
  });

  it.each([
    ["drops the connection", (request: NodeHTTP.IncomingMessage) => request.socket.destroy()],
    ["cuts its answer short", (_request: NodeHTTP.IncomingMessage, response: NodeHTTP.ServerResponse) => {
      response.writeHead(200, { "Content-Length": "100" });
      response.write("{");
      setImmediate(() => response.socket?.destroy());
    }],
  ])("fails the launch-telemetry read when the server %s", async (_name, handler) => {
    const port = await listen(handler);

    await expect(createRuntime(port).fetchLaunchTelemetry()).rejects.toThrow();
  });

  it.each([0, 1, 42])(
    "returns a valid active-agent count of %s from the health endpoint",
    async (activeAgents) => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ activeAgents }), { status: 200 }),
      ) as unknown as typeof fetch;

      await expect(createRuntime().getActiveAgentCount()).resolves.toBe(activeAgents);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:43123/health",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    },
  );

  it.each([
    ["fractional", 1.5],
    ["negative", -1],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["oversized", 1e100],
    ["malformed", "two"],
  ] as const)("rejects %s active-agent values", async (_label, activeAgents) => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ activeAgents }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(createRuntime().getActiveAgentCount()).rejects.toThrow("invalid active-agent count");
  });

  it("rejects when the health endpoint is unavailable", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("server unavailable")) as unknown as typeof fetch;

    await expect(createRuntime().getActiveAgentCount()).rejects.toThrow("server unavailable");
  });

  it("rejects a failed health response and a missing port", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;

    await expect(createRuntime().getActiveAgentCount()).rejects.toThrow("HTTP 503");
    await expect(createRuntime(0).getActiveAgentCount()).rejects.toThrow("port is not available");
  });
});

