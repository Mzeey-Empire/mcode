import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database } from "bun:sqlite";
import { openAgentStorageTestDatabase as openMemoryDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { PlanQuestionAnswersRepo } from "../persistence/plan-question-answers-repo.js";
import { PlanQuestionService } from "../plan-question-service.js";
import { PLAN_ANSWER_MESSAGE_PREFIX, type Message } from "@mcode/contracts";

/** Seed a workspace + thread so message foreign keys are satisfied. */
function seedThread(db: Database): string {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("ws-1", "Test", "/tmp/test", now, now);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("thread-1", "ws-1", "Test thread", "main", now, now);
  return "thread-1";
}

function insertMessage(
  db: Database,
  id: string,
  role: string,
  content: string,
  sequence: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, "thread-1", role, content, now, sequence);
}

/** A plan-questions fence with one question and two titled options. */
function fence(question = "Which auth strategy?", optionTitle = "OAuth"): string {
  const block = JSON.stringify([
    {
      id: "q1",
      category: "AUTH",
      question,
      options: [
        { id: "o1", title: optionTitle, description: "First option" },
        { id: "o2", title: "Sessions", description: "Use sessions" },
      ],
    },
  ]);
  return `Some preamble\n\n\`\`\`plan-questions\n${block}\n\`\`\``;
}

function acceptedAssistant(content: string): Message {
  return { id: "accepted-assistant", thread_id: "thread-1", role: "assistant", content,
    timestamp: "2026-09-30T10:00:00.000Z", sequence: 2, attachments: null,
    tool_calls: null, files_changed: null, cost_usd: null, tokens_used: null,
  };
}

afterEach(closeAgentStorageTestDatabases);

describe("PlanQuestionService accepted progress read-through", () => {
  let db: Database;
  let answersRepo: PlanQuestionAnswersRepo;
  let svc: PlanQuestionService;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    answersRepo = new PlanQuestionAnswersRepo(db, agentStorageTestWriter(db));
    svc = new PlanQuestionService(new MessageRepo(db, agentStorageTestWriter(db)), answersRepo);
  });

  afterEach(() => db.close(true));

  it("resolves the exact unsaved assistant body and stable fence ID ahead of older saved history", () => {
    insertMessage(db, "saved-assistant", "assistant", fence(), 1);
    const accepted = acceptedAssistant(fence("Which storage?", "SQLite"));
    svc.bindAcceptedProgress({ latestAssistantMessage: () => accepted, markPlanAnswered: () => false });
    const payload = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: "o1", freeText: null },
    ]);
    expect(payload.content).toContain("**Which storage?**: SQLite");
    expect(payload.content).not.toContain("**Which auth strategy?**");
    expect(payload.markPlanAnswerForMessageId).toBe(accepted.id);
    expect(svc.findLatestPlanQuestionsMessageId("thread-1")).toBe(accepted.id);
    expect(new MessageRepo(db, agentStorageTestWriter(db)).findById(accepted.id)).toBeUndefined();
  });

  it("keeps malformed current accepted context attached to its own fence instead of using an older batch", () => {
    insertMessage(db, "saved-assistant", "assistant", fence(), 1);
    const accepted = acceptedAssistant("```plan-questions\nnot json```");
    svc.bindAcceptedProgress({ latestAssistantMessage: () => accepted, markPlanAnswered: () => false });
    const payload = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: "o1", freeText: null },
    ]);
    expect(payload.content).toContain("**q1**: o1");
    expect(payload.markPlanAnswerForMessageId).toBe(accepted.id);
  });

  it("admits one ordered dismissal marker for the unsaved ID without inserting a foreign-key-dependent saved marker", async () => {
    insertMessage(db, "saved-assistant", "assistant", fence(), 1);
    const accepted = acceptedAssistant(fence("Which storage?", "SQLite"));
    const queued: Array<{ threadId: string; messageId: string }> = [];
    const answered = new Set<string>();
    svc.bindAcceptedProgress({ latestAssistantMessage: () => accepted,
      markPlanAnswered: (threadId, messageId) => {
        if (threadId !== accepted.thread_id || messageId !== accepted.id) return false;
        if (!answered.has(messageId)) queued.push({ threadId, messageId });
        answered.add(messageId);
        return true;
      },
    });
    expect(await svc.dismiss("thread-1")).toBe(accepted.id);
    expect(await svc.dismiss("thread-1")).toBe(accepted.id);
    expect(queued).toEqual([{ threadId: "thread-1", messageId: accepted.id }]);
    expect(answersRepo.listAnsweredForThread("thread-1")).toEqual([]);
    expect(new MessageRepo(db, agentStorageTestWriter(db)).findById(accepted.id)).toBeUndefined();
  });

  it("falls back to the saved fence and idempotent repository marker when no accepted match exists", async () => {
    insertMessage(db, "saved-assistant", "assistant", fence(), 1);
    const attempted: Array<{ threadId: string; messageId: string }> = [];
    svc.bindAcceptedProgress({ latestAssistantMessage: () => undefined,
      markPlanAnswered: (threadId, messageId) => { attempted.push({ threadId, messageId }); return false; },
    });
    const payload = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: "o1", freeText: null },
    ]);
    expect(payload.content).toContain("**Which auth strategy?**: OAuth");
    expect(payload.markPlanAnswerForMessageId).toBe("saved-assistant");
    expect(await svc.dismiss("thread-1")).toBe("saved-assistant");
    expect(await svc.dismiss("thread-1")).toBe("saved-assistant");
    expect(attempted).toEqual([
      { threadId: "thread-1", messageId: "saved-assistant" },
      { threadId: "thread-1", messageId: "saved-assistant" },
    ]);
    expect(answersRepo.listAnsweredForThread("thread-1")).toEqual(["saved-assistant"]);
  });

  it("uses saved fenced history when the current accepted assistant has no questions", () => {
    insertMessage(db, "saved-assistant", "assistant", fence(), 1);
    svc.bindAcceptedProgress({ latestAssistantMessage: () => acceptedAssistant("A plain reply"),
      markPlanAnswered: () => false });
    expect(svc.findLatestPlanQuestionsMessageId("thread-1")).toBe("saved-assistant");
    expect(svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: "o1", freeText: null },
    ]).content).toContain("**Which auth strategy?**: OAuth");
  });

  it("propagates rejected marker admission without writing a saved acknowledgement", async () => {
    insertMessage(db, "saved-assistant", "assistant", fence(), 1);
    svc.bindAcceptedProgress({ latestAssistantMessage: () => acceptedAssistant(fence()),
      markPlanAnswered: () => { throw new Error("Control admission rejected"); } });
    await expect(svc.dismiss("thread-1")).rejects.toThrow("Control admission rejected");
    expect(answersRepo.listAnsweredForThread("thread-1")).toEqual([]);
  });

  it("parses legacy context entries and ignores malformed question and option identities", () => {
    const questions = [null, { id: 1, question: "Invalid" }, { id: "q1", question: "Which storage?",
      options: [null, { id: 1 }, { id: "o1", title: 7 }, { id: "o2" }] }];
    svc.bindAcceptedProgress({ latestAssistantMessage: () => acceptedAssistant(`\`\`\`plan-questions\n${JSON.stringify(questions)}\n\`\`\``),
      markPlanAnswered: () => false });
    const payload = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: "o1", freeText: null },
      { questionId: "q1", selectedOptionId: "o2", freeText: null },
    ]);
    expect(payload.content).toContain("**Which storage?**: 7");
    expect(payload.content).toContain("**Which storage?**: o2");
  });
});

describe("PlanQuestionService.buildAnswerPayload", () => {
  let db: Database;
  let svc: PlanQuestionService;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    svc = new PlanQuestionService(new MessageRepo(db, agentStorageTestWriter(db)), new PlanQuestionAnswersRepo(db, agentStorageTestWriter(db)));
  });

  it("renders a selected option as human-readable question and option title", () => {
    insertMessage(db, "m1", "assistant", fence(), 1);

    const { content } = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: "o1", freeText: null },
    ]);

    expect(content).toContain("**Which auth strategy?**: OAuth");
  });

  it("renders a free-text answer verbatim under the question label", () => {
    insertMessage(db, "m1", "assistant", fence(), 1);

    const { content } = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: null, freeText: "Use a magic link" },
    ]);

    expect(content).toContain("**Which auth strategy?**: Use a magic link");
  });

  it("renders (skipped) when neither an option nor free text is given", () => {
    insertMessage(db, "m1", "assistant", fence(), 1);

    const { content } = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: null, freeText: null },
    ]);

    expect(content).toContain("**Which auth strategy?**: (skipped)");
  });

  it("falls back to opaque ids when no fence or malformed JSON is present", () => {
    // Assistant message with a malformed plan-questions fence (not valid JSON).
    insertMessage(db, "m1", "assistant", "```plan-questions\nnot json```", 1);

    const { content } = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: "o1", freeText: null },
    ]);

    // No context resolved, so the raw ids surface instead of human text.
    expect(content).toContain("**q1**: o1");
  });

  it("appends mcode-plan instructions and keys the marker on the fenced message", () => {
    insertMessage(db, "m1", "assistant", fence(), 1);

    const { content, markPlanAnswerForMessageId } = svc.buildAnswerPayload("thread-1", [
      { questionId: "q1", selectedOptionId: "o1", freeText: null },
    ]);

    expect(content).toContain(PLAN_ANSWER_MESSAGE_PREFIX);
    expect(content).toContain("```mcode-plan");
    expect(markPlanAnswerForMessageId).toBe("m1");
  });
});

describe("PlanQuestionService.findLatestPlanQuestionsMessageId", () => {
  let db: Database;
  let svc: PlanQuestionService;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    svc = new PlanQuestionService(new MessageRepo(db, agentStorageTestWriter(db)), new PlanQuestionAnswersRepo(db, agentStorageTestWriter(db)));
  });

  it("returns the id of the most recent fenced assistant message", () => {
    insertMessage(db, "m1", "assistant", fence(), 1);
    insertMessage(db, "m2", "user", "thanks", 2);
    insertMessage(db, "m3", "assistant", fence(), 3);

    expect(svc.findLatestPlanQuestionsMessageId("thread-1")).toBe("m3");
  });

  it("returns null when the thread has no fenced message", () => {
    insertMessage(db, "m1", "assistant", "plain reply", 1);

    expect(svc.findLatestPlanQuestionsMessageId("thread-1")).toBeNull();
  });

  it("ignores a fence that appears in a user message", () => {
    insertMessage(db, "m1", "user", fence(), 1);

    expect(svc.findLatestPlanQuestionsMessageId("thread-1")).toBeNull();
  });
});

describe("PlanQuestionService.dismiss", () => {
  let db: Database;
  let answersRepo: PlanQuestionAnswersRepo;
  let svc: PlanQuestionService;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedThread(db);
    answersRepo = new PlanQuestionAnswersRepo(db, agentStorageTestWriter(db));
    svc = new PlanQuestionService(new MessageRepo(db, agentStorageTestWriter(db)), answersRepo);
  });

  it("marks the latest fenced message answered and returns its id", async () => {
    insertMessage(db, "m1", "assistant", fence(), 1);

    const result = await svc.dismiss("thread-1");

    expect(result).toBe("m1");
    expect(answersRepo.isAnswered("m1")).toBe(true);
  });

  it("returns null and writes nothing when there is no fenced message", async () => {
    insertMessage(db, "m1", "assistant", "plain reply", 1);

    const result = await svc.dismiss("thread-1");

    expect(result).toBeNull();
    expect(answersRepo.listAnsweredForThread("thread-1")).toEqual([]);
  });
});
