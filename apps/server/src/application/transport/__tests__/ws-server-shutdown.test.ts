import "reflect-metadata";
import * as NodeHTTP from "node:http";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AttachmentMetaSchema, TERMINAL_BINARY_MAGIC, WebSocketResponseSchema } from "@mcode/contracts";
import { getMcodeDir } from "@mcode/shared";
import { createWsServer } from "../ws-server.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

type Server = ReturnType<typeof createWsServer>;
type HttpHandler = (request: NodeHTTP.IncomingMessage, response: NodeHTTP.ServerResponse) => Promise<void>;

const specialPaths = ["/__mcode/reliability", "/mcp", "/mcp/external-thread-control"];

describe("transport admission and shutdown drain", () => {
  const servers: Server[] = [];
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    for (const server of servers.splice(0)) {
      server.httpServer.closeAllConnections();
      await new Promise<void>((resolve) => server.wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
    }
  });

  async function startServer(handler: HttpHandler, terminalFrame: () => Promise<void> = async () => undefined, shutdown: () => void = () => undefined) {
    const server = createWsServer({
      authToken: "test-token",
      shutdown,
      agentService: { runtimeAccess: () => ({ activeCount: () => 0 }) },
      terminalService: { disconnectClient: () => undefined, handleV1Frame: terminalFrame },
      resolveBrowserAutomationHostAuthorization: () => null,
      reliabilityHarness: { enabled: true, handleRequest: handler },
      browserAutomationMcpHandler: { handle: handler },
      externalThreadControlMcpRuntime: { handleRequest: handler },
    } as never);
    servers.push(server);
    await new Promise<void>((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
    return server;
  }

  async function openClient(server: Server): Promise<WebSocket> {
    const client = new WebSocket(`ws://127.0.0.1:${port(server)}/?token=test-token`);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    return client;
  }

  it.each(specialPaths)("waits for an admitted %s request and refuses late HTTP mutation requests", async (path) => {
    const started = deferred();
    const finish = deferred();
    const handled = vi.fn(async (_request: NodeHTTP.IncomingMessage, response: NodeHTTP.ServerResponse) => {
      started.resolve();
      await finish.promise;
      response.writeHead(200).end("completed");
    });
    const server = await startServer(handled);
    const first = httpRequest(server, path);
    await started.promise;
    let drained = false;
    const drain = server.stopAdmissionAndDrain().then(() => { drained = true; });

    await expect(httpRequest(server, path)).resolves.toEqual({ status: 503, body: "Server is shutting down" });
    expect(handled).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);
    await expect(httpRequest(server, "/health", "GET")).resolves.toMatchObject({ status: 200 });

    finish.resolve();
    await expect(first).resolves.toEqual({ status: 200, body: "completed" });
    await drain;
    expect(drained).toBe(true);
    await server.stopAdmissionAndDrain();
  });

  it.each(specialPaths)("drains a rejected %s handler and preserves its failure response", async (path) => {
    const started = deferred();
    const finish = deferred();
    const server = await startServer(async () => {
      started.resolve();
      await finish.promise;
    });
    const response = httpRequest(server, path);
    await started.promise;
    const drain = server.stopAdmissionAndDrain();
    finish.reject(new Error("routed mutation failed"));
    await expect(response).resolves.toMatchObject({ status: 500 });
    await drain;
  });

  it("keeps a completed HTTP response intact when its handler subsequently rejects", async () => {
    const server = await startServer(async (_request, response) => {
      response.writeHead(200).end("already sent");
      throw new Error("failure after response");
    });
    await expect(httpRequest(server, "/mcp")).resolves.toEqual({ status: 200, body: "already sent" });
    await server.stopAdmissionAndDrain();
  });

  it("drains an admitted Terminal binary operation and refuses a subsequent frame", async () => {
    const started = deferred();
    const finish = deferred();
    const frames = vi.fn(async () => { started.resolve(); await finish.promise; });
    const server = await startServer(async () => undefined, frames);
    const client = await openClient(server);
    client.send(Buffer.from(TERMINAL_BINARY_MAGIC));
    await started.promise;
    let drained = false;
    const drain = server.stopAdmissionAndDrain().then(() => { drained = true; });
    const closed = new Promise<number>((resolve) => client.once("close", resolve));
    client.send(Buffer.from(TERMINAL_BINARY_MAGIC));
    await expect(closed).resolves.toBe(1012);
    expect(frames).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);
    finish.resolve();
    await drain;
  });

  it("rejects a pending upload payload after admission closes", async () => {
    const server = await startServer(async () => undefined);
    const client = await openClient(server);
    const serverClient = [...server.wss.clients][0];
    if (!serverClient) throw new Error("WebSocket connection was not registered");
    const headerReceived = new Promise<void>((resolve) => serverClient.once("message", () => resolve()));
    client.send(JSON.stringify({
      id: "upload-header",
      method: "clipboard.saveFile",
      type: "binary-upload",
      meta: { mimeType: "text/plain", fileName: "sample.txt" },
    }));
    await headerReceived;
    await server.stopAdmissionAndDrain();
    const response = new Promise<unknown>((resolve) => client.once("message", (data) => resolve(JSON.parse(data.toString()))));
    client.send(Buffer.from("late upload"));
    await expect(response).resolves.toEqual({
      id: "upload-header",
      error: { code: "SERVER_SHUTTING_DOWN", message: "Server is shutting down" },
    });
  });

  it("finishes an admitted binary upload's actual filesystem write before drain completes", async () => {
    const server = await startServer(async () => undefined);
    const client = await openClient(server);
    const serverClient = [...server.wss.clients][0];
    if (!serverClient) throw new Error("WebSocket connection was not registered");
    const fileName = `${NodeCrypto.randomUUID()}.txt`;
    const payload = Buffer.alloc(64 * 1024, "a");
    const response = new Promise<unknown>((resolve) => client.once("message", (data) => resolve(JSON.parse(data.toString()))));
    const binaryReceived = new Promise<void>((resolve) => {
      serverClient.on("message", (_data, isBinary) => { if (isBinary) resolve(); });
    });
    client.send(JSON.stringify({
      type: "binary-upload", id: "admitted-upload", method: "clipboard.saveFile",
      meta: { mimeType: "text/plain", fileName },
    }));
    client.send(payload);
    await binaryReceived;
    await server.stopAdmissionAndDrain();
    const directory = NodePath.join(getMcodeDir(), "temp", "attachments");
    const savedName = (await NodeFSPromises.readdir(directory)).find((name) => name.endsWith(`-${fileName}`));
    if (!savedName) throw new Error("Admitted upload was not saved before drain completed");
    const savedPath = NodePath.join(directory, savedName);
    try {
      expect(await NodeFSPromises.readFile(savedPath)).toEqual(payload);
      const envelope = WebSocketResponseSchema().parse(await response);
      expect(envelope.error).toBeUndefined();
      expect(AttachmentMetaSchema().parse(envelope.result)).toMatchObject({ sourcePath: savedPath, sizeBytes: payload.length });
    } finally {
      await NodeFSPromises.unlink(savedPath);
    }
  });

  it("allows the authenticated shutdown response to initiate drain without waiting on itself", async () => {
    const completed = deferred();
    let server: Server;
    const shutdown = vi.fn(() => { void server.stopAdmissionAndDrain().then(() => completed.resolve()); });
    server = await startServer(async () => undefined, async () => undefined, shutdown);
    await expect(httpRequest(server, "/shutdown", "POST", true)).resolves.toEqual({
      status: 200, body: JSON.stringify({ status: "shutting_down" }),
    });
    await completed.promise;
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

function port(server: Server): number {
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return address.port;
}

function httpRequest(server: Server, path: string, method = "POST", authenticated = false): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = NodeHTTP.request({
      host: "127.0.0.1", port: port(server), path, method,
      headers: authenticated ? { Authorization: "Bearer test-token" } : {},
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    request.once("error", reject);
    request.end();
  });
}
