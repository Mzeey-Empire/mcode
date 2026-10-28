import { describe, expect, it, vi } from "vitest";
import * as NodeHTTP from "node:http";
import { createReliabilityHarnessAdapter, readReliabilityHarnessCapability } from "../control.js";

function databaseStub() {
  return { setQueryOnlyForReliability: vi.fn(async (_enabled: boolean) => undefined) };
}

describe("reliability harness server adapter", () => {
  it("stays disabled when the capability path is absent", () => {
    const adapter = createReliabilityHarnessAdapter(databaseStub(), undefined);
    expect(adapter.enabled).toBe(false);
  });

  it("rejects malformed and non-absolute capability paths", () => {
    expect(readReliabilityHarnessCapability("relative-capability.json")).toBeNull();
  });

  it.each(["wrong-token", `${"a".repeat(63)}é`])("rejects an incorrect capability token: %s", async (token) => {
    const database = databaseStub();
    const adapter = createReliabilityHarnessAdapter(database, {
      version: 1,
      token: "a".repeat(64),
      runId: "run-1",
    });
    const response = responseStub();
    const request = requestStub(
      JSON.stringify({ control: "persistence-failure" }),
      token,
    );

    await adapter.handleRequest(request, response, new Set() as never);

    expect(response.writeHead).toHaveBeenCalledWith(401);
    expect(database.setQueryOnlyForReliability).not.toHaveBeenCalled();
  });

  it("activates persistence failure at the database boundary", async () => {
    const database = databaseStub();
    const adapter = createReliabilityHarnessAdapter(database, {
      version: 1,
      token: "b".repeat(64),
      runId: "run-2",
    });
    const response = responseStub();

    await adapter.handleRequest(
      requestStub(JSON.stringify({ control: "persistence-failure" }), "b".repeat(64)),
      response,
      new Set() as never,
    );

    expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
    expect(database.setQueryOnlyForReliability).toHaveBeenCalledWith(true);
  });

  it("acknowledges persistence fault only after the writer policy is applied", async () => {
    let release!: () => void;
    const applied = new Promise<void>((resolve) => { release = resolve; });
    const writer = { setQueryOnlyForReliability: vi.fn(() => applied) };
    const adapter = createReliabilityHarnessAdapter(writer, { version: 1, token: "b".repeat(64), runId: "writer-fault" });
    const response = responseStub();
    const request = adapter.handleRequest(requestStub(JSON.stringify({ control: "persistence-failure" }), "b".repeat(64)), response, new Set() as never);
    await vi.waitFor(() => expect(writer.setQueryOnlyForReliability).toHaveBeenCalledWith(true));
    expect(response.writeHead).not.toHaveBeenCalled();
    release();
    await request;
    expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
  });

  it("executes transport loss and bounded server lifecycle controls", async () => {
    const blockEventLoop = vi.fn();
    const adapter = createReliabilityHarnessAdapter(databaseStub(), {
      version: 1,
      token: "c".repeat(64),
      runId: "run-3",
    }, { blockEventLoop });
    const socket = { readyState: 1, close: vi.fn() };
    const sockets = new Set([socket]) as never;
    const transportResponse = responseStub();
    await adapter.handleRequest(
      requestStub(JSON.stringify({ control: "transport-loss" }), "c".repeat(64)),
      transportResponse,
      sockets,
    );
    expect(socket.close).toHaveBeenCalledWith(1012, "Reliability control");

    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      await adapter.handleRequest(
        requestStub(JSON.stringify({ control: "server-exit" }), "c".repeat(64)),
        responseStub(),
        new Set() as never,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(exit).toHaveBeenCalledWith(137);
    } finally {
      exit.mockRestore();
    }

    await adapter.handleRequest(
      requestStub(JSON.stringify({ control: "server-hang", durationMs: 1 }), "c".repeat(64)),
      responseStub(),
      new Set() as never,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(blockEventLoop).toHaveBeenCalledWith(1);
  });
});

function requestStub(body: string, token: string): NodeHTTP.IncomingMessage {
  const request = new ReadableRequest(body) as unknown as NodeHTTP.IncomingMessage;
  request.headers = { "x-mcode-reliability-token": token };
  request.method = "POST";
  request.url = "/__mcode/reliability";
  request.socket = { remoteAddress: "127.0.0.1" } as never;
  return request;
}

class ReadableRequest {
  readonly socket = { remoteAddress: "127.0.0.1" };
  private readonly body: string;

  constructor(body: string) {
    this.body = body;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    yield Buffer.from(this.body);
  }
}

function responseStub(): NodeHTTP.ServerResponse & { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  return {
    headersSent: false,
    writableEnded: false,
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as NodeHTTP.ServerResponse & { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
}
