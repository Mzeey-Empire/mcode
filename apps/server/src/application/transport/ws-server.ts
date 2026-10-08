/**
 * HTTP + WebSocket server setup.
 * Creates an HTTP server for health checks and attachment serving,
 * and a WebSocket server on the same port for RPC + push events.
 */

import * as NodeHTTP from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "@mcode/shared";
import {
  type DisconnectedTerminalCreate,
} from "../../features/terminal/backends/terminal-backend.js";
import {
  BinaryUploadHeaderSchema,
  WebSocketRequestSchema,
  WS_METHODS,
  type BinaryUploadHeader,
  type WebSocketResponse,
} from "@mcode/contracts";
import { routeMessage, type RouterDeps } from "./ws-router.js";
import { addClient, removeClient } from "./push.js";
import { handleBinaryUpload } from "../../features/attachments/transport/binary-upload.js";
import * as NodeCrypto from "node:crypto";
import { extractToken, buildAuthCookie } from "./auth.js";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { getMcodeDir } from "@mcode/shared";
import type {
  BrowserAutomationHostConnectionAuthorization,
  BrowserAutomationMcpHandler,
} from "../../features/browser-automation/index.js";
import { EXTERNAL_THREAD_CONTROL_MCP_PATH } from "../../features/thread-control/index.js";
import type { ReliabilityHarnessAdapter } from "../../runtime/reliability-harness/control.js";
import type { ExecutionMailboxDepth } from "../../features/agents/execution/execution-mailbox-scheduler.js";

/** Constant-time string comparison to prevent timing attacks on token validation. */
function safeTokenEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return NodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Match stored thread IDs used for the custom attachment protocol (UUID, lowercase hex). */
const ATTACHMENT_THREAD_SEGMENT = /^[a-f0-9-]+$/;
/** Filename is `{attachmentUuid}.{ext}` under the thread directory. */
const ATTACHMENT_FILE_SEGMENT = /^[a-f0-9-]+\.\w+$/;

/** Extension to MIME for persisted attachment files (aligned with desktop shell protocol). */
const ATTACHMENT_EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  rtf: "application/rtf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

export type WsServerDeps = RouterDeps & {
  authToken: string;
  singleInstance?: boolean;
  instanceToken?: string | null;
  worktreeIdentity?: string | null;
  shutdown: () => void;
  /** Handles the loopback-only browser MCP route when the feature is enabled. */
  browserAutomationMcpHandler?: BrowserAutomationMcpHandler;
  /** Optional opt-in packaged reliability controls. */
  reliabilityHarness?: ReliabilityHarnessAdapter;
  /** Content-free counts for active execution worker queues. */
  workerQueueDepth?: () => ExecutionMailboxDepth;
};

/** Refreshes mutable workspace authorization while preserving one connection's desktop identity. */
export function refreshBrowserAutomationHostAuthorization(
  current: BrowserAutomationHostConnectionAuthorization | null,
  stableDesktopInstanceId: string | null,
): BrowserAutomationHostConnectionAuthorization | null {
  if (!current) return null;
  return {
    ...current,
    desktopInstanceId: stableDesktopInstanceId ?? current.desktopInstanceId,
    allowedWorkspaceIds: [...current.allowedWorkspaceIds],
  };
}

type InstanceCheckResult =
  | { ok: true }
  | { ok: false; code: "WRONG_INSTANCE"; expectedWorktree: string | null; presentedWorktree: string | null };

type InstanceAttachmentExpectation = Pick<WsServerDeps, "singleInstance" | "authToken" | "instanceToken" | "worktreeIdentity">;

interface WsMessageContext {
  readonly ws: WebSocket;
  readonly deps: WsServerDeps;
  readonly resolveCurrentBrowserAutomationAuthorization: () => BrowserAutomationHostConnectionAuthorization | null;
  readonly admission: RequestAdmission;
  pendingBinaryHeader: BinaryUploadHeader | null;
}

class RequestAdmission {
  private accepting = true;
  private readonly pending = new Set<Promise<void>>();

  run(handler: () => Promise<void>): boolean {
    if (!this.accepting) return false;
    const task = Promise.resolve().then(handler).catch((error: unknown) => {
      logger.error("Admitted transport request failed", { error: describeError(error) });
    }).finally(() => this.pending.delete(task));
    this.pending.add(task);
    return true;
  }

  async stopAdmissionAndDrain(): Promise<void> {
    this.accepting = false;
    await Promise.all(this.pending);
  }
}

/** Query parameters used by browser clients to prove they target this dev instance. */
export const INSTANCE_TOKEN_QUERY_PARAM = "instanceToken";
export const WORKTREE_QUERY_PARAM = "worktree";

/** Validates the single-instance token and worktree identity from a WebSocket request. */
export function validateInstanceAttachment(
  req: NodeHTTP.IncomingMessage,
  expected: InstanceAttachmentExpectation,
): InstanceCheckResult {
  if (!expected.singleInstance) return { ok: true };

  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const presentedInstanceToken = parsedUrl.searchParams.get(INSTANCE_TOKEN_QUERY_PARAM);
  const presentedWorktree = parsedUrl.searchParams.get(WORKTREE_QUERY_PARAM);
  const presentedAuthToken = extractToken(req);

  if (matchesInstanceAttachment(presentedAuthToken, presentedInstanceToken, presentedWorktree, expected)) return { ok: true };

  return {
    ok: false,
    code: "WRONG_INSTANCE",
    expectedWorktree: expected.worktreeIdentity ?? null,
    presentedWorktree,
  };
}

/** Checks every token and worktree value that identifies a single dev instance. */
function matchesInstanceAttachment(
  presentedAuthToken: string | null | undefined,
  presentedInstanceToken: string | null,
  presentedWorktree: string | null,
  expected: InstanceAttachmentExpectation,
): boolean {
  return matchesAuthToken(presentedAuthToken, expected.authToken)
    && matchesInstanceToken(presentedInstanceToken, expected.instanceToken)
    && matchesWorktreeIdentity(presentedWorktree, expected.worktreeIdentity);
}

/** Checks the regular authenticated connection token. */
function matchesAuthToken(presented: string | null | undefined, expected: string): boolean {
  return typeof presented === "string" && safeTokenEqual(presented, expected);
}

/** Checks the per-instance attachment token. */
function matchesInstanceToken(presented: string | null, expected: string | null | undefined): boolean {
  return typeof presented === "string" && typeof expected === "string" && safeTokenEqual(presented, expected);
}

/** Checks the worktree identity that belongs to the instance token. */
function matchesWorktreeIdentity(presented: string | null, expected: string | null | undefined): boolean {
  return typeof presented === "string" && typeof expected === "string" && presented === expected;
}

/** Create and configure the HTTP + WebSocket server. */
export function createWsServer(deps: WsServerDeps): {
  httpServer: NodeHTTP.Server;
  wss: WebSocketServer;
  /** Refuses new routed requests and waits for admitted handlers and Terminal cleanup. */
  stopAdmissionAndDrain(): Promise<void>;
} {
  const admission = new RequestAdmission();
  let wss: WebSocketServer;
  const httpServer = NodeHTTP.createServer((req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse) => {
    const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
    if (handleSpecialHttpRequest(req, res, requestPath, deps, wss, admission)) return;
    if (handleHealthRequest(req, res, deps)) return;
    if (handleShutdownRequest(req, res, deps)) return;
    if (handleAttachmentRequest(req, res, deps)) return;

    res.writeHead(404);
    res.end("Not found");
  });

  wss = new WebSocketServer({
    server: httpServer,
    maxPayload: 45 * 1024 * 1024,
    perMessageDeflate: {
      zlibDeflateOptions: { level: 6 },
      // Only compress messages larger than 1 KB to avoid CPU overhead on
      // small streaming delta events during active agent turns
      threshold: 1024,
      // Context takeover disabled server-side so the threshold check is
      // actually applied by the ws library (threshold is a no-op when
      // context takeover is enabled).
      clientNoContextTakeover: false,
      serverNoContextTakeover: true,
    },
  });

  // The ws library forwards httpServer 'error' events to wss via
  // `error: this.emit.bind(this, 'error')`. Without this listener, an
  // EADDRINUSE on httpServer would crash the process before listen()'s
  // EADDRINUSE retry handler in index.ts has a chance to run.
  wss.on("error", (err) => {
    logger.error("WebSocketServer error", {
      error: (err as NodeJS.ErrnoException).message,
      code: (err as NodeJS.ErrnoException).code,
      stack: (err as Error).stack,
    });
  });

  wss.on("connection", (ws: WebSocket, req: NodeHTTP.IncomingMessage) => {
    const instanceCheck = validateInstanceAttachment(req, deps);
    if (!instanceCheck.ok) {
      logger.warn("WebSocket connection rejected: wrong dev instance", {
        code: instanceCheck.code,
        expectedWorktree: instanceCheck.expectedWorktree,
        presentedWorktree: instanceCheck.presentedWorktree,
      });
      ws.send(JSON.stringify({
        type: "refusal",
        error: {
          code: instanceCheck.code,
          expectedWorktree: instanceCheck.expectedWorktree,
          presentedWorktree: instanceCheck.presentedWorktree,
        },
      }));
      ws.close(4001, instanceCheck.code);
      return;
    }

    const token = extractToken(req);
    if (!token || !safeTokenEqual(token, deps.authToken)) {
      logger.warn("WebSocket connection rejected: invalid token");
      ws.close(4001, "Unauthorized");
      return;
    }

    logger.info("WebSocket client connected");
    addClient(ws);
    let browserAutomationDesktopInstanceId: string | null = null;

    const resolveCurrentBrowserAutomationAuthorization = (): ReturnType<WsServerDeps["resolveBrowserAutomationHostAuthorization"]> => {
      try {
        const current = deps.resolveBrowserAutomationHostAuthorization(req);
        if (!current) return null;
        browserAutomationDesktopInstanceId ??= current.desktopInstanceId;
        return refreshBrowserAutomationHostAuthorization(current, browserAutomationDesktopInstanceId);
      } catch (error) {
        logger.warn("Browser automation host authorization could not be derived", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };

    const messageContext: WsMessageContext = {
      ws,
      deps,
      resolveCurrentBrowserAutomationAuthorization,
      admission,
      pendingBinaryHeader: null,
    };

    ws.on("message", (data: Buffer | string, isBinary: boolean) => handleWsMessage(data, isBinary, messageContext));

    ws.on("close", () => {
      logger.info("WebSocket client disconnected");
      deps.browserAutomationBroker?.disconnect(ws);
      deps.terminalService.disconnectClient(ws);
      removeClient(ws);
    });

    ws.on("error", (err) => {
      logger.error("WebSocket error", { error: err.message });
      deps.browserAutomationBroker?.disconnect(ws);
      deps.terminalService.disconnectClient(ws);
      removeClient(ws);
    });
  });

  return { httpServer, wss, stopAdmissionAndDrain: () => admission.stopAdmissionAndDrain() };
}

/** Routes authenticated HTTP endpoints that require an asynchronous handler. */
function handleSpecialHttpRequest(
  req: NodeHTTP.IncomingMessage,
  res: NodeHTTP.ServerResponse,
  requestPath: string,
  deps: WsServerDeps,
  wss: WebSocketServer,
  admission: RequestAdmission,
): boolean {
  if (requestPath === "/__mcode/reliability" && deps.reliabilityHarness?.enabled) {
    const harness = deps.reliabilityHarness;
    admitHttpRequest(res, admission, () => handleReliabilityRequest(req, res, harness, wss));
    return true;
  }
  if (requestPath === "/mcp" && deps.browserAutomationMcpHandler) {
    const handler = deps.browserAutomationMcpHandler;
    admitHttpRequest(res, admission, () => handleBrowserAutomationMcpRequest(req, res, handler));
    return true;
  }
  if (requestPath === EXTERNAL_THREAD_CONTROL_MCP_PATH && deps.externalThreadControlMcpRuntime) {
    const runtime = deps.externalThreadControlMcpRuntime;
    admitHttpRequest(res, admission, () => handleThreadControlMcpRequest(req, res, runtime));
    return true;
  }
  return false;
}

function admitHttpRequest(res: NodeHTTP.ServerResponse, admission: RequestAdmission, handler: () => Promise<void>): void {
  if (admission.run(handler)) return;
  sendHttpFailure(res, 503, "Server is shutting down");
}

function sendHttpFailure(res: NodeHTTP.ServerResponse, status: number, body: string, headers?: NodeHTTP.OutgoingHttpHeaders): void {
  if (res.destroyed || res.writableEnded) return;
  try {
    if (!res.headersSent) res.writeHead(status, headers);
    res.end(body);
  } catch (error) {
    logger.warn("HTTP failure response send failed", { error: describeError(error) });
    res.destroy();
  }
}

/** Starts a reliability control request and returns its existing failure response. */
async function handleReliabilityRequest(
  req: NodeHTTP.IncomingMessage,
  res: NodeHTTP.ServerResponse,
  reliabilityHarness: NonNullable<WsServerDeps["reliabilityHarness"]>,
  wss: WebSocketServer,
): Promise<void> {
  try {
    await reliabilityHarness.handleRequest(req, res, wss.clients);
  } catch (error) {
    logger.error("Reliability harness request failed", { error: describeError(error) });
    sendHttpFailure(res, 500, "Reliability harness failure");
  }
}

/** Starts a browser MCP request and returns its JSON-RPC failure response when required. */
async function handleBrowserAutomationMcpRequest(
  req: NodeHTTP.IncomingMessage,
  res: NodeHTTP.ServerResponse,
  handler: BrowserAutomationMcpHandler,
): Promise<void> {
  try {
    await handler.handle(req, res);
  } catch (error) {
    logger.error("Browser automation MCP request failed", { error: describeError(error) });
    sendHttpFailure(res, 500, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }),
      { "Content-Type": "application/json", "Cache-Control": "no-store" });
  }
}

/** Starts an external thread-control MCP request and returns its failure response when required. */
async function handleThreadControlMcpRequest(
  req: NodeHTTP.IncomingMessage,
  res: NodeHTTP.ServerResponse,
  runtime: NonNullable<WsServerDeps["externalThreadControlMcpRuntime"]>,
): Promise<void> {
  try {
    await runtime.handleRequest(req, res);
  } catch (error) {
    logger.error("External thread-control MCP request failed", { error: describeError(error) });
    sendHttpFailure(res, 500, "");
  }
}

/** Serves the server health endpoint. */
function handleHealthRequest(req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse, deps: WsServerDeps): boolean {
  if (req.method !== "GET" || !req.url?.startsWith("/health")) return false;
  const body = createHealthBody(deps);
  const headers = createHealthHeaders(deps);
  res.writeHead(200, headers);
  res.end(JSON.stringify(body));
  return true;
}

/** Creates the health response body for the current server state. */
function createHealthBody(deps: WsServerDeps): Record<string, unknown> {
  const body: Record<string, unknown> = {
    status: "ok",
    activeAgents: deps.agentService.runtimeAccess().activeCount(),
  };
  if (deps.browserAutomationBroker) {
    body.browserAutomation = {
      ...deps.browserAutomationBroker.status(),
      reliability: deps.browserAutomationBroker.reliabilityStatus(),
      nightlyEvidence: deps.browserAutomationBroker.nightlyEvidenceStatus(),
    };
  }
  if (deps.workerQueueDepth) body.workerQueue = deps.workerQueueDepth();
  if (!deps.singleInstance) body.authToken = deps.authToken;
  return body;
}

/** Creates the health response headers for the current server mode. */
function createHealthHeaders(deps: WsServerDeps): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!deps.singleInstance) headers["Set-Cookie"] = buildAuthCookie(deps.authToken);
  return headers;
}

/** Serves the authenticated shutdown endpoint. */
function handleShutdownRequest(req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse, deps: WsServerDeps): boolean {
  if (req.method !== "POST" || req.url !== "/shutdown") return false;
  if (!matchesAuthToken(extractToken(req), deps.authToken)) {
    res.writeHead(401);
    res.end("Unauthorized");
    return true;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "shutting_down" }), () => deps.shutdown());
  return true;
}

/** Serves an authenticated attachment request after path validation. */
function handleAttachmentRequest(req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse, deps: WsServerDeps): boolean {
  if (req.method !== "GET" || !req.url?.startsWith("/attachments/")) return false;
  if (!matchesAuthToken(extractToken(req), deps.authToken)) {
    res.writeHead(401);
    res.end("Unauthorized");
    return true;
  }
  const attachment = parseAttachmentRequest(req, res);
  if (!attachment) return true;
  serveAttachment(attachment.threadId, attachment.filename, res);
  return true;
}

/** Parses and validates attachment path segments. */
function parseAttachmentRequest(req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse): { threadId: string; filename: string } | null {
  const segments = new URL(req.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "attachments") {
    res.writeHead(404);
    res.end("Not found");
    return null;
  }
  const [_, threadId, filename] = segments;
  if (!ATTACHMENT_THREAD_SEGMENT.test(threadId!) || !ATTACHMENT_FILE_SEGMENT.test(filename!)) {
    res.writeHead(400);
    res.end("Invalid path");
    return null;
  }
  return { threadId: threadId!, filename: filename! };
}

/** Streams one validated attachment file to the HTTP response. */
function serveAttachment(threadId: string, filename: string, res: NodeHTTP.ServerResponse): void {
  const filePath = NodePath.join(getMcodeDir(), "attachments", threadId, filename);
  if (!NodeFS.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = filename.split(".").pop() ?? "";
  const stream = NodeFS.createReadStream(filePath);
  stream.on("error", () => handleAttachmentStreamError(res));
  res.writeHead(200, {
    "Content-Type": ATTACHMENT_EXT_MIME[ext] ?? "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Security-Policy": "default-src 'none'",
  });
  stream.pipe(res);
}

/** Sends the attachment read failure response unless streaming already began. */
function handleAttachmentStreamError(res: NodeHTTP.ServerResponse): void {
  if (!res.headersSent) res.writeHead(404);
  res.end();
}

/** Formats unknown thrown values for log metadata. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Routes one WebSocket frame to terminal upload handling or JSON-RPC. */
function handleWsMessage(data: Buffer | string, isBinary: boolean, context: WsMessageContext): void {
  const admitted = context.admission.run(async () => {
    if (isBinary) {
      await handleBinaryWsMessage(Buffer.isBuffer(data) ? data : Buffer.from(data), context);
      return;
    }
    await handleTextWsMessage(typeof data === "string" ? data : data.toString("utf-8"), context);
  });
  if (admitted) return;
  rejectWsMessage(data, isBinary, context);
}

function rejectWsMessage(data: Buffer | string, isBinary: boolean, context: WsMessageContext): void {
  if (isBinary) {
    const header = context.pendingBinaryHeader;
    context.pendingBinaryHeader = null;
    if (header) sendShutdownResponse(context.ws, header.id);
    else context.ws.close(1012, "Server is shutting down");
    return;
  }
  const raw = typeof data === "string" ? data : data.toString("utf-8");
  const header = parseBinaryUploadHeader(raw);
  sendShutdownResponse(context.ws, header?.id ?? parseWsRequestId(raw));
}

function parseWsRequestId(raw: string): string {
  try {
    const request = WebSocketRequestSchema().safeParse(JSON.parse(raw));
    return request.success ? request.data.id : "unknown";
  } catch {
    return "unknown";
  }
}

function sendShutdownResponse(ws: WebSocket, id: string | number | null): void {
  sendWsJson(ws, { id, error: { code: "SERVER_SHUTTING_DOWN", message: "Server is shutting down" } });
}

/** Routes a binary terminal frame or a binary file-upload frame. */
async function handleBinaryWsMessage(bytes: Buffer, context: WsMessageContext): Promise<void> {
  const header = context.pendingBinaryHeader;
  context.pendingBinaryHeader = null;
  if (!header) {
    logger.warn("Received binary frame with no pending upload header");
    return;
  }
  await handleFileUploadFrame(header, bytes, context.ws);
}

/** Handles a clipboard file-upload frame after its text header. */
async function handleFileUploadFrame(header: BinaryUploadHeader, bytes: Buffer, ws: WebSocket): Promise<void> {
  if (header.method !== "clipboard.saveFile") {
    logger.warn("Unsupported binary upload method", { method: header.method });
    sendWsJson(ws, {
      id: header.id,
      error: { code: "UNSUPPORTED_METHOD", message: `Binary upload not supported for method: ${header.method}` },
    });
    return;
  }
  const metadata = readUploadMetadata(header);
  if (!metadata) {
    logger.warn("Binary upload header missing required meta fields");
    sendWsJson(ws, {
      id: header.id,
      error: { code: "INVALID_UPLOAD", message: "meta.mimeType and meta.fileName are required strings" },
    });
    return;
  }
  try {
    const result = await handleBinaryUpload(metadata, bytes);
    sendWsJson(ws, { id: header.id, result });
  } catch (error) {
    handleFileUploadFailure(header.id, error, ws);
  }
}

/** Reads the required file-upload metadata from an upload header. */
function readUploadMetadata(header: BinaryUploadHeader): { mimeType: string; fileName: string } | null {
  const { mimeType, fileName } = header.meta;
  if (typeof mimeType !== "string" || !mimeType || typeof fileName !== "string" || !fileName) return null;
  return { mimeType, fileName };
}

/** Reports a binary upload failure to the initiating WebSocket client. */
function handleFileUploadFailure(id: string | number | null, error: unknown, ws: WebSocket): void {
  const message = describeError(error);
  logger.error("Binary upload failed", { error: message });
  sendWsJson(ws, { id, error: { code: "UPLOAD_FAILED", message } });
}

/** Sends JSON only while the WebSocket remains open. Returns whether delivery was accepted for sending. */
function sendWsJson(
  ws: WebSocket,
  value: unknown,
  onSendComplete?: (error?: Error) => void,
): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    const payload = JSON.stringify(value);
    if (onSendComplete) ws.send(payload, onSendComplete);
    else ws.send(payload);
    return true;
  } catch (error) {
    logger.warn("WebSocket response send failed", { error: describeError(error) });
    return false;
  }
}

/** Routes a text upload header or a regular JSON-RPC message. */
async function handleTextWsMessage(raw: string, context: WsMessageContext): Promise<void> {
  const header = parseBinaryUploadHeader(raw);
  if (header) {
    replacePendingUploadHeader(header, context);
    return;
  }
  await routeWsMessage(raw, context);
}

/** Parses a text frame as a binary-upload header. */
function parseBinaryUploadHeader(raw: string): BinaryUploadHeader | null {
  try {
    const headerResult = BinaryUploadHeaderSchema().safeParse(JSON.parse(raw));
    return headerResult.success ? headerResult.data : null;
  } catch {
    return null;
  }
}

/** Replaces a pending upload header and reports the abandoned upload. */
function replacePendingUploadHeader(header: BinaryUploadHeader, context: WsMessageContext): void {
  const previous = context.pendingBinaryHeader;
  if (previous) {
    logger.warn("Binary upload header overwritten; previous upload abandoned", { staleId: previous.id });
    sendWsJson(context.ws, {
      id: previous.id,
      error: { code: "UPLOAD_ABANDONED", message: "Upload header was overwritten by a subsequent upload" },
    });
  }
  context.pendingBinaryHeader = header;
}

/** Routes a regular JSON-RPC frame and returns its response to the same client. */
async function routeWsMessage(raw: string, context: WsMessageContext): Promise<void> {
  const terminalCreateMethod = parseTerminalCreateMethod(raw);
  const response = await routeMessage(raw, context.deps, {
    client: context.ws,
    browserAutomationAuthorization: context.resolveCurrentBrowserAutomationAuthorization(),
  });
  await sendWsResponse(terminalCreateMethod, response, context);
}

type TerminalCreateMethod = DisconnectedTerminalCreate["method"];

/** Reads the only create methods that may allocate a Terminal resource. */
function parseTerminalCreateMethod(raw: string): TerminalCreateMethod | null {
  try {
    const parsed = WebSocketRequestSchema().safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return isTerminalCreateMethod(parsed.data.method) ? parsed.data.method : null;
  } catch {
    return null;
  }
}

function isTerminalCreateMethod(method: string): method is TerminalCreateMethod {
  return method === "terminal.create";
}

/** Delivers an RPC response and reclaims a Terminal create only when response delivery fails. */
async function sendWsResponse(
  method: TerminalCreateMethod | null,
  response: WebSocketResponse,
  context: WsMessageContext,
): Promise<void> {
  if (!method) {
    sendWsJson(context.ws, response);
    return;
  }
  const create = disconnectedTerminalCreateFromResponse(method, response);
  if (!create) {
    sendWsJson(context.ws, response);
    return;
  }
  const delivered = await new Promise<boolean>((resolve) => {
    const accepted = sendWsJson(context.ws, response, (error) => resolve(!error));
    if (!accepted) resolve(false);
  });
  if (!delivered) await cleanupDisconnectedTerminalCreate(create, context);
}

/** Closes a Terminal resource that was created for a response the client did not receive. */
async function cleanupDisconnectedTerminalCreate(
  create: DisconnectedTerminalCreate,
  context: WsMessageContext,
): Promise<void> {
  try {
    await context.deps.terminalService.cleanupDisconnectedCreate(create, context.ws);
  } catch (error) {
    logger.error("Failed to clean up a Terminal created after WebSocket disconnect", {
      error: describeError(error),
      method: create.method,
    });
  }
}

function disconnectedTerminalCreateFromResponse(
  method: TerminalCreateMethod,
  response: WebSocketResponse,
): DisconnectedTerminalCreate | null {
  if (response.error || response.result === undefined) return null;
  const parsed = WS_METHODS()[method].result.safeParse(response.result);
  const ptyId = parsed.success ? readStringField(parsed.data, "ptyId") : null;
  return ptyId ? { method, ptyId } : null;
}

function readStringField(value: unknown, field: "ptyId" | "sessionId"): string | null {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, field)) return null;
  const candidate = Reflect.get(value, field);
  return typeof candidate === "string" ? candidate : null;
}
