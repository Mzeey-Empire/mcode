import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { ThreadStore } from "../../../../thread-control/persistence/thread-store.js";
import { WorkspaceStore } from "../../../../projects/persistence/workspace-store.js";
import { MessageStore } from "../../../conversation/persistence/message-store.js";
import { PlanQuestionAnswersStore } from "../plan-question-answers-store.js";

/**
 * Sidecar repo for the plan-question wizard's answered marker. The marker
 * lives keyed on the assistant message that contained the plan-questions
 * fence; cascading FKs to messages and threads keep the table self-pruning.
 */
describe("PlanQuestionAnswersStore", () => {
  let db: Database;
  let repo: PlanQuestionAnswersStore;
  let messageRepo: MessageStore;
  let threadId: string;
  let assistantMsgId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new PlanQuestionAnswersStore(db);
    messageRepo = new MessageStore(db);

    const workspaceRepo = new WorkspaceStore(db);
    const threadRepo = new ThreadStore(db);
    const ws = workspaceRepo.create("test-ws", "/tmp/ws", false);
    const t = threadRepo.create(ws.id, "thread", "direct", "main");
    threadId = t.id;

    const msg = messageRepo.create(threadId, "assistant", "```plan-questions\n[]\n```", 1);
    assistantMsgId = msg.id;
  });

  it("isAnswered returns false when no marker exists", () => {
    expect(repo.isAnswered(assistantMsgId)).toBe(false);
  });

  it("markAnswered persists the marker; isAnswered then returns true", () => {
    repo.markAnswered(assistantMsgId, threadId);
    expect(repo.isAnswered(assistantMsgId)).toBe(true);
  });

  it("listAnsweredForThread returns marker IDs scoped to the thread", () => {
    const workspaceRepo = new WorkspaceStore(db);
    const threadRepo = new ThreadStore(db);
    const ws2 = workspaceRepo.create("other-ws", "/tmp/other-ws", false);
    const otherThread = threadRepo.create(ws2.id, "other", "direct", "main");
    const otherMsg = messageRepo.create(
      otherThread.id,
      "assistant",
      "```plan-questions\n[]\n```",
      1,
    );

    repo.markAnswered(assistantMsgId, threadId);
    repo.markAnswered(otherMsg.id, otherThread.id);

    expect(repo.listAnsweredForThread(threadId)).toEqual([assistantMsgId]);
    expect(repo.listAnsweredForThread(otherThread.id)).toEqual([otherMsg.id]);
  });

  it("re-marking the same message id is idempotent", () => {
    repo.markAnswered(assistantMsgId, threadId);
    expect(() => repo.markAnswered(assistantMsgId, threadId)).not.toThrow();
    expect(repo.listAnsweredForThread(threadId)).toEqual([assistantMsgId]);
  });

  it("FK cascade: deleting the parent message removes the marker", () => {
    repo.markAnswered(assistantMsgId, threadId);
    expect(repo.isAnswered(assistantMsgId)).toBe(true);

    db.prepare("DELETE FROM messages WHERE id = ?").run(assistantMsgId);
    expect(repo.isAnswered(assistantMsgId)).toBe(false);
  });
});
