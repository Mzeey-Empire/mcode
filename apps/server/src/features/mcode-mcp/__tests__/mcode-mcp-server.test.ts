import * as NodeHTTP from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ThreadSendResultSchema,
  ThreadWaitResultSchema,
  type BrowserAutomationPublicOperation,
} from "@mcode/contracts";
import { MCODE_BROWSER_GUIDE } from "@mcode/thread-orchestration";
import { BrowserAutomationSessionLease } from "../../browser-automation/access/browser-automation-session-lease.js";
import type { BrowserAutomationPermissionCapability } from "../../browser-automation/access/credential-registry.js";
import {
  MCODE_MCP_MAX_REQUEST_BYTES,
  McodeMcpServer,
} from "../mcode-mcp-server.js";
import { McodeSessionAuthority } from "../mcode-session-authority.js";
import { BrowserToolkit, type BrowserToolkitOptions } from "../toolkits/browser-toolkit.js";
import { createThreadControlToolkit, type ThreadControlToolService } from "../toolkits/thread-control-toolkit.js";

interface SessionSpec {
  providerId: string;
  sessionId: string;
  threadId: string;
}

const SESSION_A: SessionSpec = { providerId: "claude", sessionId: "session-a", threadId: "thread-a" };
const SESSION_B: SessionSpec = { providerId: "cursor", sessionId: "session-b", threadId: "thread-b" };

interface RpcResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

const servers: NodeHTTP.Server[] = [];
const mcodeServers: McodeMcpServer[] = [];

afterEach(async () => {
  await Promise.all(mcodeServers.splice(0).map((mcode) => mcode.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultOf(response: RpcResponse): Record<string, unknown> {
  if (!isRecord(response.body) || !isRecord(response.body.result)) {
    throw new Error(`expected a JSON-RPC result, got ${JSON.stringify(response.body)}`);
  }
  return response.body.result;
}

function listedTools(response: RpcResponse): Array<Record<string, unknown>> {
  const tools = resultOf(response).tools;
  if (!Array.isArray(tools)) throw new Error("tools/list result has no tools array");
  return tools.filter(isRecord);
}

function toolNames(response: RpcResponse): unknown[] {
  return listedTools(response).map((tool) => tool.name);
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitUntilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

function createThreadService() {
  return {
    workspaceSearch: vi.fn<ThreadControlToolService["workspaceSearch"]>(),
    worktreeList: vi.fn<ThreadControlToolService["worktreeList"]>(),
    threadCreateBatch: vi.fn<ThreadControlToolService["threadCreateBatch"]>(),
    threadTargetList: vi.fn<ThreadControlToolService["threadTargetList"]>(),
    threadSearch: vi.fn<ThreadControlToolService["threadSearch"]>(),
    threadGet: vi.fn<ThreadControlToolService["threadGet"]>(),
    threadSend: vi.fn<ThreadControlToolService["threadSend"]>(),
    threadStop: vi.fn<ThreadControlToolService["threadStop"]>(),
    threadWait: vi.fn<ThreadControlToolService["threadWait"]>(),
  } satisfies ThreadControlToolService;
}

function createBrowserBroker() {
  return {
    execute: vi.fn<BrowserToolkitOptions["broker"]["execute"]>(),
    availableOperations: vi.fn<BrowserToolkitOptions["broker"]["availableOperations"]>(
      (claims) => claims.allowedOperations,
    ),
    cancelFromProvider: vi.fn<BrowserToolkitOptions["broker"]["cancelFromProvider"]>(() => false),
    recordMcpLifecycle: vi.fn<BrowserToolkitOptions["broker"]["recordMcpLifecycle"]>(),
  } satisfies BrowserToolkitOptions["broker"];
}

function createHarness() {
  const authority = new McodeSessionAuthority();
  const lease = new BrowserAutomationSessionLease({
    worktreeIdentity: "worktree-a",
  });
  const broker = createBrowserBroker();
  const service = createThreadService();
  const logger = { error: vi.fn<(message: string, meta?: Record<string, unknown>) => void>() };
  const mcode = new McodeMcpServer({
    authority,
    toolkits: [
      new BrowserToolkit({ lease, broker }),
      createThreadControlToolkit({ authority, service }),
    ],
    logger,
  });
  mcodeServers.push(mcode);

  function attach(spec: SessionSpec, options: { threadControl?: boolean } = {}): string {
    return authority.attach({ ...spec, threadControl: options.threadControl ?? true }).token;
  }

  function activateTurn(spec: SessionSpec): void {
    authority.activate({
      sessionId: spec.sessionId,
      sourceThreadId: spec.threadId,
      sourceTurnId: `${spec.threadId}-turn`,
      sourceProviderId: spec.providerId,
      permissionMode: "full",
    });
  }

  function grantBrowser(
    spec: SessionSpec,
    permissionCapability: BrowserAutomationPermissionCapability = "privileged",
    allowedOperations?: readonly BrowserAutomationPublicOperation[],
  ): void {
    const grant = lease.issue({
      providerId: spec.providerId,
      providerSessionId: `provider-${spec.sessionId}`,
      mcodeSessionId: spec.sessionId,
      threadId: spec.threadId,
      workspaceId: "workspace-a",
      permissionCapability,
      allowedOperations,
    });
    if (!grant) throw new Error("browser lease was not issued");
  }

  return { authority, lease, broker, service, logger, mcode, attach, activateTurn, grantBrowser };
}

type Harness = ReturnType<typeof createHarness>;

interface Listening {
  url: string;
  rpc(token: string | null, body: unknown, headers?: Record<string, string>): Promise<RpcResponse>;
  list(token: string | null): Promise<RpcResponse>;
  call(token: string, name: string, args?: unknown, id?: number | string): Promise<RpcResponse>;
}

async function listen(harness: Harness): Promise<Listening> {
  const server = NodeHTTP.createServer((req, res) => {
    // A test-only header stands in for a non-loopback peer, which a loopback client cannot be.
    const remote = req.headers["x-test-remote-address"];
    if (typeof remote === "string") Object.defineProperty(req.socket, "remoteAddress", { value: remote });
    void harness.mcode.handle(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  harness.mcode.setPort(address.port);
  const url = harness.mcode.endpoint();
  if (!url) throw new Error("server has no endpoint");

  async function rpc(token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<RpcResponse> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  }

  return {
    url,
    rpc,
    list: (token) => rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    call: (token, name, args = {}, id = 1) =>
      rpc(token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  };
}

describe("McodeMcpServer admission", () => {
  it("refuses a non-loopback peer before reading the bearer", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    const { rpc } = await listen(harness);

    const response = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "x-test-remote-address": "203.0.113.9" });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: -32003 } });
  });

  it("allows only POST", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    const { url } = await listen(harness);

    const response = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("refuses a declared body over the limit without reading it", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    const { url } = await listen(harness);

    const status = await new Promise<number>((resolve, reject) => {
      const request = NodeHTTP.request(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(MCODE_MCP_MAX_REQUEST_BYTES + 1),
        },
      }, (response) => {
        resolve(response.statusCode ?? 0);
        request.destroy();
      });
      request.on("error", reject);
      request.flushHeaders();
    });

    expect(status).toBe(413);
  });

  it("refuses a streamed body that grows past the limit", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    const { url } = await listen(harness);

    const status = await new Promise<number>((resolve, reject) => {
      const request = NodeHTTP.request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      }, (response) => resolve(response.statusCode ?? 0));
      request.on("error", reject);
      request.write(Buffer.alloc(MCODE_MCP_MAX_REQUEST_BYTES + 1, 0x20));
    });

    expect(status).toBe(413);
  });

  it.each([
    ["no bearer", null],
    ["an unknown bearer", "A".repeat(43)],
    ["a malformed bearer", "short"],
  ])("answers 401 for %s", async (_label, token) => {
    const harness = createHarness();
    harness.attach(SESSION_A);
    const { list } = await listen(harness);

    const response = await list(token);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: -32001 } });
  });

  it("answers 401 for a token whose session has not been attached", async () => {
    const harness = createHarness();
    const { credential: token } = harness.authority.activate({
      sessionId: "unattached",
      sourceThreadId: "thread-x",
      sourceTurnId: "turn-x",
      sourceProviderId: "claude",
      permissionMode: "full",
    });
    const { list } = await listen(harness);

    expect((await list(token)).status).toBe(401);
  });

  it("answers 400 for a body that is not JSON", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    const { rpc } = await listen(harness);

    const response = await rpc(token, "{not json");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: -32700 } });
  });

  it("stops honoring a token after the session retires with an active turn", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    harness.activateTurn(SESSION_A);
    const { list } = await listen(harness);
    expect((await list(token)).status).toBe(200);

    harness.authority.retire(SESSION_A.sessionId);

    expect((await list(token)).status).toBe(401);
  });

  it("stops honoring a token after the session closes", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    const { list } = await listen(harness);
    expect((await list(token)).status).toBe(200);

    harness.authority.close(SESSION_A.sessionId);

    expect((await list(token)).status).toBe(401);
  });

  it("serves two sequential requests on one session", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    harness.activateTurn(SESSION_A);
    const { list } = await listen(harness);

    const first = await list(token);
    const second = await list(token);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(toolNames(second)).toEqual(toolNames(first));
  });
});

describe("McodeMcpServer sessions", () => {
  it("keeps one session's Browser lease and thread identity away from another", async () => {
    const harness = createHarness();
    const tokenA = harness.attach(SESSION_A);
    const tokenB = harness.attach(SESSION_B);
    harness.activateTurn(SESSION_A);
    harness.activateTurn(SESSION_B);
    harness.grantBrowser(SESSION_B);
    harness.service.threadSend.mockResolvedValue(ThreadSendResultSchema().parse({
      status: "rejected",
      workspaceId: "workspace-1",
      threadId: "destination",
      error: { code: "thread_busy", message: "Busy", retryable: true },
    }));
    const { list, call } = await listen(harness);

    const listedA = toolNames(await list(tokenA));
    const listedB = toolNames(await list(tokenB));
    const browserCall = await call(tokenA, "browser_inspect");
    await call(tokenA, "thread_send", { threadId: "destination", message: "from a" }, "send-a");
    await call(tokenB, "thread_send", { threadId: "destination", message: "from b" }, "send-b");

    expect(listedA.filter((name) => String(name).startsWith("browser_"))).toEqual([]);
    expect(listedB).toContain("browser_inspect");
    expect(browserCall.body).toMatchObject({ error: { message: expect.stringContaining("Tool browser_inspect not found") } });
    expect(harness.broker.execute).not.toHaveBeenCalled();
    expect(harness.service.threadSend).toHaveBeenNthCalledWith(1, expect.objectContaining({ sourceThreadId: "thread-a", sourceToolCallId: "send-a" }), expect.anything());
    expect(harness.service.threadSend).toHaveBeenNthCalledWith(2, expect.objectContaining({ sourceThreadId: "thread-b", sourceToolCallId: "send-b" }), expect.anything());
  });

  it("offers the Browser guide as initialize instructions only to a session that may inspect", async () => {
    const harness = createHarness();
    const tokenA = harness.attach(SESSION_A);
    const tokenB = harness.attach(SESSION_B);
    harness.grantBrowser(SESSION_B);
    const { rpc } = await listen(harness);
    const initialize = (token: string) => rpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });

    expect(resultOf(await initialize(tokenA)).instructions).toBeUndefined();
    expect(resultOf(await initialize(tokenB)).instructions).toBe(MCODE_BROWSER_GUIDE);
  });

  it.each(["2024-11-05", "2025-03-26"])("negotiates MCP protocol version %s", async (protocolVersion) => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    const { rpc } = await listen(harness);

    const response = await rpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });

    expect(resultOf(response).protocolVersion).toBe(protocolVersion);
  });

  it("lists Browser tools by the credential's capability and refuses what it does not allow", async () => {
    const harness = createHarness();
    const observe = harness.attach(SESSION_A, { threadControl: false });
    const interact = harness.attach(SESSION_B, { threadControl: false });
    harness.grantBrowser(SESSION_A, "observe");
    harness.grantBrowser(SESSION_B, "interact");
    const { list, call } = await listen(harness);

    expect(toolNames(await list(observe))).toEqual(["browser_inspect"]);
    expect(toolNames(await list(interact))).not.toContain("browser_evaluate");
    const refused = await call(interact, "browser_evaluate", { expression: "1" });

    expect(refused.body).toMatchObject({ error: { code: -32003, message: expect.stringContaining("forbidden") } });
    expect(harness.broker.execute).not.toHaveBeenCalled();
  });

  it("lists browser_evaluate for a privileged credential", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A, { threadControl: false });
    harness.grantBrowser(SESSION_A, "privileged");
    const { list } = await listen(harness);

    expect(toolNames(await list(token))).toContain("browser_evaluate");
  });

  it("lists browser_tabs without a top-level oneOf, anyOf, or allOf", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A, { threadControl: false });
    harness.grantBrowser(SESSION_A);
    const { list } = await listen(harness);

    const tabs = listedTools(await list(token)).find((tool) => tool.name === "browser_tabs");

    expect(tabs).toBeDefined();
    expect(tabs?.inputSchema).not.toHaveProperty("oneOf");
    expect(tabs?.inputSchema).not.toHaveProperty("anyOf");
    expect(tabs?.inputSchema).not.toHaveProperty("allOf");
  });

  it("answers an unknown tool with InvalidParams", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    harness.activateTurn(SESSION_A);
    const { call } = await listen(harness);

    const response = await call(token, "no_such_tool");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ error: { code: -32602, message: expect.stringContaining("Tool no_such_tool not found") } });
  });

  it("rejects a tool call id that cannot become a bounded string", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    harness.activateTurn(SESSION_A);
    const { call } = await listen(harness);

    const response = await call(token, "workspace_search", {}, "x".repeat(129));

    expect(response.body).toMatchObject({ error: { code: -32600, message: expect.stringContaining("Tool call id is invalid") } });
    expect(harness.service.workspaceSearch).not.toHaveBeenCalled();
  });

  it("passes the JSON-RPC request id to the tool as its call id", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    harness.activateTurn(SESSION_A);
    harness.service.workspaceSearch.mockReturnValue({ workspaces: [] });
    const { call } = await listen(harness);

    await call(token, "workspace_search", {}, 42);

    expect(harness.service.workspaceSearch).toHaveBeenCalledWith(
      expect.objectContaining({ sourceToolCallId: "42" }),
      expect.anything(),
    );
  });
});

describe("McodeMcpServer cancellation", () => {
  async function startPendingWait(harness: Harness, token: string, id: number | string) {
    const started = deferred<AbortSignal | undefined>();
    harness.service.threadWait.mockImplementation(async (_authority, _input, signal) => {
      started.resolve(signal);
      await waitUntilAborted(signal);
      return ThreadWaitResultSchema().parse({ status: "success", timedOut: true, results: [] });
    });
    const listening = await listen(harness);
    const response = listening.call(token, "thread_wait", { threadIds: ["destination"], timeoutSeconds: 10 }, id);
    return { listening, response, signal: await started.promise };
  }

  it("aborts a browser call and cancels the broker request when the client disconnects", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A, { threadControl: false });
    harness.grantBrowser(SESSION_A);
    const executing = deferred();
    const cancelled = deferred();
    harness.broker.execute.mockImplementation(async () => {
      executing.resolve();
      await cancelled.promise;
      throw new Error("cancelled by test");
    });
    harness.broker.cancelFromProvider.mockImplementation(() => {
      cancelled.resolve();
      return true;
    });
    const { url } = await listen(harness);
    const client = new AbortController();

    const request = fetch(url, {
      method: "POST",
      signal: client.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "browser_inspect", arguments: {} } }),
    }).catch(() => undefined);
    await executing.promise;
    client.abort();
    await cancelled.promise;
    await request;

    expect(harness.broker.cancelFromProvider).toHaveBeenCalledTimes(1);
  });

  it("aborts the matching in-flight call when a cancelled notification arrives", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    harness.activateTurn(SESSION_A);
    const { listening, response, signal } = await startPendingWait(harness, token, 9);
    expect(signal?.aborted).toBe(false);

    const notification = await listening.rpc(token, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 9 },
    });
    await response;

    expect(notification.status).toBe(202);
    expect(signal?.aborted).toBe(true);
  });

  it("ignores a cancelled notification from another session or for another id", async () => {
    const harness = createHarness();
    const tokenA = harness.attach(SESSION_A);
    const tokenB = harness.attach(SESSION_B);
    harness.activateTurn(SESSION_A);
    const { listening, response, signal } = await startPendingWait(harness, tokenA, 9);

    await listening.rpc(tokenB, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
    await listening.rpc(tokenA, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "9" } });

    expect(signal?.aborted).toBe(false);
    harness.authority.revoke(SESSION_A.sessionId);
    await response;
  });

  it("aborts in-flight calls when the Provider session closes", async () => {
    const harness = createHarness();
    const token = harness.attach(SESSION_A);
    harness.activateTurn(SESSION_A);
    const { response, signal } = await startPendingWait(harness, token, 3);

    await harness.mcode.closeSession(SESSION_A.sessionId);
    await response.catch(() => undefined);

    expect(signal?.aborted).toBe(true);
  });
});
