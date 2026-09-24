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
  {
    method: "terminal.session.create",
    params: {
      scope: { kind: "workspace", workspaceId: "00000000-0000-4000-8000-000000000002" },
    },
    result: {
      contractVersion: 1,
      sessionId: "00000000-0000-4000-8000-000000000001",
      scope: { kind: "workspace", workspaceId: "00000000-0000-4000-8000-000000000002" },
      state: "running",
      hostGeneration: "1",
      launch: {
        requestedProfileId: "automatic",
        resolvedProfile: {
          id: "certified:windows-powershell-7",
          name: "PowerShell 7",
          executable: "pwsh.exe",
          arguments: [],
          source: "certified",
          platform: "windows",
        },
        scope: { kind: "workspace", workspaceId: "00000000-0000-4000-8000-000000000002" },
        arguments: [],
      },
      createdAt: "2026-09-24T12:00:00.000Z",
      lastCommandSeq: "0",
      lastOutputSeq: "0",
      exit: null,
      tombstone: false,
    },
  },
] as const;

describe("disconnected Terminal creates", () => {
  let server: NodeHTTP.Server | undefined;
  let websocketServer: WebSocketServer | undefined;

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
    "closes $method when its response completes after the client timed out and disconnected",
    async ({ method, params, result }) => {
      const createStarted = createDeferred<void>();
      const clientDisconnected = createDeferred<void>();
      const cleanupCompleted = createDeferred<void>();
      const created = createDeferred<unknown>();
      const kill = vi.fn(async () => { cleanupCompleted.resolve(); });
      const routeV1 = vi.fn((routeMethod: string) => {
        if (routeMethod === "terminal.session.create") {
          createStarted.resolve();
          return created.promise;
        }
        if (routeMethod === "terminal.session.close") cleanupCompleted.resolve();
        return Promise.resolve(undefined);
      });
      const terminalService = {
        create: vi.fn(() => {
          createStarted.resolve();
          return created.promise;
        }),
        kill,
        routeV1,
        cleanupDisconnectedCreate: TerminalBackend.prototype.cleanupDisconnectedCreate,
        disconnectClient: vi.fn(() => clientDisconnected.resolve()),
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
      client.send(JSON.stringify({ id: "terminal-create", method, params }));
      await createStarted.promise;

      await closeClient(client);
      await clientDisconnected.promise;
      created.resolve(result);
      await cleanupCompleted.promise;

      if (method === "terminal.create") {
        expect(kill).toHaveBeenCalledExactlyOnceWith("pty-late");
      } else {
        const createCall = routeV1.mock.calls.find(([calledMethod]) => calledMethod === "terminal.session.create");
        const closeCall = routeV1.mock.calls.at(-1);
        expect(closeCall?.slice(0, 2)).toEqual([
          "terminal.session.close",
          { sessionId: "00000000-0000-4000-8000-000000000001", reason: "user" },
        ]);
        expect(closeCall?.[2]).toBe(createCall?.[2]);
      }
    },
  );
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
