import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWsTransport,
  parseLateTerminalCreateId,
  RpcTimeoutError,
} from "../ws-transport";

interface RpcRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function isRpcRequest(value: unknown): value is RpcRequest {
  return typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "method" in value &&
    typeof value.method === "string" &&
    "params" in value &&
    typeof value.params === "object" &&
    value.params !== null &&
    !Array.isArray(value.params);
}

class TimeoutSocket {
  static readonly OPEN = 1;
  static instances: TimeoutSocket[] = [];

  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0;
  readonly requests: RpcRequest[] = [];

  constructor() {
    TimeoutSocket.instances.push(this);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }

  send(raw: string | ArrayBuffer): void {
    if (typeof raw !== "string") return;
    const parsed: unknown = JSON.parse(raw);
    if (!isRpcRequest(parsed)) throw new Error("Expected an RPC request");
    this.requests.push(parsed);
  }

  open(): void {
    this.readyState = TimeoutSocket.OPEN;
    this.onopen?.();
  }

  respond(request: RpcRequest, result: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ id: request.id, result }) });
  }
}

const LEGACY_CAPABILITIES = {
  contractVersion: 0,
  backend: "legacy",
  publicFrameVersion: 0,
  recovery: { replay: true, checkpoint: true, gap: true },
};

const MODERN_CREATE_RESULT = {
  contractVersion: 1,
  sessionId: "00000000-0000-4000-8000-000000000001",
  scope: {
    kind: "workspace",
    workspaceId: "00000000-0000-4000-8000-000000000002",
  },
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
    scope: {
      kind: "workspace",
      workspaceId: "00000000-0000-4000-8000-000000000002",
    },
    arguments: [],
  },
  createdAt: "2026-09-24T12:00:00.000Z",
  lastCommandSeq: "0",
  lastOutputSeq: "0",
  exit: null,
  tombstone: false,
};

function latestRequest(socket: TimeoutSocket, method: string): RpcRequest {
  const request = [...socket.requests].reverse().find((entry) => entry.method === method);
  if (!request) throw new Error(`Expected ${method} request`);
  return request;
}

describe("interactive RPC timeout recovery", () => {
  let transport: ReturnType<typeof createWsTransport>;
  let socket: TimeoutSocket;

  beforeEach(async () => {
    vi.useFakeTimers();
    TimeoutSocket.instances = [];
    vi.stubGlobal("WebSocket", TimeoutSocket);
    transport = createWsTransport("ws://fixture.invalid");
    const initialSocket = TimeoutSocket.instances[0];
    if (!initialSocket) throw new Error("Expected initial WebSocket");
    socket = initialSocket;
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
  });

  afterEach(() => {
    transport.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("bounds repeated model discovery requests and allows a later retry to complete", async () => {
    const first = transport.listProviderModels("codex");
    await vi.advanceTimersByTimeAsync(0);
    const firstRequest = latestRequest(socket, "provider.listModels");

    const firstTimeout = expect(first).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await firstTimeout;

    socket.respond(firstRequest, [{ id: "late", name: "Late model" }]);
    const timedOutRetry = transport.listProviderModels("codex");
    await vi.advanceTimersByTimeAsync(0);
    const retryRequest = latestRequest(socket, "provider.listModels");
    expect(retryRequest.id).not.toBe(firstRequest.id);
    const retryTimeout = expect(timedOutRetry).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await retryTimeout;

    const successfulRetry = transport.listProviderModels("codex");
    await vi.advanceTimersByTimeAsync(0);
    const successfulRequest = latestRequest(socket, "provider.listModels");
    socket.respond(successfulRequest, [{ id: "fresh", name: "Fresh model" }]);

    await expect(successfulRetry).resolves.toEqual([{ id: "fresh", name: "Fresh model" }]);
  });

  it("validates both legacy and modern late create response shapes before cleanup", () => {
    expect(parseLateTerminalCreateId(
      "terminal.create",
      { ptyId: "pty-legacy", shell: "pwsh" },
    )).toBe("pty-legacy");
    expect(parseLateTerminalCreateId(
      "terminal.session.create",
      MODERN_CREATE_RESULT,
    )).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("retries terminal capability discovery after the previous selection timed out", async () => {
    const firstRequest = latestRequest(socket, "terminal.capabilities");
    const first = transport.terminalCapabilities();

    const firstTimeout = expect(first).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await firstTimeout;

    socket.respond(firstRequest, LEGACY_CAPABILITIES);
    const retry = transport.terminalCapabilities();
    await vi.advanceTimersByTimeAsync(0);
    const retryRequest = latestRequest(socket, "terminal.capabilities");
    expect(retryRequest.id).not.toBe(firstRequest.id);
    socket.respond(retryRequest, LEGACY_CAPABILITIES);

    await expect(retry).resolves.toEqual(LEGACY_CAPABILITIES);
  });

  it("allows a retry and cleans up an earlier terminal create that finishes late", async () => {
    const capabilities = latestRequest(socket, "terminal.capabilities");
    socket.respond(capabilities, LEGACY_CAPABILITIES);
    await vi.advanceTimersByTimeAsync(0);

    const first = transport.terminalCreate("thread-1");
    await vi.advanceTimersByTimeAsync(0);
    const firstRequest = latestRequest(socket, "terminal.create");

    const firstTimeout = expect(first).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(20_000);
    await firstTimeout;

    const retry = transport.terminalCreate("thread-1");
    await vi.advanceTimersByTimeAsync(0);
    const retryRequest = latestRequest(socket, "terminal.create");
    expect(retryRequest.id).not.toBe(firstRequest.id);

    socket.respond(firstRequest, { ptyId: "pty-late", shell: "pwsh" });
    await vi.advanceTimersByTimeAsync(0);
    const cleanup = latestRequest(socket, "terminal.kill");
    expect(cleanup.params).toEqual({ ptyId: "pty-late" });
    socket.respond(cleanup, undefined);

    socket.respond(retryRequest, { ptyId: "pty-fresh", shell: "pwsh" });
    await expect(retry).resolves.toEqual({ ptyId: "pty-fresh", shell: "pwsh" });
  });

  it("caps late terminal cleanup handlers when an open socket never responds", async () => {
    const capabilities = latestRequest(socket, "terminal.capabilities");
    socket.respond(capabilities, LEGACY_CAPABILITIES);
    await vi.advanceTimersByTimeAsync(0);

    for (let attempt = 0; attempt < 8; attempt++) {
      const create = transport.terminalCreate(`thread-${attempt}`);
      await vi.advanceTimersByTimeAsync(0);
      const timeout = expect(create).rejects.toBeInstanceOf(RpcTimeoutError);
      await vi.advanceTimersByTimeAsync(20_000);
      await timeout;
    }

    const cappedRetry = transport.terminalCreate("thread-after-cap");
    await expect(cappedRetry).rejects.toThrow(
      "Too many terminal creations are awaiting cleanup. Try again shortly.",
    );
    expect(socket.requests.filter((request) => request.method === "terminal.create")).toHaveLength(8);
  });
});
