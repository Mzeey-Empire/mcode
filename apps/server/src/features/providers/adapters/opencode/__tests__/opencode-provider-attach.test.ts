import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type ProviderRuntimeEvent, type TurnRequest } from "@mcode/contracts";
import { OpenCodeProvider } from "../opencode-provider.js";
import { OpenCodeServerPool } from "../opencode-server-pool.js";
import type { OpenCodeEndpoint } from "../opencode-http-client.js";

const ATTACHED_URL = "http://10.0.0.5:4096";
const TURN_CWD = "/w/attached repo";

function fakeHttp(onSubscribe: (signal: AbortSignal, onEnvelope: (e: unknown) => void) => Promise<void>) {
  return {
    createSession: vi.fn(async (_endpoint: OpenCodeEndpoint) => ({ id: "ses_a" })),
    promptAsync: vi.fn(async (_endpoint: OpenCodeEndpoint) => {}),
    abortSession: vi.fn(async (_endpoint: OpenCodeEndpoint, _sessionId: string) => {}),
    listModels: vi.fn(async (_endpoint: OpenCodeEndpoint) => [{ id: "anthropic/claude-sonnet-4-6", name: "Sonnet", group: "Anthropic" }]),
    listSessionMessages: vi.fn(async () => []),
    getSessionStatus: vi.fn(async () => ({ ses_a: { type: "idle" } })),
    replyPermission: vi.fn(async () => {}),
    replyQuestion: vi.fn(async () => {}),
    rejectQuestion: vi.fn(async () => {}),
    subscribeEvents: vi.fn(async (_endpoint: OpenCodeEndpoint, signal: AbortSignal, onEnvelope: (e: unknown) => void) =>
      onSubscribe(signal, onEnvelope)),
  };
}

function completingStream(signal: AbortSignal, onEnvelope: (e: unknown) => void): Promise<void> {
  onEnvelope({ type: "session.idle", properties: { sessionID: "ses_a" } });
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function hangingStream(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function setup(serveUrl: string, http: ReturnType<typeof fakeHttp>) {
  const terminateTree = vi.fn(async () => {});
  const spawn = vi.fn(() => ({ pid: 77, on: () => {}, off: () => {}, kill: () => true }));
  const pool = new OpenCodeServerPool({
    spawn, waitForHealth: async () => {}, terminateTree,
    findFreePort: async () => 4100, now: () => Date.now(), env: () => ({}),
  });
  const acquire = vi.spyOn(pool, "acquire");
  const probeCli = vi.fn(async () => ({ binaryPath: "opencode", version: "test" }));
  const settingsService = { get: () => ({ provider: { cli: { opencode: "" }, opencode: { serveUrl } } }) };
  const host = {
    processes: { attach: () => {}, terminateTree },
    runtime: { platform: "linux" },
  };
  const provider = new OpenCodeProvider(settingsService as never, { getEnv: () => ({}) } as never, host as never);
  provider.configureTestSeams({
    pool, http, probeCli,
    idleConfirm: { intervalMs: 1, requiredPolls: 1, timeoutMs: 500, maxPollErrors: 2 },
  });
  const events: string[] = [];
  provider.on("event", (runtimeEvent: ProviderRuntimeEvent) => events.push(runtimeEvent.event.type));
  return { provider, acquire, probeCli, spawn, terminateTree, events };
}

function turnRequest(): TurnRequest<"opencode"> {
  return {
    turnId: "turn-attach",
    turnExecutionId: "22222222-2222-4222-8222-222222222222",
    sessionId: "mcode-thread-attach",
    workspaceId: "ws-attach",
    threadId: "thread-attach",
    message: "hello",
    cwd: TURN_CWD,
    model: "anthropic/claude-sonnet-4-6",
    permissionMode: "full",
    interactionMode: "build",
    providerOptions: {},
  } as TurnRequest<"opencode">;
}

describe("OpenCodeProvider attached to an external serve URL", () => {
  it("runs the turn on the attached server in the turn's directory without spawning, and shutdown leaves it alone", async () => {
    const http = fakeHttp(completingStream);
    const { provider, acquire, probeCli, spawn, terminateTree, events } = setup(ATTACHED_URL, http);

    await provider.sendTurn(turnRequest());

    const attached = { baseUrl: ATTACHED_URL, directory: TURN_CWD };
    expect(http.createSession.mock.calls[0]?.[0]).toEqual(attached);
    expect(http.subscribeEvents.mock.calls[0]?.[0]).toEqual(attached);
    expect(http.promptAsync.mock.calls[0]?.[0]).toEqual(attached);
    expect(events).toEqual([AgentEventType.TurnStarted, AgentEventType.System, AgentEventType.TurnComplete, AgentEventType.Ended]);
    expect(acquire).not.toHaveBeenCalled();
    expect(probeCli).not.toHaveBeenCalled();

    await provider.shutdown();
    expect(http.abortSession).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(terminateTree).not.toHaveBeenCalled();
  });

  it("stop aborts the upstream session on the attached endpoint", async () => {
    const http = fakeHttp(hangingStream);
    const { provider, events } = setup(ATTACHED_URL, http);

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(http.promptAsync).toHaveBeenCalled());
    await provider.stopSession("mcode-thread-attach");
    await sending;

    expect(http.abortSession.mock.calls).toEqual([[{ baseUrl: ATTACHED_URL, directory: TURN_CWD }, "ses_a"]]);
    expect(events.at(-1)).toBe(AgentEventType.Ended);
    await provider.shutdown();
  });

  it("lists models from the attached server without touching the pool", async () => {
    const http = fakeHttp(hangingStream);
    const { provider, acquire, probeCli } = setup(ATTACHED_URL, http);

    const models = await provider.listModels();

    expect(models.map((model) => model.id)).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(http.listModels.mock.calls).toEqual([[{ baseUrl: ATTACHED_URL, directory: process.cwd() }]]);
    expect(acquire).not.toHaveBeenCalled();
    expect(probeCli).not.toHaveBeenCalled();
    await provider.shutdown();
  });

  it("an empty serve URL keeps the pooled server for the same directory", async () => {
    const http = fakeHttp(completingStream);
    const { provider, acquire, spawn } = setup("", http);

    await provider.sendTurn(turnRequest());

    expect(acquire.mock.calls).toEqual([[{ binaryPath: "opencode", cwd: TURN_CWD, hostname: "127.0.0.1" }]]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(http.promptAsync.mock.calls[0]?.[0]).toEqual({ baseUrl: "http://127.0.0.1:4100", directory: TURN_CWD });
    await provider.shutdown();
  });
});
