import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEventType, type ProviderRuntimeEvent, type TurnRequest } from "@mcode/contracts";
import { CodexProvider, stubEnvService } from "./codex-provider-test-fixture.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
  spawnSync: () => ({ status: 0, stdout: "codex-cli 0.150.0", stderr: "" }),
}));
vi.mock("which", () => ({ default: async () => "/usr/bin/codex" }));

interface RpcRequest {
  id?: number;
  method: string;
  params?: { turnId?: string };
}

class NativeProcess extends NodeEvents.EventEmitter {
  readonly stdin = new NodeStream.PassThrough();
  readonly stdout = new NodeStream.PassThrough();
  readonly stderr = new NodeStream.PassThrough();
  readonly requests: RpcRequest[] = [];
  readonly kill = vi.fn(() => {
    setImmediate(() => this.emit("exit", 0, null));
    return true;
  });
  private buffer = "";
  private turnCount = 0;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) this.respond(JSON.parse(line));
    });
  }

  complete(turnId: string, status = "completed"): void {
    this.stdout.write(JSON.stringify({ method: "turn/completed", params: {
      threadId: "native-thread", turn: { id: turnId, status, items: [] },
    } }) + "\n");
  }

  private respond(request: RpcRequest): void {
    this.requests.push(request);
    if (request.id === undefined) return;
    let result: object = {};
    if (request.method === "thread/start") result = { thread: { id: "native-thread" } };
    if (request.method === "turn/start") result = { turn: { id: `native-turn-${++this.turnCount}` } };
    if (request.method === "account/rateLimits/read") result = { rateLimits: {} };
    if (request.method === "config/read") result = { config: {} };
    this.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
    if (request.method === "turn/interrupt" && request.params?.turnId) this.complete(request.params.turnId, "interrupted");
  }
}

const request: TurnRequest<"codex"> = {
  turnId: "turn-1", turnExecutionId: "execution-1", sessionId: "mcode-lifecycle",
  threadId: "lifecycle", workspaceId: "fixture", cwd: process.cwd(), message: "hello",
  model: "gpt-5.4", permissionMode: "auto", interactionMode: "build", providerOptions: {},
  threadControlEligible: false,
};

function createProvider() {
  const settings = { provider: { cli: { codex: "codex" } } };
  const getSettings = vi.fn(async () => settings);
  const child = new NativeProcess();
  spawn.mockImplementation(() => {
    setImmediate(() => child.emit("spawn"));
    return child;
  });
  const provider = new CodexProvider(
    { get: getSettings }, stubEnvService(),
    { persistGeneratedImageFromPath: () => { throw new Error("Unexpected image"); } },
    {
      listModels: async () => [], currentSkills: () => [], currentPrompts: () => [],
      refreshCustomPrompts: async () => ({ prompts: [] }), shutdown: async () => undefined,
    },
  );
  const events: ProviderRuntimeEvent[] = [];
  provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));
  const starts = () => child.requests.filter(({ method }) => method === "turn/start");
  const complete = async (number: number, executionId: string) => {
    await vi.waitFor(() => expect(starts()).toHaveLength(number));
    child.complete(`native-turn-${number}`);
    await vi.waitFor(() => expect(events).toContainEqual({ event: {
      type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: executionId, outcome: "completed",
    } }));
  };
  return { provider, child, settings, getSettings, starts, complete };
}

afterEach(() => vi.clearAllMocks());

describe("Codex provider lifecycle through native transport", () => {
  it("keeps the process after completion and starts the next turn on the same transport", async () => {
    const { provider, child, complete } = createProvider();
    try {
      await provider.sendTurn(request);
      await complete(1, "execution-1");
      expect(child.kill).not.toHaveBeenCalled();
      await provider.sendTurn({ ...request, turnId: "turn-2", turnExecutionId: "execution-2" });
      await complete(2, "execution-2");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      await provider.discardSession(request.sessionId);
      provider.shutdown();
    }
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("cancels a reused turn during settings preparation without poisoning the next turn", async () => {
    const { provider, child, settings, getSettings, starts, complete } = createProvider();
    try {
      await provider.sendTurn(request);
      await complete(1, "execution-1");
      let releaseSettings!: (value: typeof settings) => void;
      getSettings.mockImplementationOnce(() => new Promise((resolve) => { releaseSettings = resolve; }));
      const sending = provider.sendTurn({ ...request, turnId: "turn-2", turnExecutionId: "execution-2" });
      await provider.stopSession(request.sessionId);
      releaseSettings(settings);
      await sending;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(starts()).toHaveLength(1);
      expect(child.kill).not.toHaveBeenCalled();
      await provider.sendTurn({ ...request, turnId: "turn-3", turnExecutionId: "execution-3" });
      await complete(2, "execution-3");
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await provider.discardSession(request.sessionId);
      provider.shutdown();
    }
  });
});
