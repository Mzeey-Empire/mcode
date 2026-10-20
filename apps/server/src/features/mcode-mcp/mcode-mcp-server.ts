import type * as NodeHTTP from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McodeSession, McodeSessionAuthority } from "./mcode-session-authority.js";
import type { BoundTool, BoundToolkit, McodeToolkit } from "./mcode-toolkit.js";

/** Loopback path of the per-session `mcode` MCP server. */
export const MCODE_MCP_PATH = "/mcp/mcode";

/** Largest request body the server reads, in bytes. */
export const MCODE_MCP_MAX_REQUEST_BYTES = 1_048_576;

const SERVER_VERSION = "0.1.0";
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{20,256})$/;
const MAX_TOOL_CALL_ID_LENGTH = 128;

/** Logger operations the server uses; tokens are never passed to it. */
export interface McodeMcpLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Dependencies for the per-session `mcode` MCP server. */
export interface McodeMcpServerOptions {
  authority: Pick<McodeSessionAuthority, "resolve">;
  toolkits: readonly McodeToolkit[];
  logger: McodeMcpLogger;
}

interface AdmittedRequest {
  session: McodeSession;
  body: unknown;
}

interface ActiveRequest {
  sessionId: string;
  res: NodeHTTP.ServerResponse;
  abort: AbortController;
  server: Server;
  transport: StreamableHTTPServerTransport;
}

type JsonRpcId = string | number;

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

function writeError(res: NodeHTTP.ServerResponse, status: number, code: number, message: string): void {
  const body = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function bearerToken(req: NodeHTTP.IncomingMessage): string | null {
  const value = req.headers.authorization;
  if (typeof value !== "string") return null;
  return BEARER_PATTERN.exec(value)?.[1] ?? null;
}

function contentLengthExceedsLimit(req: NodeHTTP.IncomingMessage): boolean {
  const value = req.headers["content-length"];
  if (value === undefined || !/^\d+$/.test(value)) return false;
  const length = Number(value);
  return !Number.isSafeInteger(length) || length > MCODE_MCP_MAX_REQUEST_BYTES;
}

async function readBoundedBody(req: NodeHTTP.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MCODE_MCP_MAX_REQUEST_BYTES) throw new RangeError("request-too-large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

/** Normalizes a JSON-RPC id into a tool call id of 1 to 128 characters, or undefined. */
function normalizeToolCallId(id: JsonRpcId): string | undefined {
  if (typeof id === "number") return Number.isSafeInteger(id) ? String(id) : undefined;
  return id.length > 0 && id.length <= MAX_TOOL_CALL_ID_LENGTH ? id : undefined;
}

function requestKey(sessionId: string, id: JsonRpcId): string {
  return JSON.stringify([sessionId, typeof id, id]);
}

function toolCallRequestId(body: unknown): JsonRpcId | undefined {
  if (!isRecord(body) || body.method !== "tools/call") return undefined;
  return isJsonRpcId(body.id) ? body.id : undefined;
}

function cancelledRequestId(body: unknown): JsonRpcId | undefined {
  if (!isRecord(body) || body.method !== "notifications/cancelled" || !isRecord(body.params)) return undefined;
  return isJsonRpcId(body.params.requestId) ? body.params.requestId : undefined;
}

function isCancellation(body: unknown): boolean {
  return isRecord(body) && body.method === "notifications/cancelled";
}

function listedTool(tool: BoundTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

/**
 * Serves one MCP endpoint per Mcode server, with a bearer token per Provider
 * session. Each request resolves the session, binds the toolkits it is granted
 * right now, and answers from a fresh stateless SDK server.
 */
export class McodeMcpServer {
  private readonly authority: McodeMcpServerOptions["authority"];
  private readonly toolkits: readonly McodeToolkit[];
  private readonly logger: McodeMcpLogger;
  private readonly active = new Set<ActiveRequest>();
  private readonly inFlightCalls = new Map<string, AbortController>();
  private port: number | undefined;
  private host = "127.0.0.1";

  constructor(options: McodeMcpServerOptions) {
    this.authority = options.authority;
    this.toolkits = options.toolkits;
    this.logger = options.logger;
  }

  /** Publishes the port the shared HTTP server bound; pass `[::1]` when it listens on IPv6 loopback. */
  setPort(port: number, host: "127.0.0.1" | "[::1]" = "127.0.0.1"): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return;
    this.port = port;
    this.host = host;
  }

  /** Returns the loopback URL providers connect to, or null before the server listens. */
  endpoint(): string | null {
    return this.port === undefined ? null : `http://${this.host}:${this.port}${MCODE_MCP_PATH}`;
  }

  /** Handles one HTTP request for {@link MCODE_MCP_PATH}. */
  async handle(req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse): Promise<void> {
    const admitted = await this.admit(req, res);
    if (!admitted) return;
    if (isCancellation(admitted.body)) {
      this.cancelCall(admitted);
      res.writeHead(202, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    await this.dispatch(req, res, admitted);
  }

  /** Aborts and closes every in-flight request of one session. */
  async closeSession(sessionId: string): Promise<void> {
    await this.closeRequests([...this.active].filter((request) => request.sessionId === sessionId));
  }

  /** Aborts and closes every in-flight request, for server shutdown. */
  async close(): Promise<void> {
    await this.closeRequests([...this.active]);
  }

  private async admit(req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse): Promise<AdmittedRequest | null> {
    const session = this.admitHeaders(req, res);
    if (!session) return null;
    const body = await this.readJson(req, res);
    return body.ok ? { session, body: body.value } : null;
  }

  private admitHeaders(req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse): McodeSession | null {
    if (!isLoopback(req.socket.remoteAddress)) {
      writeError(res, 403, -32003, "Forbidden");
      return null;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      writeError(res, 405, -32600, "Method not allowed");
      return null;
    }
    if (contentLengthExceedsLimit(req)) {
      writeError(res, 413, -32600, "Request body is too large");
      return null;
    }
    const token = bearerToken(req);
    const session = token ? this.authority.resolve(token) : null;
    if (!session) writeError(res, 401, -32001, "Unauthorized");
    return session;
  }

  private async readJson(
    req: NodeHTTP.IncomingMessage,
    res: NodeHTTP.ServerResponse,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> {
    let raw: Buffer;
    try {
      raw = await readBoundedBody(req);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      writeError(res, 413, -32600, "Request body is too large");
      return { ok: false };
    }
    try {
      return { ok: true, value: JSON.parse(raw.toString("utf8")) };
    } catch {
      writeError(res, 400, -32700, "Parse error");
      return { ok: false };
    }
  }

  /** Cancellation arrives as its own POST in stateless mode, so it is routed by session and id. */
  private cancelCall(admitted: AdmittedRequest): void {
    const id = cancelledRequestId(admitted.body);
    if (id === undefined) return;
    this.inFlightCalls.get(requestKey(admitted.session.sessionId, id))?.abort();
  }

  private async dispatch(
    req: NodeHTTP.IncomingMessage,
    res: NodeHTTP.ServerResponse,
    admitted: AdmittedRequest,
  ): Promise<void> {
    const abort = new AbortController();
    const server = this.createRequestServer(admitted.session, abort.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const request: ActiveRequest = { sessionId: admitted.session.sessionId, res, abort, server, transport };
    const callId = toolCallRequestId(admitted.body);
    const callKey = callId === undefined ? undefined : requestKey(admitted.session.sessionId, callId);
    // The SDK transport never settles once its stream is gone. Ending the request on socket close
    // lets the finally block close the transport, which aborts the call's handler signal.
    const closed = new Promise<void>((resolve) => res.once("close", () => resolve()));
    this.active.add(request);
    if (callKey !== undefined) this.inFlightCalls.set(callKey, abort);
    try {
      await server.connect(transport);
      await Promise.race([transport.handleRequest(req, res, admitted.body), closed]);
    } finally {
      this.active.delete(request);
      if (callKey !== undefined && this.inFlightCalls.get(callKey) === abort) this.inFlightCalls.delete(callKey);
      await this.closeQuietly(request);
    }
  }

  private async closeQuietly(request: ActiveRequest): Promise<void> {
    await request.transport.close().catch(() => undefined);
    await request.server.close().catch(() => undefined);
  }

  private async closeRequests(requests: readonly ActiveRequest[]): Promise<void> {
    for (const request of requests) request.abort.abort();
    await Promise.all(requests.map((request) => this.closeQuietly(request)));
    // Closing the transport drops its pending response, so the socket must be released explicitly.
    for (const request of requests) {
      if (!request.res.writableFinished) request.res.destroy();
    }
  }

  private createRequestServer(session: McodeSession, requestSignal: AbortSignal): Server {
    const bound = this.bindToolkits(session);
    const server = new Server(
      { name: "mcode", version: SERVER_VERSION },
      { capabilities: { tools: {} } },
    );
    const tools = bound.flatMap((toolkit) => toolkit.tools);
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: tools.filter((tool) => tool.listed).map(listedTool),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      const tool = tools.find((candidate) => candidate.name === request.params.name);
      if (!tool) throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
      return this.callTool(tool, request.params.arguments, extra.requestId, AbortSignal.any([extra.signal, requestSignal]));
    });
    return server;
  }

  private bindToolkits(session: McodeSession): BoundToolkit[] {
    return this.toolkits.flatMap((toolkit) => {
      const bound = toolkit.bind(session);
      return bound ? [bound] : [];
    });
  }

  private async callTool(
    tool: BoundTool,
    args: unknown,
    requestId: JsonRpcId,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const toolCallId = normalizeToolCallId(requestId);
    if (toolCallId === undefined) throw new McpError(ErrorCode.InvalidRequest, "Tool call id is invalid");
    try {
      return await tool.call(args, { toolCallId, signal });
    } catch (error) {
      if (!(error instanceof McpError)) {
        this.logger.error("Mcode MCP tool failed", { tool: tool.name, error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  }
}
