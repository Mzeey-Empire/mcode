import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as NodeHTTP from "node:http";
import { WebSocket, type WebSocketServer } from "ws";
import { createWsServer } from "../ws-server.js";
import { TerminalBackend } from "../../../features/terminal/backends/terminal-backend.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const terminalCreateCases = [
  {
    method: "terminal.create",
    params: { threadId: "thread-1" },
    result: { ptyId: "pty-late", shell: "pwsh" },
  },
] as const;

describe("disconnected Terminal creates", () => {
  let server: NodeHTTP.Server | undefined;
  let websocketServer: WebSocketServer | undefined;
  let stopAdmissionAndDrain: () => Promise<void>;

  afterEach(async () => {
    if (websocketServer) {
      await new Promise<void>((resolve) => websocketServer!.close(() => resolve()));
      websocketServer = undefined;
    }
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it.each(terminalCreateCases)(
    "drains $method and its cleanup when the requesting client disconnected",
    async ({ method, params, result }) => {
      const createStarted = createDeferred<void>();
      const clientDisconnected = createDeferred<void>();
      const cleanupCompleted = createDeferred<void>();
      const cleanupStarted = createDeferred<void>();
      const cleanupAllowed = createDeferred<void>();
      const created = createDeferred<unknown>();
      const kill = vi.fn(async () => {
        cleanupStarted.resolve();
        await cleanupAllowed.promise;
        cleanupCompleted.resolve();
      });
      const terminalService = {
        create: vi.fn(() => {
          createStarted.resolve();
          return created.promise;
        }),
        kill,
        cleanupDisconnectedCreate: TerminalBackend.prototype.cleanupDisconnectedCreate,
        disconnectClient: vi.fn(() => clientDisconnected.resolve()),
      };

      ({ httpServer: server, wss: websocketServer, stopAdmissionAndDrain } = createWsServer({
        authToken: "test-token",
        singleInstance: false,
        shutdown: () => undefined,
        agentService: { runtimeAccess: () => ({ activeCount: () => 0 }) },
        terminalService,
        resolveBrowserAutomationHostAuthorization: () => null,
      } as never));
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));

      const client = await openClient(server!);
      client.send(JSON.stringify({ id: "terminal-create", method, params }));
      await createStarted.promise;

      await closeClient(client);
      await clientDisconnected.promise;
      let drained = false;
      const drain = stopAdmissionAndDrain().then(() => { drained = true; });
      const lateClient = await openClient(server!);
      const rejection = nextResponse(lateClient);
      lateClient.send(JSON.stringify({ id: "late-create", method, params }));
      await expect(rejection).resolves.toEqual({
        id: "late-create",
        error: { code: "SERVER_SHUTTING_DOWN", message: "Server is shutting down" },
      });
      expect(drained).toBe(false);
      await closeClient(lateClient);
      created.resolve(result);
      await cleanupStarted.promise;
      expect(drained).toBe(false);
      cleanupAllowed.resolve();
      await cleanupCompleted.promise;
      await drain;
      expect(drained).toBe(true);
      await stopAdmissionAndDrain();

      expect(kill).toHaveBeenCalledExactlyOnceWith("pty-late");
    },
  );

  it("keeps a legacy Terminal when the create response is delivered before disconnect", async () => {
    const kill = vi.fn(async () => undefined);
    const terminalService = {
      create: vi.fn(async () => ({ ptyId: "pty-delivered", shell: "pwsh" })),
      kill,
      cleanupDisconnectedCreate: TerminalBackend.prototype.cleanupDisconnectedCreate,
      disconnectClient: vi.fn(),
    };

    ({ httpServer: server, wss: websocketServer } = createWsServer({
      authToken: "test-token",
      singleInstance: false,
      shutdown: () => undefined,
      agentService: { runtimeAccess: () => ({ activeCount: () => 0 }) },
      terminalService,
      resolveBrowserAutomationHostAuthorization: () => null,
    } as never));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));

    const client = await openClient(server!);
    const response = new Promise<unknown>((resolve) => {
      client.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    client.send(JSON.stringify({
      id: "terminal-create",
      method: "terminal.create",
      params: { threadId: "thread-1" },
    }));

    await expect(response).resolves.toEqual({
      id: "terminal-create",
      result: { ptyId: "pty-delivered", shell: "pwsh" },
    });
    await closeClient(client);
    expect(kill).not.toHaveBeenCalled();
  });

  it("closes a legacy Terminal when response delivery fails before disconnect", async () => {
    const createStarted = createDeferred<void>();
    const cleanupCompleted = createDeferred<void>();
    const created = createDeferred<unknown>();
    const kill = vi.fn(async () => { cleanupCompleted.resolve(); });
    const terminalService = {
      create: vi.fn(() => {
        createStarted.resolve();
        return created.promise;
      }),
      kill,
      cleanupDisconnectedCreate: TerminalBackend.prototype.cleanupDisconnectedCreate,
      disconnectClient: vi.fn(),
    };

    ({ httpServer: server, wss: websocketServer } = createWsServer({
      authToken: "test-token",
      singleInstance: false,
      shutdown: () => undefined,
      agentService: { runtimeAccess: () => ({ activeCount: () => 0 }) },
      terminalService,
      resolveBrowserAutomationHostAuthorization: () => null,
    } as never));
    websocketServer.on("connection", (serverClient) => {
      vi.spyOn(serverClient, "send").mockImplementation((...args) => {
        const completion = args.find((argument) => typeof argument === "function");
        if (typeof completion === "function") completion(new Error("response write failed"));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));

    const client = await openClient(server!);
    client.send(JSON.stringify({
      id: "terminal-create",
      method: "terminal.create",
      params: { threadId: "thread-1" },
    }));
    await createStarted.promise;
    created.resolve({ ptyId: "pty-send-failed", shell: "pwsh" });
    await cleanupCompleted.promise;

    expect(kill).toHaveBeenCalledExactlyOnceWith("pty-send-failed");
    await closeClient(client);
  });
});

function openClient(server: NodeHTTP.Server): Promise<WebSocket> {
  const address = server.address();
  if (!address || typeof address === "string") return Promise.reject(new Error("Server did not bind"));
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${address.port}?token=test-token`);
    const rejectOpen = (error: Error) => reject(error);
    client.once("error", rejectOpen);
    client.once("open", () => {
      client.off("error", rejectOpen);
      resolve(client);
    });
  });
}

function closeClient(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    client.once("close", () => resolve());
    client.close();
  });
}

function nextResponse(client: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    client.once("message", (data) => {
      try { resolve(JSON.parse(data.toString())); }
      catch (error) { reject(error); }
    });
  });
}
