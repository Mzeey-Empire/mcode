import "reflect-metadata";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, IAgentProvider, IProviderRegistry } from "@mcode/contracts";
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
import { CodexPlanQuestions } from "../../../../../../../packages/providers/src/private/codex/codex-plan-questions.js";

afterEach(closeAgentStorageTestDatabases);

async function fixture() {
  const db = openAgentStorageTestDatabase();
  const writer = agentStorageTestWriter(db);
  const threads = new ThreadRepo(db, writer);
  const workspace = await new WorkspaceRepo(db, writer).create("Native questions", process.cwd());
  const thread = await threads.create(workspace.id, "Planning", "direct", "main", false, "codex");
  await threads.updateSettings(thread.id, { interaction_mode: "plan" });
  const messages = new MessageRepo(db, writer);
  const plans = new PlanRepo(db, writer);
  const records = new PlanQuestionAnswersRepo(db, writer);
  const native = new CodexPlanQuestions();
  const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
    id: "codex" as const, descriptor: { id: "codex" as const, capabilities: [] },
    supportsCompletion: false, sessionForkOnResume: "unsupported" as const, maxInputCharactersPerTurn: 100_000,
    forker: { fork: async () => { throw new Error("Unused fork"); } },
    sendTurn: async () => { throw new Error("Answers must resume the same turn"); },
    stopSession: () => {}, shutdown: () => {}, listModels: async () => [],
    bindPlanQuestions: native.bind.bind(native), supportsNativePlanQuestions: async () => native.enabled,
    respondToPlanQuestions: native.answer.bind(native),
  });
  const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
  const service = new PlanTurnService(threads, providers, new PlanQuestionService(messages, records), plans,
    new AgentTurnCommandPort(new AgentRuntimeCommandPort()));
  const published: AgentEvent[] = [];
  service.bindNativeQuestions(event => published.push(event));
  await service.prepareNativeQuestions(thread.id, "codex");
  const responses: unknown[] = [];
  const ask = () => native.request("session", thread.id, "native-thread", "native-turn", {
    rpcId: 90,
    params: { threadId: "native-thread", turnId: "native-turn", itemId: "item", isBlocking: true,
      questions: [{ id: "tone", header: "Tone", question: "Which greeting?", isOther: true, isSecret: false,
        options: [{ label: "Brief", description: "One sentence" }, { label: "Detailed", description: "A paragraph" }] }] },
    respond: async response => { responses.push(response); }, cancel: async () => { responses.push({ code: -32800 }); },
  });
  const snapshot = () => writer.execute(planWriteOperations.snapshot, { threadId: thread.id });
  return { db, writer, thread, threads, messages, plans, records, native, provider, service, responses, published, ask, snapshot };
}

describe("Native plan questions on the application writer", () => {
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
    expect(f.responses).toEqual([{ answers: { tone: { answers: ["Use a cheerful greeting."] } } }]);
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
    expect(f.responses).toEqual(expectedResponses[action]);
  });

  it("rejects a stale answer without consuming the current native request", async () => {
    const f = await fixture();
    await f.ask();
    await expect(f.service.answerQuestions(f.thread.id, [{ questionId: "stale", selectedOptionId: "0", freeText: null }])).rejects.toThrow();
    expect(f.responses).toEqual([]);
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
    case "exit": return f.native.drain("session", "expired");
    case "restart": return f.service.recoverNativeQuestions();
    case "stop": return f.native.drain("session", "dismissed");
    case "dismiss": return f.service.dismissQuestions(f.thread.id);
  }
}
