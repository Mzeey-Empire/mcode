import "reflect-metadata";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentEvent, IProviderRegistry, TurnRequest } from "@mcode/contracts";
import { createCodexProvider } from "@mcode/providers";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../../orchestration/agent-turn-command-port.js";
import { PlanRepo } from "../persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../persistence/plan-question-answers-repo.js";
import { PlanQuestionService } from "../plan-question-service.js";
import { PlanTurnService } from "../plan-turn-service.js";
import { planWriteOperations } from "../persistence/plan-write-operations.js";
import { registerAgentStorageTestProducer } from "../../__tests__/agent-storage-fixture.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn,
  spawnSync: () => ({ status: 0, stdout: "codex-cli 0.161.0", stderr: "" }),
}));
vi.mock("which", () => ({ default: async () => "/usr/bin/codex" }));

const rpcSchema = z.object({ id: z.number().optional(), method: z.string().optional(),
  result: z.unknown().optional(), error: z.object({ code: z.number() }).optional() });

class NativeProcess extends NodeEvents.EventEmitter {
  readonly stdin = new NodeStream.Transform({ transform: (chunk: Buffer, _encoding, callback) => {
    this.stdin.push(chunk);
    const request = rpcSchema.parse(JSON.parse(chunk.toString()));
    if (request.id === 90 && this.responseGate) void this.responseGate.then(() => callback(), callback);
    else callback();
  } });
  readonly stdout = new NodeStream.PassThrough();
  readonly stderr = new NodeStream.PassThrough();
  readonly requests: z.infer<typeof rpcSchema>[] = [];
  responseGate: Promise<void> | undefined;
  private buffer = "";
  readonly kill = () => { setImmediate(() => this.emit("exit", 0, null)); return true; };

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const request = rpcSchema.parse(JSON.parse(line));
        this.requests.push(request);
        if (!request.method || request.id === undefined) continue;
        const result = request.method === "thread/start" ? { thread: { id: "native-thread" } }
          : request.method === "turn/start" ? { turn: { id: "native-turn" } } : {};
        this.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
        if (request.method === "turn/interrupt") this.stdout.write(JSON.stringify({ method: "turn/completed",
          params: { threadId: "native-thread", turn: { id: "native-turn", status: "interrupted", items: [] } } }) + "\n");
      }
    });
  }
}

function createProvider(child: NativeProcess) {
  spawn.mockImplementation(() => { setImmediate(() => child.emit("spawn")); return child; });
  return createCodexProvider({ configuration: { cliPath: "codex", idleSessionTtlMs: 600_000 },
    host: {
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
      environment: { snapshot: () => ({}) }, processes: { attach: () => {}, terminateTree: async () => {} },
      browser: { stage: () => ({ leaseId: "unused", expiresAt: 0 }), releaseSession: () => 0,
        isConfigured: () => false, issue: () => null, refresh: () => { throw new Error("Unused browser"); },
        release: leaseId => ({ leaseId, released: false }), revokeCredential: () => false },
      mcode: { attach: async () => null, close: async () => {} }, grants: { consume: () => false },
      events: { submit: async () => { throw new Error("Unexpected canonical event"); } },
    },
    codex: { settings: { get: async () => ({ cliPath: "codex", fastMode: false }) },
      attachments: { persistGeneratedImageFromPath: () => { throw new Error("Unexpected image"); } },
      catalog: { listModels: async () => [], currentSkills: () => [], currentPrompts: () => [],
        refreshCustomPrompts: async () => ({ prompts: [] }), shutdown: async () => {} } },
  });
}

afterEach(closeAgentStorageTestDatabases);

async function fixture(interactionMode: "plan" | "build" = "plan") {
  const db = openAgentStorageTestDatabase();
  const writer = agentStorageTestWriter(db);
  const threads = new ThreadRepo(db, writer);
  const workspace = await new WorkspaceRepo(db, writer).create("Native questions", process.cwd());
  const thread = await threads.create(workspace.id, "Planning", "direct", "main", false, "codex");
  await threads.updateSettings(thread.id, { interaction_mode: interactionMode });
  const messages = new MessageRepo(db, writer);
  const plans = new PlanRepo(db, writer);
  const records = new PlanQuestionAnswersRepo(db, writer);
  const child = new NativeProcess();
  const provider = createProvider(child);
  registerAgentStorageTestProducer(db, () => Promise.resolve(provider.shutdown()));
  const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
  const service = new PlanTurnService(threads, providers, new PlanQuestionService(messages, records), plans,
    new AgentTurnCommandPort(new AgentRuntimeCommandPort()));
  const published: AgentEvent[] = [];
  service.bindNativeQuestions(event => published.push(event));
  await service.prepareNativeQuestions(thread.id, "codex");
  await service.admitted(thread.id, service.classify({ threadId: thread.id }));
  const responses = () => child.requests.filter(request => request.id === 90).map(request => request.error ?? request.result);
  const request: TurnRequest<"codex"> = { threadId: thread.id, turnId: "turn", turnExecutionId: "execution",
    sessionId: `mcode-${thread.id}`, workspaceId: workspace.id, cwd: process.cwd(), message: "Plan a greeting",
    model: "gpt-6.1-sol", permissionMode: "full", approvalReviewMode: "manual", interactionMode,
    providerOptions: {},
    ...(interactionMode === "plan" ? { planTurn: { kind: "planning", planFilePath: null } } : {}) };
  const ask = async () => {
    await provider.sendTurn(request);
    await vi.waitFor(() => expect(child.requests.filter(request => request.method === "turn/start")).toHaveLength(1));
    child.stdout.write(JSON.stringify({ id: 90, method: "item/tool/requestUserInput",
    params: { threadId: "native-thread", turnId: "native-turn", itemId: "item", isBlocking: true,
      questions: [{ id: "tone", header: "Tone", question: "Which greeting?", isOther: true, isSecret: false,
        options: [{ label: "Brief", description: "One sentence" }, { label: "Detailed", description: "A paragraph" }] }] },
    }) + "\n");
    await vi.waitFor(() => expect(records.pendingNative(thread.id)).toHaveLength(1));
  };
  const snapshot = () => writer.execute(planWriteOperations.snapshot, { threadId: thread.id });
  return { db, writer, thread, threads, messages, plans, records, child, provider, service, responses, published, ask, snapshot };
}

describe("Native plan questions on the application writer", () => {
  it.each(["answer", "dismiss"])("keeps one answered receipt when a concurrent %s races delivery", async action => {
    const f = await fixture();
    await f.ask();
    const batch = f.records.pendingNative(f.thread.id)[0]!;
    const answers = [{ questionId: batch.questions[0]!.id, selectedOptionId: "0", freeText: null }];
    const delivery = Promise.withResolvers<void>();
    f.child.responseGate = delivery.promise;
    const first = f.service.answerQuestions(f.thread.id, answers);
    try {
      const second = action === "answer" ? f.service.answerQuestions(f.thread.id, answers) : f.service.dismissQuestions(f.thread.id);
      await expect(second).rejects.toBeInstanceOf(Error);
      expect(f.messages.listByThread(f.thread.id).messages).toEqual([]);
      expect(await f.snapshot()).toMatchObject({ phase: "questions" });
    } finally { delivery.resolve(); await first; }
    expect(f.responses()).toEqual([{ answers: { tone: { answers: ["Brief"] } } }]);
    expect(f.messages.listByThread(f.thread.id).messages.map(message => message.content)).toEqual(["Answered 1 question"]);
    expect(await f.snapshot()).toMatchObject({ phase: "planning", pendingQuestions: null });
  });

  it.each(["answer", "dismiss"])("does not enter the plan flow for a build question or its %s", async action => {
    const f = await fixture("build");
    await f.ask();
    expect(f.threads.findById(f.thread.id)?.plan_phase).toBeNull();
    const batch = f.records.pendingNative(f.thread.id)[0]!;
    if (action === "answer") await f.service.answerQuestions(f.thread.id, [{ questionId: batch.questions[0]!.id,
      selectedOptionId: "0", freeText: null }]);
    else await f.service.dismissQuestions(f.thread.id);
    expect(f.threads.findById(f.thread.id)?.plan_phase).toBeNull();
    expect(f.records.pendingNative(f.thread.id)).toEqual([]);
  });

  it("updates the thread timestamp when a native question changes its plan phase", async () => {
    const f = await fixture();
    f.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", f.thread.id);
    await f.ask();
    expect(f.threads.findById(f.thread.id)?.updated_at).not.toBe("2000-01-01T00:00:00.000Z");
    f.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", f.thread.id);
    await f.service.dismissQuestions(f.thread.id);
    expect(f.threads.findById(f.thread.id)?.updated_at).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("reloads a durable dock and delivers free text through its still-live responder", async () => {
    const f = await fixture();
    expect(f.service.classify({ threadId: f.thread.id })).toEqual({ kind: "planning", planFilePath: null });
    await f.ask();
    const reopened = await f.snapshot();
    if (!reopened.ok || !reopened.pendingQuestions) throw new Error("Reload lost the question");
    expect(reopened.phase).toBe("questions");
    expect(reopened.pendingQuestions.questions).toMatchObject([{ category: "Tone", question: "Which greeting?" }]);
    await f.service.answerQuestions(f.thread.id, [{ questionId: reopened.pendingQuestions.questions[0]!.id,
      selectedOptionId: null, freeText: "Use a cheerful greeting." }]);
    expect(f.responses()).toEqual([{ answers: { tone: { answers: ["Use a cheerful greeting."] } } }]);
    expect(f.child.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    expect(await f.snapshot()).toMatchObject({ ok: true, phase: "planning", pendingQuestions: null });
    expect(f.records.pendingNative(f.thread.id)).toEqual([]);
    expect(f.messages.listByThread(f.thread.id).messages.map(message => message.content)).toEqual(["Answered 1 question"]);
  });

  it.each(["exit", "restart", "stop", "dismiss"] as const)("settles %s durably and removes the answerable dock", async action => {
    const f = await fixture();
    await f.ask();
    const batch = f.records.pendingNative(f.thread.id)[0];
    if (!batch) throw new Error("Batch missing");
    await settleAction(f, action);
    const status = action === "exit" || action === "restart" ? "expired" : "dismissed";
    expect(f.db.query("SELECT status FROM plan_question_answers WHERE id = ?").get(batch.requestId)).toEqual({ status });
    expect(await f.snapshot()).toMatchObject({ ok: true, phase: null, pendingQuestions: null });
    expect(f.messages.listByThread(f.thread.id).messages.map(message => message.content)).toEqual([
      status === "expired" ? "Questions expired" : "Questions dismissed",
    ]);
    await expect(f.service.answerQuestions(f.thread.id, [{ questionId: batch.questions[0]!.id,
      selectedOptionId: "0", freeText: null }])).rejects.toThrow("Questions expired");
    const expectedResponses = {
      stop: [{ code: -32800 }], dismiss: [{ answers: { tone: { answers: [] } } }], exit: [], restart: [],
    };
    expect(f.responses()).toEqual(expectedResponses[action]);
  });

  it("rejects a stale answer without consuming the current native request", async () => {
    const f = await fixture();
    await f.ask();
    await expect(f.service.answerQuestions(f.thread.id, [{ questionId: "stale", selectedOptionId: "0", freeText: null }])).rejects.toThrow();
    expect(f.responses()).toEqual([]);
    expect(await f.snapshot()).toMatchObject({ ok: true, phase: "questions" });
    const current = f.records.pendingNative(f.thread.id)[0];
    expect(current?.questions[0]?.question).toBe("Which greeting?");
    await f.service.dismissQuestions(f.thread.id);
  });

  it("preserves old answered markers when migrating native question storage", async () => {
    const f = await fixture();
    const message = await f.messages.create(f.thread.id, "assistant", "Prior questions", 1);
    f.db.run("DROP TABLE plan_question_answers");
    f.db.run(`CREATE TABLE plan_question_answers (
      assistant_message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      answered_at TEXT NOT NULL
    )`);
    f.db.prepare("INSERT INTO plan_question_answers VALUES (?, ?, ?)")
      .run(message.id, f.thread.id, "2026-10-01T10:00:00.000Z");
    const migration = NodeFS.readFileSync(new URL("../../../../../drizzle/0088_tearful_shinko_yamashiro.sql", import.meta.url), "utf8");
    f.db.transaction(() => f.db.exec(migration))();
    expect(f.records.listAnsweredForThread(f.thread.id)).toEqual([message.id]);
    expect(f.records.pendingNative(f.thread.id)).toEqual([]);
    await f.ask();
    await f.service.dismissQuestions(f.thread.id);
    expect(f.records.listAnsweredForThread(f.thread.id)).toEqual([message.id]);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

async function settleAction(f: Awaited<ReturnType<typeof fixture>>, action: "exit" | "restart" | "stop" | "dismiss") {
  switch (action) {
    case "exit":
      f.child.emit("exit", 1, null);
      return vi.waitFor(() => expect(f.records.pendingNative(f.thread.id)).toEqual([]));
    case "restart": return f.service.recoverNativeQuestions();
    case "stop": return f.provider.stopSession(`mcode-${f.thread.id}`);
    case "dismiss": return f.service.dismissQuestions(f.thread.id);
  }
}
