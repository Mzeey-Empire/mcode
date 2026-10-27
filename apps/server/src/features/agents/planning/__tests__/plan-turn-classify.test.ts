import "reflect-metadata";
import * as NodeEvents from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAgentProvider, IProviderRegistry } from "@mcode/contracts/providers/interfaces";
import type { PlanVersionStatus } from "@mcode/contracts/models/plan";
import type { ThreadAttention } from "@mcode/contracts/models/thread-attention";
import type { TurnOutcome } from "@mcode/contracts/models/turn-outcome";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ThreadAttentionService } from "../../../thread-control/attention/thread-attention-service.js";
import { planWaitingSource } from "../../../thread-control/attention/plan-waiting-source.js";
import { PlanRepo } from "../persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../persistence/plan-question-answers-repo.js";
import { PlanQuestionService } from "../plan-question-service.js";
import { PlanTurnService } from "../plan-turn-service.js";
import { PlanService } from "../plan-service.js";
import { PlanFileWriter } from "../plan-file-writer.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../../orchestration/agent-turn-command-port.js";
import type { SendMessageCommand } from "../../turns/turn-admission-dispatch-coordinator.js";

const questions = [{ id: "q1", category: "Storage", question: "Where should data live?", options: [
  { id: "local", title: "Locally", description: "Keep it on this machine" },
  { id: "remote", title: "Remotely", description: "Share it across machines" },
] }];
const questionText = `\`\`\`plan-questions\n${JSON.stringify(questions)}\n\`\`\``;
const planText = "````mcode-plan\n# Local storage\n\nUse SQLite.\n````";

afterEach(closeAgentStorageTestDatabases);

async function fixture() {
  const db = openAgentStorageTestDatabase();
  const writer = agentStorageTestWriter(db);
  const threads = new ThreadRepo(db, writer);
  const messages = new MessageRepo(db, writer);
  const plans = new PlanRepo(db, writer);
  const workspace = await new WorkspaceRepo(db, writer).create("Planning", process.cwd());
  const thread = await threads.create(workspace.id, "Planning", "direct", "main", false, "codex");
  await threads.updateSettings(thread.id, { interaction_mode: "plan" });
  const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
    id: "codex" as const, descriptor: { id: "codex" as const, capabilities: [] },
    supportsCompletion: false,  maxInputCharactersPerTurn: 100_000,

    sendTurn: async () => {}, stopSession: () => {}, shutdown: () => {}, listModels: async () => [],
  });
  const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
  const answers = new PlanQuestionAnswersRepo(db, writer);
  const questionService = new PlanQuestionService(messages, answers);
  const turns = new PlanTurnService(threads, providers, questionService, plans, new AgentTurnCommandPort(new AgentRuntimeCommandPort()));
  const files = new PlanFileWriter(id => plans.listByThread(id), () => process.cwd());
  const service = new PlanService(writer, undefined, files);
  const pushes: ThreadAttention[] = [];
  const attention = new ThreadAttentionService(db, writer,
    [planWaitingSource(db, "questions"), planWaitingSource(db, "plan")],
    { coordinatorsWithUnfinishedTasks: () => new Set<string>() }, value => pushes.push(value));
  threads.attention = attention;
  const classify = (command: Partial<SendMessageCommand> = {}) => turns.classify({ threadId: thread.id, ...command });
  const capture = async () => {
    const message = await messages.create(thread.id, "assistant", planText, messages.getLatestSequenceIncludingInternal(thread.id) + 1);
    await turns.persistAssistantMessage({ type: "message", threadId: thread.id, messageId: message.id, content: planText });
  };
  const publishQuestions = async () => {
    classify();
    await messages.create(thread.id, "assistant", questionText, messages.getLatestSequenceIncludingInternal(thread.id) + 1);
    turns.onTextDelta(thread.id, questionText);
    await vi.waitFor(() => expect(threads.findById(thread.id)?.plan_phase).toBe("questions"));
  };
  return { db, writer, threads, messages, plans, thread, turns, service, attention, pushes, classify, capture, publishQuestions };
}

describe("PlanTurnService admission classification", () => {
  const cases: Array<{ name: string; status?: PlanVersionStatus; command?: Partial<SendMessageCommand>; kind: string }> = [
    { name: "first Plan send", kind: "questions" },
    { name: "answered questions", command: { markPlanAnswerForMessageId: "question" }, kind: "planning" },
    { name: "ready follow-up", status: "ready", kind: "revise" },
    { name: "draft follow-up", status: "draft", kind: "revise" },
    { name: "accepted plan", status: "accepted", kind: "questions" },
    { name: "Implement", status: "ready", command: { planImplement: { requestId: "implement" } }, kind: "implement" },
    { name: "Plan off", status: "ready", command: { interactionMode: "build" }, kind: "none" },
  ];
  it.each(cases)("classifies $name as $kind", async ({ status, command, kind }) => {
    const f = await fixture();
    if (status) {
      const message = await f.messages.create(f.thread.id, "assistant", "Prior plan", 1);
      const plan = await f.plans.create(f.thread.id, message.id, { title: "Prior", contentMd: "# Prior", captureSource: "fence" }, "codex");
      f.db.prepare("UPDATE plans SET status = ? WHERE id = ?").run(status, plan.id);
    }
    const result = f.classify(command);
    expect(result).toEqual(kind === "none" || kind === "implement" ? { kind } : { kind, planFilePath: null });
    if (kind === "planning" || kind === "revise") {
      await f.turns.admitted(f.thread.id, result);
      await f.capture();
      expect(f.plans.getLatestForThread(f.thread.id)?.contentMd).toBe("# Local storage\n\nUse SQLite.");
    }
  });
});

describe("durable planning phases and attention", () => {
  it("publishes questions for an unopened thread, restores its dock after reload, and clears dismissal", async () => {
    const f = await fixture();
    await f.publishQuestions();
    expect(f.pushes.at(-1)?.waiting?.kind).toBe("questions");
    const reloaded = new PlanService(f.writer, undefined, new PlanFileWriter(id => f.plans.listByThread(id), () => process.cwd()));
    const snapshot = await reloaded.snapshot({ threadId: f.thread.id });
    expect(snapshot).toMatchObject({ phase: "questions", versions: [], pendingQuestions: { questions } });
    expect(snapshot.pendingQuestions?.assistantMessageId).toBe(f.messages.listByThread(f.thread.id).messages[0]?.id);
    await f.turns.dismissQuestions(f.thread.id);
    expect(f.threads.findById(f.thread.id)?.plan_phase).toBeNull();
    expect(f.pushes.at(-1)?.waiting).toBeNull();
    expect(await reloaded.snapshot({ threadId: f.thread.id })).toEqual({ versions: [], comments: [], phase: null, pendingQuestions: null, pendingImplement: null });
  });

  it("moves answers through planning to ready and exposes Plan ready without opening the thread", async () => {
    const f = await fixture();
    await f.publishQuestions();
    await f.turns.admitted(f.thread.id, f.classify({ markPlanAnswerForMessageId: "question" }));
    expect(f.threads.findById(f.thread.id)?.plan_phase).toBe("planning");
    expect(f.pushes.at(-1)?.waiting).toBeNull();
    await f.capture();
    expect(f.threads.findById(f.thread.id)?.plan_phase).toBe("ready");
    expect(f.pushes.at(-1)?.waiting?.kind).toBe("plan");
    await f.threads.recordTurnOutcome(f.thread.id, "completed", new Date().toISOString());
    expect(f.threads.findById(f.thread.id)?.plan_phase).toBe("ready");
  });

  it.each(["ready", null] as const)("starts a revise from phase %s without reopening questions", async (phase) => {
    const f = await fixture();
    f.classify({ markPlanAnswerForMessageId: "question" });
    await f.capture();
    if (phase === null) await f.threads.updatePlanPhase(f.thread.id, null);
    const classification = f.classify();
    expect(classification.kind).toBe("revise");
    await f.turns.admitted(f.thread.id, classification);
    expect((await f.service.snapshot({ threadId: f.thread.id })).phase).toBe("planning");
  });

  const endings: Array<{ outcome: TurnOutcome; prior: boolean; phase: string | null }> = [
    { outcome: "completed", prior: false, phase: "no_plan" },
    { outcome: "completed", prior: true, phase: "ready" },
    { outcome: "cancelled", prior: false, phase: null },
    { outcome: "cancelled", prior: true, phase: "ready" },
    { outcome: "errored", prior: false, phase: null },
    { outcome: "errored", prior: true, phase: "ready" },
    { outcome: "interrupted", prior: false, phase: null },
    { outcome: "interrupted", prior: true, phase: "ready" },
  ];
  it.each(endings)("settles $outcome with prior plan=$prior to $phase", async ({ outcome, prior, phase }) => {
    const f = await fixture();
    if (prior) { f.classify({ markPlanAnswerForMessageId: "previous" }); await f.capture(); }
    await f.turns.admitted(f.thread.id, f.classify({ markPlanAnswerForMessageId: "question" }));
    await f.threads.recordTurnOutcome(f.thread.id, outcome, new Date().toISOString());
    expect((await f.service.snapshot({ threadId: f.thread.id })).phase).toBe(phase);
  });

  it.each(["questions", "planning", "ready", "no_plan"] as const)("clears %s when leaving Plan mode", async (phase) => {
    const f = await fixture();
    await f.threads.updatePlanPhase(f.thread.id, phase);
    await f.threads.updateSettings(f.thread.id, { interaction_mode: "build" });
    expect((await f.service.snapshot({ threadId: f.thread.id })).phase).toBeNull();
    expect(f.pushes.at(-1)?.waiting).toBeNull();
  });

  it("expires an old question batch when a new question turn is admitted", async () => {
    const f = await fixture();
    await f.publishQuestions();
    await f.turns.admitted(f.thread.id, f.classify());
    expect(await f.service.snapshot({ threadId: f.thread.id })).toEqual({ versions: [], comments: [], phase: null, pendingQuestions: null, pendingImplement: null });
    expect(f.pushes.at(-1)?.waiting).toBeNull();
  });
});
