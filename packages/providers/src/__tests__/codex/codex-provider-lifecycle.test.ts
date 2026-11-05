import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import { isTurnSteerCapable, type TurnRequest } from "@mcode/contracts/providers/interfaces";
import { type NativePlanQuestionBatch } from "@mcode/contracts/models/plan-questions";
import { type ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import { CodexProvider, stubEnvService } from "./codex-provider-test-fixture.js";
import { CodexEventMapper } from "../../private/codex/codex-event-mapper.js";
import type { ProviderEventSinkPort } from "../../host-ports.js";
import { checkCodexVersion, clearVersionCache } from "../../private/codex/codex-version.js";

const { spawn, cli } = vi.hoisted(() => ({ spawn: vi.fn(), cli: { version: "0.150.0" } }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
  spawnSync: () => ({ status: 0, stdout: `codex-cli ${cli.version}`, stderr: "" }),
}));
vi.mock("which", () => ({ default: async () => "/usr/bin/codex" }));

interface RpcRequest {
  id?: number;
  method: string;
  params?: { turnId?: string; expectedTurnId?: string };
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
  /** When set, `turn/steer` answers with this JSON-RPC error message. */
  steerError: string | undefined;
  /** When set, `turn/interrupt` gets this reply in place of a response and an interrupted completion. */
  interruptReply: ((request: RpcRequest) => void) | undefined;
  /** When true, `turn/start` waits for {@link answerHeldTurnStart} or {@link failHeldTurnStart}. */
  holdTurnStart = false;
  private heldTurnStart: RpcRequest | undefined;
  private buffer = "";
  private turnCount = 0;

  constructor() {
    super();
    // A real process's stdout ends once its last bytes are read after it exits.
    this.once("exit", () => this.stdout.end());
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

  answerHeldTurnStart(): void {
    const held = this.takeHeldTurnStart();
    this.stdout.write(JSON.stringify({ id: held.id, result: this.resultFor(held) }) + "\n");
  }

  failHeldTurnStart(message: string): void {
    const held = this.takeHeldTurnStart();
    this.stdout.write(JSON.stringify({ id: held.id, error: { code: -32600, message } }) + "\n");
  }

  private takeHeldTurnStart(): RpcRequest {
    const held = this.heldTurnStart;
    if (!held) throw new Error("No turn/start is held");
    this.heldTurnStart = undefined;
    return held;
  }

  private respond(request: RpcRequest): void {
    this.requests.push(request);
    if (request.id === undefined || this.answerAsScripted(request)) return;
    this.stdout.write(JSON.stringify({ id: request.id, result: this.resultFor(request) }) + "\n");
    if (request.method === "turn/interrupt" && request.params?.turnId) this.complete(request.params.turnId, "interrupted");
  }

  /** Answers a request the test scripted, returning false when the default answer applies. */
  private answerAsScripted(request: RpcRequest): boolean {
    if (request.method === "turn/start" && this.holdTurnStart) {
      this.heldTurnStart = request;
      return true;
    }
    if (request.method === "turn/interrupt" && this.interruptReply) {
      this.interruptReply(request);
      return true;
    }
    if (request.method === "turn/steer" && this.steerError) {
      this.stdout.write(JSON.stringify({ id: request.id, error: { code: -32600, message: this.steerError } }) + "\n");
      return true;
    }
    return false;
  }

  private resultFor(request: RpcRequest): object {
    switch (request.method) {
      case "thread/start": return { thread: { id: "native-thread" } };
      case "turn/start": return { turn: { id: `native-turn-${++this.turnCount}` } };
      case "account/rateLimits/read": return { rateLimits: {} };
      case "config/read": return { config: {} };
      case "turn/steer": return { turnId: request.params?.expectedTurnId };
      default: return {};
    }
  }
}

const request: TurnRequest<"codex"> = {
  turnId: "turn-1", turnExecutionId: "63093cff-69b8-4efb-82db-20a75f993612", sessionId: "mcode-lifecycle",
  threadId: "lifecycle", workspaceId: "fixture", cwd: process.cwd(), message: "hello",
  model: "gpt-5.4", permissionMode: "supervised", approvalReviewMode: "manual", interactionMode: "build", providerOptions: {},
};

function answerLine(delta: string): string {
  return JSON.stringify({ method: "item/agentMessage/delta",
    params: { threadId: "native-thread", turnId: "native-turn-1", itemId: "answer", delta } }) + "\n";
}

function completionLine(status: string): string {
  return JSON.stringify({ method: "turn/completed",
    params: { threadId: "native-thread", turn: { id: "native-turn-1", status, items: [] } } }) + "\n";
}

function turnEventsOf(events: ProviderRuntimeEvent[]) {
  return events.map(({ event }) => event).filter((event) => event.turnExecutionId === request.turnExecutionId);
}

function turnTexts(events: ProviderRuntimeEvent[]): string[] {
  return turnEventsOf(events).flatMap((event) => event.type === AgentEventType.TextDelta ? [event.delta] : []);
}

function turnEnds(events: ProviderRuntimeEvent[]) {
  return turnEventsOf(events).filter((event) => event.type === AgentEventType.Ended);
}

/** Lets pending stream and RPC callbacks run, so teardown reaches its interrupt. */
function settleIo(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createProvider(eventSink?: ProviderEventSinkPort) {
  const settings = { provider: { cli: { codex: "codex" } } };
  const getSettings = vi.fn(async () => settings);
  const child = new NativeProcess();
  const catalogShutdown = vi.fn(async () => {});
  spawn.mockImplementation(() => {
    setImmediate(() => child.emit("spawn"));
    return child;
  });
  const provider = new CodexProvider(
    { get: getSettings }, stubEnvService(),
    { persistGeneratedImageFromPath: () => { throw new Error("Unexpected image"); } },
    {
      listModels: async () => [], currentSkills: () => [], currentPrompts: () => [],
      refreshCustomPrompts: async () => ({ prompts: [] }), shutdown: catalogShutdown,
    },
    undefined, undefined, eventSink,
  );
  const events: ProviderRuntimeEvent[] = [];
  provider.observeCanonicalEvents((event: ProviderRuntimeEvent) => events.push(event));
  const starts = () => child.requests.filter(({ method }) => method === "turn/start");
  const complete = async (number: number, executionId: string) => {
    await vi.waitFor(() => expect(starts()).toHaveLength(number));
    child.complete(`native-turn-${number}`);
    await vi.waitFor(() => expect(events).toContainEqual({ deliveryAttempt: 1, event: {
      type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: executionId, outcome: "completed",
    } }));
  };
  return { provider, child, settings, getSettings, starts, complete, events, catalogShutdown };
}

async function pendingQuestion(f: ReturnType<typeof createProvider>, settled: () => Promise<void>) {
  cli.version = "0.161.0";
  const batches: NativePlanQuestionBatch[] = [];
  f.provider.bindPlanQuestions({ requested: async batch => { batches.push(batch); }, settled });
  await f.provider.sendTurn({ ...request, deliveryAttempt: 3, planTurn: { kind: "planning", planFilePath: null } });
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.child.stdout.write(JSON.stringify({ id: 90, method: "item/tool/requestUserInput", params: {
    threadId: "native-thread", turnId: "native-turn-1", itemId: "item",
    questions: [{ id: "tone", header: "Tone", question: "Which greeting?", isOther: true, isSecret: false,
      options: [{ label: "Brief", description: "One sentence" }, { label: "Detailed", description: "A paragraph" }] }],
  } }) + "\n");
  await vi.waitFor(() => expect(batches).toHaveLength(1));
}

afterEach(() => {
  vi.clearAllMocks();
  cli.version = "0.150.0";
  clearVersionCache();
});

const STEER_ID = "1d7f7a1e-58a1-4d0b-9a55-4f4b3c0f6a10";

describe("Codex provider lifecycle through native transport", () => {
  it("leaves an unbound interrupt open for the real completion and final output", async () => {
    const { provider, child, starts, events } = createProvider();
    const busy = vi.spyOn(provider, "isBusy");
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    const state = busy.mock.calls[0]?.[0];
    if (!state) throw new Error("Session was not checked for activity");
    await vi.waitFor(() => expect(state.currentNativeTurnId).toBe("native-turn-1"));
    child.interruptReply = (interrupt) => {
      child.stdout.write(JSON.stringify({ id: interrupt.id, result: {} }) + "\n");
    };
    // Exercise the fallback while the native execution's completion is still outstanding.
    state.currentNativeTurnId = undefined;
    await provider.interrupt(state);
    expect(child.requests.filter(({ method }) => method === "turn/interrupt").map(({ params }) => params?.turnId))
      .toEqual([undefined]);
    expect(turnEnds(events)).toEqual([]);
    child.stdout.write(answerLine("final answer"));
    child.complete("native-turn-1", "completed");
    await vi.waitFor(() => expect(turnEnds(events)).toEqual([{
      type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: request.turnExecutionId, outcome: "completed",
    }]));
    expect(turnTexts(events)).toEqual(["final answer"]);
    await provider.shutdown();
  });

  it.each(["stop", "shutdown", "shutdown without interrupt reply"])("cancels a replacement during the old interrupt on %s", async (action) => {
    const { provider, child, starts, events } = createProvider();
    const replacement = { ...request, turnId: "turn-2", turnExecutionId: "73093cff-69b8-4efb-82db-20a75f993612" };
    const held = Promise.withResolvers<RpcRequest>();
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    child.interruptReply = (interrupt) => {
      if (!interrupt.params?.turnId) held.resolve(interrupt);
      else {
        child.stdout.write(JSON.stringify({ id: interrupt.id, result: {} }) + "\n");
        child.complete(interrupt.params.turnId, "interrupted");
      }
    };
    await provider.sendTurn(replacement);
    const interrupt = await held.promise;
    const stopping = action === "stop" ? provider.stopSession(request.sessionId) : provider.shutdown();
    await settleIo();
    if (action !== "shutdown without interrupt reply") {
      child.complete("native-turn-1", "interrupted");
      child.stdout.write(JSON.stringify({ id: interrupt.id, result: {} }) + "\n");
    }
    await stopping;
    await settleIo();
    expect(starts()).toHaveLength(1);
    await vi.waitFor(() => expect(events.map(({ event }) => event).filter((event) =>
      event.type === AgentEventType.Ended && event.turnExecutionId === replacement.turnExecutionId)).toEqual([{
      type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: replacement.turnExecutionId, outcome: "cancelled",
    }]));
    expect(starts()).toHaveLength(1);
    expect(turnEnds(events)).toEqual([{
      type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: request.turnExecutionId, outcome: "cancelled",
    }]);
    child.interruptReply = undefined;
    if (action === "stop") await provider.shutdown();
  });

  it("interrupts a replacement after its turn/start binds", async () => {
    const { provider, child, starts, events } = createProvider();
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    child.interruptReply = (interrupt) => {
      child.complete(interrupt.params?.turnId ?? "native-turn-1", "interrupted");
      child.stdout.write(JSON.stringify({ id: interrupt.id, result: {} }) + "\n");
    };
    await provider.sendTurn({ ...request, turnId: "turn-2", turnExecutionId: "73093cff-69b8-4efb-82db-20a75f993612" });
    await vi.waitFor(() => expect(starts()).toHaveLength(2));
    await provider.stopSession(request.sessionId);
    expect(child.requests.filter(({ method, params }) => method === "turn/interrupt" && params?.turnId)
      .map(({ params }) => params?.turnId)).toEqual(["native-turn-2"]);
    await vi.waitFor(() => expect(events.map(({ event }) => event).filter((event) => event.type === AgentEventType.Ended)).toEqual([
      { type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: request.turnExecutionId, outcome: "cancelled" },
      { type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: "73093cff-69b8-4efb-82db-20a75f993612", outcome: "cancelled" },
    ]));
    await provider.shutdown();
  });

  it("ends a crashed question turn with its attempt even when durable expiry fails", async () => {
    const f = createProvider();
    const drain = Promise.withResolvers<void>();
    try {
      await pendingQuestion(f, () => drain.promise);
      f.child.emit("exit", 1, null);
      await vi.waitFor(() => expect(f.child.kill).toHaveBeenCalled());
      drain.reject(new Error("Question persistence unavailable"));
      await vi.waitFor(() => expect(f.events.filter(({ event }) => event.type === AgentEventType.Ended)).toEqual([
        { deliveryAttempt: 3, event: { type: AgentEventType.Ended, threadId: request.threadId,
          turnExecutionId: request.turnExecutionId, outcome: "interrupted" } },
      ]));
    } finally { drain.resolve(); await f.provider.shutdown(); }
  });

  it("still tears down sessions and the catalog when question expiry fails during shutdown", async () => {
    const f = createProvider();
    try {
      await pendingQuestion(f, async () => { throw new Error("Question persistence unavailable"); });
      await expect(f.provider.shutdown()).rejects.toBeInstanceOf(AggregateError);
      expect(f.child.kill).toHaveBeenCalledTimes(1);
      expect(f.catalogShutdown).toHaveBeenCalledTimes(1);
      expect(f.child.requests.filter(({ method, params }) => method === "turn/interrupt" && params?.turnId).map(({ params }) => params?.turnId))
        .toEqual(["native-turn-1"]);
    } finally { await f.provider.shutdown(); }
  });

  it("keeps a silent turn active without model-list probes until native completion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { provider, child, starts, complete, events } = createProvider();
    try {
      await provider.sendTurn(request);
      await vi.waitFor(() => expect(starts()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      expect(child.requests.some(({ method }) => method === "model/list")).toBe(false);
      expect(events.some(({ event }) => event.type === AgentEventType.Ended || event.type === AgentEventType.Error)).toBe(false);
      await complete(1, request.turnExecutionId);
    } finally {
      vi.useRealTimers();
      await provider.shutdown();
    }
  });

  it("still settles an active turn when the native process exits unexpectedly", async () => {
    const { provider, child, starts, events } = createProvider();
    try {
      await provider.sendTurn({ ...request, deliveryAttempt: 3 });
      await vi.waitFor(() => expect(starts()).toHaveLength(1));
      child.emit("exit", 1, null);
      await vi.waitFor(() => expect(events).toContainEqual({ deliveryAttempt: 3, event: {
        type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: request.turnExecutionId, outcome: "errored",
      } }));
      expect(events.filter(({ event }) => event.type === AgentEventType.Error)).toMatchObject([
        { deliveryAttempt: 3, event: { type: AgentEventType.Error, turnExecutionId: request.turnExecutionId } },
      ]);
    } finally {
      await provider.shutdown();
    }
  });

  it("settles process exit even when optional assistant boundary projection throws", async () => {
    const { provider, child, starts, events } = createProvider();
    let fault: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await provider.sendTurn(request);
      await vi.waitFor(() => expect(starts()).toHaveLength(1));
      fault = vi.spyOn(CodexEventMapper.prototype, "drainPendingAssistantBoundary")
        .mockImplementationOnce(() => { throw new Error("optional boundary projection failed"); });
      expect(() => child.emit("exit", 1, null)).not.toThrow();
      await vi.waitFor(() => expect(events).toContainEqual({ deliveryAttempt: 1, event: {
        type: AgentEventType.Ended, threadId: request.threadId,
        turnExecutionId: request.turnExecutionId, outcome: "errored",
      } }));
      expect(events.filter(({ event }) => event.type === AgentEventType.Ended)).toHaveLength(1);
    } finally {
      fault?.mockRestore();
      await provider.shutdown();
    }
  });

  it("consumes native completion even when its optional mapper throws", async () => {
    const { provider, complete, events } = createProvider();
    let mapperFault: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await provider.sendTurn(request);
      mapperFault = vi.spyOn(CodexEventMapper.prototype, "mapNotification").mockImplementationOnce(() => { throw new Error("optional projection failed"); });
      await complete(1, request.turnExecutionId);
      expect(events.filter(({ event }) => event.type === AgentEventType.Ended)).toHaveLength(1);
      expect(events.some(({ event }) => event.type === AgentEventType.Error)).toBe(false);
    } finally {
      mapperFault?.mockRestore();
      await provider.shutdown();
    }
  });

  it("drops an unscoped nonretry diagnostic without ending the active canonical turn", async () => {
    const { provider, child, complete, events } = createProvider();
    try {
      await provider.sendTurn(request);
      child.stdout.write(JSON.stringify({ method: "error", params: { threadId: "native-thread", turnId: "native-turn-1",
        willRetry: false, error: { message: "Tool update failed" } } }) + "\n");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await provider.flushCanonicalEvents();
      expect(events.filter(({ event }) => event.type === AgentEventType.System && event.subtype === "provider.notice.codex-error")).toEqual([]);
      expect(events.some(({ event }) => event.type === AgentEventType.Ended || event.type === AgentEventType.Error)).toBe(false);
      await complete(1, request.turnExecutionId);
    } finally {
      await provider.shutdown();
    }
  });

  it("maps pooled session IDs to live thread protection before memory eviction", async () => {
    const { provider, child, complete } = createProvider();
    const isThreadProtected = vi.fn((threadId: string) => threadId === request.threadId);
    try {
      await provider.sendTurn(request);
      await complete(1, request.turnExecutionId);
      await provider.shedMemoryPressure("critical", isThreadProtected);
      expect(isThreadProtected).toHaveBeenCalledExactlyOnceWith(request.threadId);
      expect(child.kill).not.toHaveBeenCalled();
      isThreadProtected.mockReturnValue(false);
      await provider.shedMemoryPressure("critical", isThreadProtected);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      await provider.shutdown();
    }
  });

  it("interrupts an active turn and waits for process exit during shutdown", async () => {
    const { provider, child, starts } = createProvider();
    child.kill.mockImplementation(() => true);
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    let settled = false;
    const shutdown = Promise.resolve(provider.shutdown()).then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
      expect(child.requests.some(({ method }) => method === "turn/interrupt")).toBe(true);
      expect(settled).toBe(false);
      child.emit("exit", 0, null);
      await shutdown;
      expect(settled).toBe(true);
    } finally {
      child.emit("exit", 0, null);
      await shutdown;
    }
  });

  it("publishes held output and the real completion when shutdown starts while saving is behind", async () => {
    let releaseSaves!: () => void;
    const savesBlocked = new Promise<void>((resolve) => { releaseSaves = resolve; });
    const { provider, child, starts, events } = createProvider({ submit: async (batch) => {
      await savesBlocked;
      return { commit: { outcome: "committed", conversationRevision: 1, rosterRevision: 0, acceptedThrough: 1,
        durableThrough: 1, eventCount: batch.events.length }, delivery: { ingress: "queued" } };
    } });
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    // One chunk, so the lines past the pause threshold are read but held, with the completion last.
    const deltas = Array.from({ length: 400 }, (_, index) => `${index} `);
    child.stdout.write(deltas.map((delta) => JSON.stringify({ method: "item/agentMessage/delta",
      params: { threadId: "native-thread", turnId: "native-turn-1", itemId: "answer", delta } }) + "\n").join("")
      + JSON.stringify({ method: "turn/completed", params: { threadId: "native-thread",
        turn: { id: "native-turn-1", status: "completed", items: [] } } }) + "\n");
    await vi.waitFor(() => expect(child.stdout.isPaused()).toBe(true));

    // Saving stays behind past every teardown grace, as with a stalled database.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shutdown = provider.shutdown();
      await vi.advanceTimersByTimeAsync(20_000);
      releaseSaves();
      await shutdown;
    } finally {
      vi.useRealTimers();
    }

    const turnEvents = events.map(({ event }) => event).filter((event) => event.turnExecutionId === request.turnExecutionId);
    expect(turnEvents.flatMap((event) => event.type === AgentEventType.TextDelta ? [event.delta] : [])).toEqual(deltas);
    expect(turnEvents.filter((event) => event.type === AgentEventType.Ended)).toEqual([{
      type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: request.turnExecutionId, outcome: "completed",
    }]);
  });

  it("publishes output still in the pipe and the real completion when shutdown starts while saving is behind", async () => {
    let releaseSaves!: () => void;
    const savesBlocked = new Promise<void>((resolve) => { releaseSaves = resolve; });
    const { provider, child, starts, events } = createProvider({ submit: async (batch) => {
      await savesBlocked;
      return { commit: { outcome: "committed", conversationRevision: 1, rosterRevision: 0, acceptedThrough: 1,
        durableThrough: 1, eventCount: batch.events.length }, delivery: { ingress: "queued" } };
    } });
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    const deltas = Array.from({ length: 1_300 }, (_, index) => `${index} `);
    const deltaLines = (slice: string[]) => slice.map((delta) => JSON.stringify({ method: "item/agentMessage/delta",
      params: { threadId: "native-thread", turnId: "native-turn-1", itemId: "answer", delta } }) + "\n").join("");
    child.stdout.write(deltaLines(deltas.slice(0, 650)));
    await vi.waitFor(() => expect(child.stdout.isPaused()).toBe(true));
    // Written while paused, so these lines and the completion are still in the pipe when shutdown starts.
    child.stdout.write(deltaLines(deltas.slice(650)) + JSON.stringify({ method: "turn/completed", params: {
      threadId: "native-thread", turn: { id: "native-turn-1", status: "completed", items: [] } } }) + "\n");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shutdown = provider.shutdown();
      await vi.advanceTimersByTimeAsync(20_000);
      releaseSaves();
      await shutdown;
    } finally {
      vi.useRealTimers();
    }

    const turnEvents = events.map(({ event }) => event).filter((event) => event.turnExecutionId === request.turnExecutionId);
    expect(turnEvents.flatMap((event) => event.type === AgentEventType.TextDelta ? [event.delta] : [])).toEqual(deltas);
    expect(turnEvents.filter((event) => event.type === AgentEventType.Ended)).toEqual([{
      type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: request.turnExecutionId, outcome: "completed",
    }]);
  });

  it("publishes late output and the real completion when the turn's interrupt times out during shutdown", async () => {
    const { provider, child, starts, events } = createProvider();
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    child.stdout.write(answerLine("before "));
    await vi.waitFor(() => expect(turnTexts(events)).toEqual(["before "]));
    child.interruptReply = (interrupt) => {
      // The exact-turn interrupt never answers; the server's final interrupt before the kill does,
      // a little later, as a real process would, so the answer follows the first interrupt's timeout.
      if (interrupt.params?.turnId) return;
      setTimeout(() => child.stdout.write(answerLine("late ") + completionLine("completed")
        + JSON.stringify({ id: interrupt.id, result: {} }) + "\n"), 100);
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shutdown = provider.shutdown();
      await vi.advanceTimersByTimeAsync(20_000);
      await shutdown;
    } finally {
      vi.useRealTimers();
    }

    expect(turnTexts(events)).toEqual(["before ", "late "]);
    expect(turnEnds(events)).toEqual([{
      type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: request.turnExecutionId, outcome: "completed",
    }]);
  });

  it("publishes late output and the real completion when app shutdown stops the session before the provider shuts down", async () => {
    const { provider, child, starts, events } = createProvider();
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    child.stdout.write(answerLine("before "));
    await vi.waitFor(() => expect(turnTexts(events)).toEqual(["before "]));
    child.interruptReply = (interrupt) => {
      if (interrupt.params?.turnId) return;
      setTimeout(() => child.stdout.write(answerLine("late ") + completionLine("completed")
        + JSON.stringify({ id: interrupt.id, result: {} }) + "\n"), 100);
    };

    // Server shutdown stops each live session, unfenced, and then shuts the provider down.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stop = provider.stopSession(request.sessionId);
      await vi.advanceTimersByTimeAsync(30_000);
      await stop;
      const shutdown = provider.shutdown();
      await vi.advanceTimersByTimeAsync(20_000);
      await shutdown;
    } finally {
      vi.useRealTimers();
    }

    expect(turnTexts(events)).toEqual(["before ", "late "]);
    expect(turnEnds(events)).toEqual([{
      type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: request.turnExecutionId, outcome: "completed",
    }]);
  });

  it("ends the turn once as provider_lost after reading the output of a server killed without a real end", async () => {
    const { provider, child, starts, events } = createProvider();
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    child.stdout.write(answerLine("before "));
    await vi.waitFor(() => expect(turnTexts(events)).toEqual(["before "]));
    // No interrupt answers. The process writes its last text, with no end, as it is terminated.
    child.interruptReply = () => {};
    child.kill.mockImplementation(() => {
      child.stdout.write(answerLine("late "));
      setImmediate(() => child.emit("exit", 0, null));
      return true;
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shutdown = provider.shutdown();
      await vi.advanceTimersByTimeAsync(20_000);
      await shutdown;
    } finally {
      vi.useRealTimers();
    }

    expect(turnTexts(events)).toEqual(["before ", "late "]);
    expect(turnEventsOf(events).slice(-2)).toMatchObject([
      { type: AgentEventType.AssistantMessageBoundary, content: "before late " },
      { type: AgentEventType.Ended, reason: "provider_lost" },
    ]);
    expect(turnEnds(events)).toHaveLength(1);
  });

  it("interrupts a turn stopped before turn/start answers once the answer binds it, and saves its output and real end", async () => {
    const { provider, child, starts, events } = createProvider();
    child.holdTurnStart = true;
    child.kill.mockImplementation(() => true);
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    child.interruptReply = (interrupt) => {
      const output = interrupt.params?.turnId === "native-turn-1" ? answerLine("late ") + completionLine("interrupted") : "";
      child.stdout.write(output + JSON.stringify({ id: interrupt.id, result: {} }) + "\n");
    };

    const shutdown = provider.shutdown();
    await settleIo();
    child.answerHeldTurnStart();
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalled());
    child.emit("exit", 0, null);
    await shutdown;

    expect(child.requests.some(({ method, params }) => method === "turn/interrupt" && params?.turnId === "native-turn-1")).toBe(true);
    expect(turnTexts(events)).toEqual(["late "]);
    expect(turnEnds(events)).toEqual([{
      type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: request.turnExecutionId, outcome: "cancelled",
    }]);
  });

  it("interrupts the bound turn when a user Stop arrives before turn/start answers", async () => {
    const { provider, child, starts, events } = createProvider();
    child.holdTurnStart = true;
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));

    const stop = provider.stopSession(request.sessionId);
    await settleIo();
    child.answerHeldTurnStart();
    await stop;

    expect(child.requests.some(({ method, params }) => method === "turn/interrupt" && params?.turnId === "native-turn-1")).toBe(true);
    expect(turnEnds(events)).toEqual([{
      type: AgentEventType.Ended, threadId: request.threadId, turnExecutionId: request.turnExecutionId, outcome: "cancelled",
    }]);
    expect(child.kill).not.toHaveBeenCalled();
    await provider.shutdown();
  });

  it("ends a turn stopped before turn/start answers once when turn/start then fails", async () => {
    const { provider, child, starts, events } = createProvider();
    child.holdTurnStart = true;
    child.kill.mockImplementation(() => true);
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));

    const shutdown = provider.shutdown();
    await settleIo();
    child.failHeldTurnStart("turn rejected");
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalled());
    child.emit("exit", 0, null);
    await shutdown;

    expect(turnEnds(events)).toMatchObject([{ type: AgentEventType.Ended, outcome: "errored" }]);
  });

  it("ends a turn stopped before turn/start answers once as provider_lost when the server closes first, keeping its output", async () => {
    const { provider, child, starts, events } = createProvider();
    child.holdTurnStart = true;
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    // Codex can stream a turn before it answers turn/start.
    child.stdout.write(answerLine("early "));
    await vi.waitFor(() => expect(turnTexts(events)).toEqual(["early "]));
    child.kill.mockImplementationOnce(() => {
      child.stdout.write(answerLine("late "));
      setImmediate(() => child.emit("exit", 0, null));
      return true;
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const shutdown = provider.shutdown();
      await vi.advanceTimersByTimeAsync(20_000);
      await shutdown;
    } finally {
      vi.useRealTimers();
    }

    expect(child.requests.some(({ method, params }) => method === "turn/interrupt" && params?.turnId)).toBe(false);
    expect(turnTexts(events)).toEqual(["early ", "late "]);
    expect(turnEnds(events)).toMatchObject([{ type: AgentEventType.Ended, reason: "provider_lost" }]);
  });

  it("settles a user Stop without its timeouts while saving is behind, and publishes nothing past the fence", async () => {
    let releaseFirstSave!: () => void;
    const firstSaveBlocked = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    let releaseLaterSaves!: () => void;
    const laterSavesBlocked = new Promise<void>((resolve) => { releaseLaterSaves = resolve; });
    let firstSave = true;
    const { provider, child, starts, events } = createProvider({ submit: async (batch) => {
      // Saving stays behind after the first save too, so only discarding the backlog can resume the stream.
      const gate = firstSave ? firstSaveBlocked : laterSavesBlocked;
      firstSave = false;
      await gate;
      return { commit: { outcome: "committed", conversationRevision: 1, rosterRevision: 0, acceptedThrough: 1,
        durableThrough: 1, eventCount: batch.events.length }, delivery: { ingress: "queued" } };
    } });
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    const deltas = Array.from({ length: 400 }, (_, index) => `${index} `);
    child.stdout.write(deltas.map(answerLine).join(""));
    await vi.waitFor(() => expect(child.stdout.isPaused()).toBe(true));
    // The interrupt's answer queues behind the held output, so it is read only once the stream resumes.
    child.interruptReply = (interrupt) => {
      child.stdout.write(answerLine("after stop ") + completionLine("interrupted")
        + JSON.stringify({ id: interrupt.id, result: {} }) + "\n");
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fenced = provider.fenceCanonicalTurnEvents({ threadId: request.threadId, turnId: request.turnId,
        executionId: request.turnExecutionId, deliveryAttempt: 1 }, { discardQueued: true });
      let stopped = false;
      const stop = provider.stopSession(request.sessionId).then(() => { stopped = true; });
      releaseFirstSave();
      await fenced;
      // No timer advances: Stop settles on the interrupt's real answer, not on a timeout.
      await vi.waitFor(() => expect(stopped).toBe(true));
      await stop;
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    releaseLaterSaves();
    await provider.shutdown();

    // Only the save already in flight at the fence lands; the held text, the late text, and the end do not.
    const texts = turnTexts(events);
    expect(texts.length).toBeLessThan(deltas.length);
    expect(texts).toEqual(deltas.slice(0, texts.length));
    expect(turnEnds(events)).toEqual([]);
  });

  it("publishes nothing past the Stop fence while a slow interrupt and teardown settle", async () => {
    const { provider, child, starts, events } = createProvider();
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    child.stdout.write(answerLine("before "));
    await vi.waitFor(() => expect(turnTexts(events)).toEqual(["before "]));
    child.interruptReply = (interrupt) => {
      if (interrupt.params?.turnId) return;
      child.stdout.write(answerLine("late ") + completionLine("completed") + JSON.stringify({ id: interrupt.id, result: {} }) + "\n");
    };
    const published = events.length;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fenced = provider.fenceCanonicalTurnEvents({ threadId: request.threadId, turnId: request.turnId,
        executionId: request.turnExecutionId, deliveryAttempt: 1 }, { discardQueued: true });
      const stop = provider.stopSession(request.sessionId);
      await fenced;
      await vi.advanceTimersByTimeAsync(30_000);
      await stop;
      await provider.shutdown();
    } finally {
      vi.useRealTimers();
    }

    expect(turnEventsOf(events.slice(published))).toEqual([]);
  });

  it("steers the running native turn by its id and maps a vanished turn to turn_not_running", async () => {
    const { provider, child, complete } = createProvider();
    const steer = { sessionId: request.sessionId, threadId: request.threadId, turnExecutionId: request.turnExecutionId,
      steerId: STEER_ID, message: "also check the tests" };
    try {
      await provider.sendTurn(request);
      // Steers before the native turn id is known are refused locally and send nothing.
      await vi.waitFor(async () => expect(await provider.steerTurn(steer)).toEqual({ outcome: "accepted" }));
      child.steerError = "expected active turn id `native-turn-1` but found `native-turn-2`";
      const stale = await provider.steerTurn({ ...steer, steerId: "0b5f5c1e-2a3d-4c6e-8f90-a1b2c3d4e5f6" });

      expect(child.requests.filter(({ method }) => method === "turn/steer").map(({ params }) => params)).toEqual([
        { threadId: "native-thread", expectedTurnId: "native-turn-1", clientUserMessageId: STEER_ID,
          input: [{ type: "text", text: "also check the tests" }] },
        { threadId: "native-thread", expectedTurnId: "native-turn-1",
          clientUserMessageId: "0b5f5c1e-2a3d-4c6e-8f90-a1b2c3d4e5f6", input: [{ type: "text", text: "also check the tests" }] },
      ]);
      expect(stale).toEqual({ outcome: "rejected", reason: "turn_not_running",
        detail: "expected active turn id `native-turn-1` but found `native-turn-2`" });
      await complete(1, request.turnExecutionId);
      expect(await provider.steerTurn(steer)).toEqual({ outcome: "rejected", reason: "turn_not_running",
        detail: "The Codex turn is not running." });
    } finally {
      await provider.shutdown();
    }
  });

  it("steers with the native mention parts a new turn would send", async () => {
    const { provider, child } = createProvider();
    const message = "also read @notes.md";
    const steer = { sessionId: request.sessionId, threadId: request.threadId, turnExecutionId: request.turnExecutionId,
      steerId: STEER_ID, message,
      mentions: [{ id: "mention-notes", kind: "file" as const, label: "notes.md", path: "docs/notes.md", range: { start: 10, end: 19 } }] };
    try {
      await provider.sendTurn(request);
      await vi.waitFor(async () => expect(await provider.steerTurn(steer)).toEqual({ outcome: "accepted" }));

      expect(child.requests.filter(({ method }) => method === "turn/steer").map(({ params }) => params)).toEqual([
        { threadId: "native-thread", expectedTurnId: "native-turn-1", clientUserMessageId: STEER_ID,
          input: [{ type: "mention", name: "notes.md", path: "docs/notes.md" }, { type: "text", text: message }] },
      ]);
    } finally {
      await provider.shutdown();
    }
  });

  it.each([["0.98.9", false], ["0.99.0", true]])("declares turn-steer for Codex CLI %s: %s", (version, supported) => {
    const { provider } = createProvider();
    cli.version = version;

    expect(checkCodexVersion("codex")).toEqual({ ok: true, version });
    expect(isTurnSteerCapable(provider)).toBe(supported);
  });

  it("keeps the process after completion and starts the next turn on the same transport", async () => {
    const { provider, child, complete } = createProvider();
    try {
      await provider.sendTurn(request);
      await complete(1, "63093cff-69b8-4efb-82db-20a75f993612");
      expect(child.kill).not.toHaveBeenCalled();
      await provider.sendTurn({ ...request, turnId: "turn-2", turnExecutionId: "44fa60e2-d5d4-423a-89d0-7852a1e951de" });
      await complete(2, "44fa60e2-d5d4-423a-89d0-7852a1e951de");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      await provider.discardSession(request.sessionId);
      await provider.shutdown();
    }
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("cancels a reused turn during settings preparation without poisoning the next turn", async () => {
    const { provider, child, settings, getSettings, starts, complete } = createProvider();
    try {
      await provider.sendTurn(request);
      await complete(1, "63093cff-69b8-4efb-82db-20a75f993612");
      let releaseSettings!: (value: typeof settings) => void;
      getSettings.mockImplementationOnce(() => new Promise((resolve) => { releaseSettings = resolve; }));
      const sending = provider.sendTurn({ ...request, turnId: "turn-2", turnExecutionId: "44fa60e2-d5d4-423a-89d0-7852a1e951de" });
      await vi.waitFor(() => expect(releaseSettings).toBeTypeOf("function"));
      await provider.stopSession(request.sessionId);
      releaseSettings(settings);
      await sending;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(starts()).toHaveLength(1);
      expect(child.kill).not.toHaveBeenCalled();
      await provider.sendTurn({ ...request, turnId: "turn-3", turnExecutionId: "5e53289f-8482-4b33-8d2d-9eef25d7899c" });
      await complete(2, "5e53289f-8482-4b33-8d2d-9eef25d7899c");
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await provider.discardSession(request.sessionId);
      await provider.shutdown();
    }
  });
});
