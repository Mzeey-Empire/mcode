import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import * as transportRegistry from "@/transport";
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
  respondToHeartbeats = true;

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
    // A socket that ignores the liveness probe is closed by the watchdog;
    // these tests exercise RPC timeouts on a live connection instead.
    if (parsed.method === "app.version" && this.respondToHeartbeats) {
      queueMicrotask(() => this.respond(parsed, "0.0.1"));
    }
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
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reconciles the server workspace list on reconnect without listing twice on first connect", async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(transportRegistry, "getTransport").mockReturnValue(transport);
    vi.stubGlobal("desktopBridge", { preview: { profiles: { reconcile } } });
    useWorkspaceStore.setState({ activeWorkspaceId: null, activeThreadId: null });
    expect(socket.requests.filter((request) => request.method === "workspace.list")).toEqual([]);
    const initialLoad = useWorkspaceStore.getState().loadWorkspaces();
    await vi.advanceTimersByTimeAsync(0);
    socket.respond(latestRequest(socket, "workspace.list"), [{ id: "11111111-1111-4111-8111-111111111111" }]);
    await initialLoad;
    expect(reconcile.mock.calls).toEqual([[["11111111-1111-4111-8111-111111111111"]]]);
    expect(socket.requests.filter((request) => request.method === "workspace.list")).toHaveLength(1);

    socket.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const reconnected = TimeoutSocket.instances[1];
    if (!reconnected) throw new Error("Expected reconnect socket");
    reconnected.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconnected.requests.filter((request) => request.method === "workspace.list")).toHaveLength(1);
    reconnected.respond(latestRequest(reconnected, "workspace.list"), [{ id: "22222222-2222-4222-8222-222222222222" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile.mock.calls).toEqual([
      [["11111111-1111-4111-8111-111111111111"]],
      [["22222222-2222-4222-8222-222222222222"]],
    ]);
  });

  it("restores server records on the first connection and refreshes them after reconnect", async () => {
    useTerminalStore.setState({ terminals: {}, ptyToThread: {}, terminalPanelByThread: {}, hasHydrated: false });
    useWorkspaceStore.setState({ activeWorkspaceId: null, activeThreadId: null });
    socket.respond(latestRequest(socket, "terminal.capabilities"), LEGACY_CAPABILITIES);
    await vi.advanceTimersByTimeAsync(0);
    socket.respond(latestRequest(socket, "terminal.listActive"), [
      { ptyId: "second", threadId: "thread", shell: "bash", createdAt: "2026-10-08T12:01:00.000Z" },
      { ptyId: "first", threadId: "thread", shell: "pwsh", state: "exited", exitCode: 7, createdAt: "2026-10-08T12:00:00.000Z" },
      { ptyId: "workspace-shell", threadId: "workspace", shell: "zsh" },
    ]);
    await vi.waitFor(() => expect(useTerminalStore.getState().hasHydrated).toBe(true));
    expect(useTerminalStore.getState().terminals.thread.map(({ id, label, state, exitCode }) =>
      [id, label, state, exitCode])).toEqual([
      ["first", "pwsh", "exited", 7], ["second", "bash", "running", undefined],
    ]);
    expect(useTerminalStore.getState().terminals.workspace.map(({ id, label }) => [id, label])).toEqual([["workspace-shell", "zsh"]]);

    socket.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const reconnected = TimeoutSocket.instances[1];
    if (!reconnected) throw new Error("Expected reconnect socket");
    reconnected.open();
    await vi.advanceTimersByTimeAsync(0);
    reconnected.respond(latestRequest(reconnected, "terminal.capabilities"), LEGACY_CAPABILITIES);
    await vi.advanceTimersByTimeAsync(0);
    reconnected.respond(latestRequest(reconnected, "terminal.listActive"), [
      { ptyId: "second", threadId: "thread", shell: "bash", state: "exited", exitCode: 2 },
    ]);
    await vi.waitFor(() => expect(useTerminalStore.getState().ptyToThread).toEqual({ second: "thread" }));
    expect(useTerminalStore.getState().terminals.thread.map(({ id, state, exitCode }) => [id, state, exitCode])).toEqual([["second", "exited", 2]]);
    expect(useTerminalStore.getState().terminals.workspace).toBeUndefined();
  });

  it("checks every five seconds and reconnects after three missed reply checks", async () => {
    socket.respondToHeartbeats = false;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.requests.filter((request) => request.method === "app.version")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.readyState).toBe(TimeoutSocket.OPEN);
    expect(socket.requests.filter((request) => request.method === "app.version")).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(TimeoutSocket.instances).toHaveLength(2);
  });

  it("resets missed checks when a delayed heartbeat reply arrives", async () => {
    socket.respondToHeartbeats = false;
    await vi.advanceTimersByTimeAsync(15_000);
    socket.respond(latestRequest(socket, "app.version"), "0.0.1");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.readyState).toBe(TimeoutSocket.OPEN);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.readyState).toBe(3);
  });

  it("stops heartbeat requests when the transport is closed", async () => {
    await vi.advanceTimersByTimeAsync(5_000);
    const requestCount = socket.requests.length;
    transport.close();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(socket.requests).toHaveLength(requestCount);
    expect(TimeoutSocket.instances).toHaveLength(1);
  });

  it("ignores an old heartbeat reply after a replacement connection starts checking", async () => {
    socket.respondToHeartbeats = false;
    await vi.advanceTimersByTimeAsync(5_000);
    socket.respond(latestRequest(socket, "app.version"), "0.0.1");
    socket.close();
    // Keep the old reply's Promise continuation queued until the new socket
    // has sent its first probe, reproducing a reconnect boundary race.
    vi.advanceTimersByTime(1_000);
    const replacement = TimeoutSocket.instances[1];
    if (!replacement) throw new Error("Expected replacement WebSocket");
    replacement.respondToHeartbeats = false;
    replacement.open();
    vi.advanceTimersByTime(5_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(replacement.readyState).toBe(3);
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

  it("validates late create response shapes before cleanup", () => {
    expect(parseLateTerminalCreateId(
      "terminal.create",
      { ptyId: "pty-legacy", shell: "pwsh" },
    )).toBe("pty-legacy");
    expect(parseLateTerminalCreateId("terminal.create", { ptyId: 7 })).toBeNull();
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
