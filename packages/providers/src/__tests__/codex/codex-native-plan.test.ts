import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { NativePlanQuestionBatch, PlanQuestionSettlement, ProviderRuntimeEvent, TurnRequest } from "@mcode/contracts";
import { CodexProvider, stubEnvService } from "./codex-provider-test-fixture.js";
import { clearVersionCache } from "../../private/codex/codex-version.js";
import { loadPlanProtocolFixture } from "../../conformance/plan-probes/fixture.js";

const { spawn, cli } = vi.hoisted(() => ({ spawn: vi.fn(), cli: { version: "0.161.0" } }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn,
  spawnSync: () => ({ status: 0, stdout: `codex-cli ${cli.version}`, stderr: "" }),
}));
vi.mock("which", () => ({ default: async () => "/usr/bin/codex" }));

const rpcSchema = z.object({ id: z.number().optional(), method: z.string().optional(),
  params: z.record(z.unknown()).optional(), result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional() });
type Rpc = z.infer<typeof rpcSchema>;

class NativeProcess extends NodeEvents.EventEmitter {
  readonly stdin = new NodeStream.PassThrough();
  readonly stdout = new NodeStream.PassThrough();
  readonly stderr = new NodeStream.PassThrough();
  readonly requests: Rpc[] = [];
  private count = 0;
  private buffer = "";
  readonly kill = () => { setImmediate(() => this.emit("exit", 0, null)); return true; };

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) this.receive(rpcSchema.parse(JSON.parse(line)));
    });
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(JSON.stringify({ method, params }) + "\n");
  }

  complete(status = "completed"): void {
    this.notify("turn/completed", { threadId: "ID_4", turn: { id: `ID_${this.count + 5}`, status, items: [] } });
  }

  private receive(request: Rpc): void {
    this.requests.push(request);
    if (request.id === undefined || !request.method) return;
    let result: unknown = {};
    if (request.method === "thread/start") result = { thread: { id: "ID_4" } };
    if (request.method === "turn/start") result = { turn: { id: `ID_${++this.count + 5}` } };
    if (request.method === "config/read") result = { config: {} };
    this.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
    if (request.method === "turn/interrupt") this.complete("interrupted");
  }
}

const turn: TurnRequest<"codex"> = {
  turnId: "turn", turnExecutionId: "execution", sessionId: "mcode-native-plan", threadId: "native-plan",
  workspaceId: "fixture", cwd: process.cwd(), message: "Plan a greeting", model: "gpt-6.1-sol",
  reasoningLevel: "low", permissionMode: "full", approvalReviewMode: "manual", interactionMode: "plan",
  providerOptions: {}, threadControlEligible: false, planTurn: { kind: "planning", planFilePath: null },
};

function fixture(bind = true) {
  const child = new NativeProcess();
  spawn.mockImplementation(() => { setImmediate(() => child.emit("spawn")); return child; });
  const provider = new CodexProvider({ get: async () => ({ provider: { cli: { codex: "codex" } } }) },
    stubEnvService(), { persistGeneratedImageFromPath: () => { throw new Error("Unexpected image"); } }, {
      listModels: async () => [], currentSkills: () => [], currentPrompts: () => [],
      refreshCustomPrompts: async () => ({ prompts: [] }), shutdown: async () => {},
    });
  const batches: NativePlanQuestionBatch[] = [];
  const settlements: PlanQuestionSettlement[] = [];
  const events: ProviderRuntimeEvent[] = [];
  if (bind) provider.bindPlanQuestions({
    requested: async batch => { batches.push(batch); },
    settled: async (_batch, status) => { settlements.push(status); },
  });
  provider.on("event", event => events.push(event));
  const starts = () => child.requests.filter(request => request.method === "turn/start");
  return { provider, child, batches, settlements, events, starts };
}

function capturedQuestion() {
  const capture = loadPlanProtocolFixture(NodeURL.fileURLToPath(new URL("../../conformance/fixtures/plan-protocol/r1-codex-questions-free-text.captured.json", import.meta.url)));
  const message = capture.input.messages.find(entry => entry.operation === "item/tool/requestUserInput" && entry.kind === "request");
  if (!message) throw new Error("Captured question missing");
  const value = (at: string) => {
    const field = message.fields.find(entry => entry.at === at);
    if (!field) throw new Error(`Captured field missing: ${at}`);
    if (field.kind === "identity") return field.alias;
    if (field.kind === "literal") return field.value;
    return `Fixture ${at}`;
  };
  return { threadId: value("threadId"), turnId: value("turnId"), itemId: value("itemId"),
    isBlocking: value("isBlocking"), questions: [{
      id: value("questions.0.id"), header: value("questions.0.header"), question: value("questions.0.question"),
      isOther: value("questions.0.isOther"), isSecret: value("questions.0.isSecret"),
      options: [0, 1].map(index => ({ label: value(`questions.0.options.${index}.label`),
        description: value(`questions.0.options.${index}.description`) })),
    }] };
}

async function ask(f: ReturnType<typeof fixture>) {
  await f.provider.sendTurn(turn);
  await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
  f.child.stdout.write(JSON.stringify({ id: 90, method: "item/tool/requestUserInput", params: capturedQuestion() }) + "\n");
  await vi.waitFor(() => expect(f.batches).toHaveLength(1));
  const batch = f.batches[0];
  if (!batch) throw new Error("Question not published");
  return batch;
}

afterEach(() => { vi.clearAllMocks(); clearVersionCache(); cli.version = "0.161.0"; });

describe("Codex native planning", () => {
  it("sends JSON-RPC cancellation for a secret question without publishing a batch", async () => {
    const f = fixture();
    try {
      await f.provider.sendTurn(turn);
      await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
      const params = capturedQuestion();
      f.child.stdout.write(JSON.stringify({ id: 90, method: "item/tool/requestUserInput", params: {
        ...params, questions: params.questions.map(question => ({ ...question, isSecret: true })),
      } }) + "\n");
      await vi.waitFor(() => expect(f.child.requests.find(request => request.id === 90)?.error?.code).toBe(-32800));
      expect(f.batches).toEqual([]);
      expect(f.settlements).toEqual([]);
      f.child.complete();
    } finally { await f.provider.shutdown(); }
  });

  it.each([{ version: "0.160.0", bind: true }, { version: "0.161.0-alpha.1", bind: true }, { version: "0.161.0", bind: false }])(
    "does not enable native mode on $version with handler=$bind", async ({ version, bind }) => {
      cli.version = version;
      const f = fixture(bind);
      try {
        await f.provider.sendTurn(turn);
        await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
        expect(f.starts()[0]?.params).not.toHaveProperty("collaborationMode");
        f.child.complete();
      } finally { await f.provider.shutdown(); }
    });

  it("uses native plan settings and explicitly returns the next build turn to default", async () => {
    const f = fixture();
    try {
      await f.provider.sendTurn(turn);
      await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
      expect(f.starts()[0]?.params).toMatchObject({ collaborationMode: { mode: "plan",
        settings: { model: "gpt-6.1-sol", reasoning_effort: "low", developer_instructions: null } }, additionalContext: {} });
      f.child.complete();
      await vi.waitFor(() => expect(f.events.some(event => event.event.type === "ended")).toBe(true));
      await f.provider.sendTurn({ ...turn, turnId: "build", turnExecutionId: "build-execution", planTurn: undefined, interactionMode: "build" });
      await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
      expect(f.starts()[1]?.params?.collaborationMode).toEqual({ mode: "default",
        settings: { model: "gpt-6.1-sol", reasoning_effort: "low", developer_instructions: null } });
      f.child.complete();
      await vi.waitFor(() => expect(f.events.filter(event => event.event.type === "ended")).toHaveLength(2));
      await f.provider.sendTurn({ ...turn, turnId: "build-again", turnExecutionId: "build-again-execution", planTurn: undefined, interactionMode: "build" });
      await vi.waitFor(() => expect(f.starts()).toHaveLength(3));
      expect(f.starts()[2]?.params).not.toHaveProperty("collaborationMode");
      f.child.complete();
    } finally { await f.provider.shutdown(); }
  });

  it("does not override collaboration settings on an initial build turn", async () => {
    const f = fixture();
    try {
      await f.provider.sendTurn({ ...turn, planTurn: undefined, interactionMode: "build" });
      await vi.waitFor(() => expect(f.starts()).toHaveLength(1));
      expect(f.starts()[0]?.params).not.toHaveProperty("collaborationMode");
      f.child.complete();
    } finally { await f.provider.shutdown(); }
  });

  it("round-trips the captured question with free text in the same native turn", async () => {
    const f = fixture();
    try {
      const batch = await ask(f);
      expect(batch.questions[0]?.category).toBe("Fixture questions.0.header");
      expect(await f.provider.respondToPlanQuestions(turn.threadId, batch.requestId, [{
        questionId: batch.questions[0]!.id, selectedOptionId: null, freeText: "Use a cheerful greeting.",
      }])).toBe(true);
      expect(f.child.requests.find(request => request.id === 90)).toEqual({ id: 90,
        result: { answers: { ID_9: { answers: ["Use a cheerful greeting."] } } } });
      expect(f.starts()).toHaveLength(1);
      expect(f.settlements).toEqual(["answered"]);
      expect(await f.provider.respondToPlanQuestions(turn.threadId, batch.requestId, "dismiss")).toBe(false);
      f.child.complete();
    } finally { await f.provider.shutdown(); }
  });

  it.each(["stop", "dismiss", "exit"] as const)("settles %s without leaving a native responder", async action => {
    const f = fixture();
    try {
      const batch = await ask(f);
      if (action === "stop") await f.provider.stopSession(turn.sessionId);
      else if (action === "dismiss") await f.provider.respondToPlanQuestions(turn.threadId, batch.requestId, "dismiss");
      else f.child.emit("exit", 1, null);
      await vi.waitFor(() => expect(f.settlements).toEqual([action === "exit" ? "expired" : "dismissed"]));
      expect(await f.provider.respondToPlanQuestions(turn.threadId, batch.requestId, "dismiss")).toBe(false);
      const response = f.child.requests.find(request => request.id === 90);
      if (action === "stop") {
        expect(response?.error?.code).toBe(-32800);
        expect(f.child.requests.indexOf(response!)).toBeLessThan(f.child.requests.findIndex(request => request.method === "turn/interrupt"));
      } else if (action === "dismiss") {
        expect(response?.result).toEqual({ answers: { ID_9: { answers: [] } } });
        f.child.complete();
      } else {
        expect(response).toBeUndefined();
        await vi.waitFor(() => expect(f.events.filter(event => event.event.type === "ended").map(event => event.event))
          .toEqual([{ type: "ended", threadId: "native-plan", turnExecutionId: "execution", outcome: "interrupted" }]));
      }
    } finally { await f.provider.shutdown(); }
  });

  it("expires a provider-resolved request without delivering a late answer", async () => {
    const f = fixture();
    try {
      const batch = await ask(f);
      f.child.notify("serverRequest/resolved", { threadId: "ID_4", requestId: 90 });
      await vi.waitFor(() => expect(f.settlements).toEqual(["expired"]));
      expect(await f.provider.respondToPlanQuestions(turn.threadId, batch.requestId, "dismiss")).toBe(false);
      expect(f.child.requests.filter(request => request.id === 90)).toEqual([]);
      f.child.complete();
    } finally {
      await f.provider.shutdown();
    }
  });
});
