import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { PlanStore } from "../../planning/persistence/plan-store.js";
import { PlanImplementStore } from "../../planning/persistence/plan-implement-store.js";
import { PlanCommentAdmissionError, PlanCommentStore } from "../../planning/persistence/plan-comment-store.js";
import { canonicalRuntimeWriteOperations } from "../canonical-runtime-write-operations.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { openMigratedTestDatabase } from "../../../../runtime/persistence/sqlite/testing/migrated-test-database.js";
import { leaseWriterWorker } from "../../../../runtime/persistence/sqlite/testing/reusable-writer-worker.js";
import type { Database } from "bun:sqlite";
import type { ParentNarrativeRecoveryItem } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { MessageStore as MessageRepo } from "../../conversation/persistence/message-store.js";
import { PlanQuestionAnswersStore as PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-store.js";
import { ToolCallRecordStore as ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-store.js";
import { deriveTurnAssistantMessageId } from "../../turns/turn-assistant-message-id.js";
import { CanonicalAgentStore } from "../canonical-agent-store.js";
import type { PreparedExecutionFileEvidence } from "../../turns/turn-execution-file-evidence.js";
import {
  CanonicalParentTurnWrite,
  type DataOnlyParentTerminalProjectionInput,
  type DataOnlyParentTurnFinishInput,
  type DataOnlyParentTurnStartInput,
} from "../canonical-parent-turn-write.js";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-09-24T10:00:00.000Z";

function seedThread(db: Database): void {
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("workspace-1", "Workspace", "C:/fixture", NOW, NOW);
  db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(THREAD_ID, "workspace-1", "Thread", "main", "codex", NOW, NOW);
}

function startInput(): DataOnlyParentTurnStartInput {
  return {
    thread: { id: THREAD_ID, workspaceId: "workspace-1", providerId: "codex", createdAt: NOW },
    turnId: TURN_ID,
    executionId: EXECUTION_ID,
    permissionMode: "supervised",
    providerIdentities: [],
    userMessage: { kind: "create", messageId: "user-1", content: "Question", sequence: 1 },
  };
}

function finishInput(message: ReturnType<MessageRepo["create"]>): DataOnlyParentTurnFinishInput {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    executionId: EXECUTION_ID,
    providerId: "codex",
    providerIdentities: [],
    outcome: "completed",
    projection: { message, narrative: [] },
  };
}

function terminalProjectionInput(): DataOnlyParentTerminalProjectionInput {
  const narrative: ParentNarrativeRecoveryItem[] = [
    {
      kind: "toolCall",
      record: {
        id: "tool-1", message_id: "", parent_tool_call_id: null, tool_name: "Read",
        display_name: null, provider_agent_key: null, subagent_identity_key: null,
        subagent_provider_name: null, subagent_prompt: null, subagent_type: null,
        subagent_agent_id: null, subagent_duration_ms: null, model: null, reasoning_effort: null,
        input_summary: "file.txt", output_summary: "", output_total_bytes: null,
        output_artifact_path: null, exit_code: null, status: "running",
        started_at: NOW, completed_at: null, sort_order: 1,
      },
    },
    {
      kind: "narrationSegment",
      record: { id: "thought-1", message_id: "", text: "Answer", started_at: NOW, ended_at: NOW, sort_order: 2 },
    },
    {
      kind: "hook",
      record: {
        id: "hook-1", message_id: "", hook_name: "Stop", tool_name: null, phase: "stop",
        payload: "{}", duration_ms: null, did_block: false, started_at: NOW,
        ended_at: null, sort_order: 3,
      },
    },
  ];
  return {
    threadId: THREAD_ID,
    executionId: EXECUTION_ID,
    outcome: "completed",
    endedAt: "2026-09-24T10:00:01.000Z",
    assistant: {
      content: "Answer",
      model: "claude-sonnet-4-6",
      attachments: [{ id: "attachment-1", name: "result.txt", mimeType: "text/plain", sizeBytes: 6 }],
    },
    narrative,
  };
}

describe("CanonicalParentTurnWrite", () => {
  let directory: string;
  let path: string;
  let db: Database;
  let published: string[][];
  let writer: CanonicalParentTurnWrite;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-parent-write-"));
    path = NodePath.join(directory, "mcode.db");
    db = openMigratedTestDatabase(path);
    seedThread(db);
    published = [];
    writer = new CanonicalParentTurnWrite(db, (events) => {
      published.push(events.map((event) => event.eventId));
    });
  });

  afterEach(() => {
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  function seedComment(versionId?: string) {
    const plans = new PlanStore(db);
    const existing = versionId ? plans.getById(versionId) : plans.listByThread(THREAD_ID).at(-1);
    const version = existing ?? plans.create(THREAD_ID, new MessageRepo(db).create(THREAD_ID, "assistant", "Plan", 0).id,
      { title: "Plan", contentMd: "# Plan", captureSource: "fence" }, "codex");
    const result = new PlanCommentStore(db).create({ commentId: NodeCrypto.randomUUID(), versionId: version.id,
      body: "Clarify", anchor: { kind: "text", start: 2, end: 6, quote: "Plan", prefix: "# ", suffix: "", section: "Plan" } });
    if (!result.ok) throw new Error(result.code);
    return result.comment;
  }

  it.each(["direct", "worker"])("stamps comments with the projected user message through %s start", async mode => {
    const comment = seedComment();
    const input = { ...startInput(), planCommentIds: [comment.id] };
    const owner = mode === "worker" ? new ApplicationDatabaseWriter(path, leaseWriterWorker) : null;
    try {
      if (owner) await owner.execute(canonicalRuntimeWriteOperations.parentStart, input);
      else writer.start(input);
      expect(new PlanCommentStore(db).getById(comment.id)).toMatchObject({ sentMessageId: "user-1" });
      expect(db.prepare("SELECT role, content FROM messages WHERE id = 'user-1'").get()).toEqual({ role: "user", content: "Question" });
      expect(db.prepare("SELECT id FROM canonical_agent_turns WHERE id = ?").get(TURN_ID)).toEqual({ id: TURN_ID });
    } finally { await owner?.close(); }
  });

  it.each(["direct", "worker"])("stamps an uncarried superseded comment through %s start", async mode => {
    const original = seedComment();
    const plans = new PlanStore(db);
    const assistant = new MessageRepo(db).create(THREAD_ID, "assistant", "New plan", 1);
    plans.create(THREAD_ID, assistant.id, { title: "New plan", contentMd: "# New plan", captureSource: "fence" }, "codex");
    const comment = seedComment(original.versionId);
    expect(plans.getById(comment.versionId)?.status).toBe("superseded");
    const owner = mode === "worker" ? new ApplicationDatabaseWriter(path, leaseWriterWorker) : null;
    try {
      const input = { ...startInput(), planCommentIds: [comment.id] };
      if (owner) await owner.execute(canonicalRuntimeWriteOperations.parentStart, input);
      else writer.start(input);
      expect(new PlanCommentStore(db).getById(comment.id)?.sentMessageId).toBe("user-1");
      expect(db.prepare("SELECT id FROM canonical_agent_turns WHERE id = ?").get(TURN_ID)).toEqual({ id: TURN_ID });
    } finally { await owner?.close(); }
  });

  function seedInvalidComment(fault: string) {
    const invalid = seedComment();
    const store = new PlanCommentStore(db);
    const plans = new PlanStore(db);
    plans.saveVersion({ threadId: THREAD_ID, versionId: NodeCrypto.randomUUID(), baseVersionId: invalid.versionId,
      baseRevision: 0, contentMd: "# Plan" });
    const valid = seedComment();
    if (fault !== "carried-original") {
      db.prepare("DELETE FROM plan_comments WHERE carried_from_comment_id = ?").run(invalid.id);
    } else {
      expect(store.listByThread(THREAD_ID).filter(comment => comment.carriedFromCommentId === invalid.id))
        .toMatchObject([{ versionId: valid.versionId, sentMessageId: null }]);
    }
    if (fault === "resolved") store.setStatus({ commentId: invalid.id, status: "resolved" });
    if (fault === "sent") db.prepare("UPDATE plan_comments SET sent_message_id = 'earlier-message' WHERE id = ?").run(invalid.id);
    if (fault === "accepted") db.prepare("UPDATE plans SET status = 'accepted' WHERE id = ?").run(invalid.versionId);
    if (fault === "wrong-thread" || fault === "wrong-version-thread") {
      db.prepare("INSERT INTO threads (id, workspace_id, title, branch) VALUES ('other', 'workspace-1', 'Other', 'main')").run();
      if (fault === "wrong-thread") db.prepare("UPDATE plan_comments SET thread_id = 'other' WHERE id = ?").run(invalid.id);
      else db.prepare("UPDATE plans SET thread_id = 'other' WHERE id = ?").run(invalid.versionId);
    }
    if (fault === "missing") store.delete({ commentId: invalid.id });
    return { valid, invalid, store };
  }

  it.each(["resolved", "sent", "carried-original", "accepted", "wrong-thread", "wrong-version-thread", "missing"])("rolls back every stamp and admission for a %s comment", async fault => {
    const { valid, invalid, store } = seedInvalidComment(fault);
    const before = store.listByThread(THREAD_ID);
    for (const mode of ["direct", "worker"]) {
      const owner = mode === "worker" ? new ApplicationDatabaseWriter(path, leaseWriterWorker) : null;
      try {
        const input = { ...startInput(), planCommentIds: [valid.id, invalid.id] };
        const start = async () => owner ? owner.execute(canonicalRuntimeWriteOperations.parentStart, input) : writer.start(input);
        await expect(start()).rejects.toMatchObject({ code: "plan_comment_invalid" });
        if (!owner) expect(() => writer.start(input)).toThrow(PlanCommentAdmissionError);
        expect(store.listByThread(THREAD_ID)).toEqual(before);
        expect(db.prepare("SELECT id FROM messages WHERE id = 'user-1'").all()).toEqual([]);
        expect(db.prepare("SELECT id FROM canonical_agent_turns WHERE id = ?").all(TURN_ID)).toEqual([]);
      } finally { await owner?.close(); }
    }
  });

  it.each(["direct", "worker"])("rolls back a stamp when a later admission effect fails through %s", async mode => {
    const comment = seedComment();
    const input = { ...startInput(), planCommentIds: [comment.id], planImplement: { requestId: NodeCrypto.randomUUID() } };
    const owner = mode === "worker" ? new ApplicationDatabaseWriter(path, leaseWriterWorker) : null;
    try {
      const start = async () => owner ? owner.execute(canonicalRuntimeWriteOperations.parentStart, input) : writer.start(input);
      await expect(start()).rejects.toThrow();
      expect(new PlanCommentStore(db).getById(comment.id)?.sentMessageId).toBeNull();
      expect(db.prepare("SELECT id FROM messages WHERE id = 'user-1'").all()).toEqual([]);
      expect(db.prepare("SELECT id FROM canonical_agent_turns WHERE id = ?").all(TURN_ID)).toEqual([]);
    } finally { await owner?.close(); }
  });

  it("stages the assistant after provider system notices that follow its user prompt", () => {
    writer.start(startInput());
    const messages = new MessageRepo(db);
    messages.createSystemNotice(THREAD_ID, "Provider notice", 2, undefined);
    const messageId = deriveTurnAssistantMessageId(THREAD_ID, "user-1");

    expect(writer.stageLiveAssistant({ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID }, {
      precedingMessageId: "user-1", messageId, content: "Answer", model: null, attachments: [],
    })).toBe(true);
    expect(messages.findByIdInThreadIncludingInternal(THREAD_ID, messageId))
      .toMatchObject({ sequence: 3, is_internal: true, content: "Answer" });
  });

  it.each(["wrong-message", "stale-revision"])("rolls the entire Implement start back for %s", (fault) => {
    const plans = new PlanStore(db);
    const requests = new PlanImplementStore(db);
    const assistant = new MessageRepo(db).create(THREAD_ID, "assistant", "Plan", 1);
    const version = plans.create(THREAD_ID, assistant.id, { title: "Plan", contentMd: "# Plan", captureSource: "fence" }, "codex");
    const requestId = NodeCrypto.randomUUID();
    const prepared = requests.prepare({ input: { requestId, threadId: THREAD_ID, versionId: version.id,
      expectedRevision: 0, target: "thread" }, fingerprint: "test", planFilePath: "C:/fixture/plan.md" });
    if (!prepared.ok) throw new Error("Preparation failed");
    if (fault === "stale-revision") db.prepare("UPDATE plans SET revision = 1 WHERE id = ?").run(version.id);
    const start = { ...startInput(), planImplement: { requestId }, userMessage: { kind: "create" as const,
      messageId: fault === "wrong-message" ? "wrong-message" : prepared.request.messageId,
      content: "Implement plan v1", sequence: 2 } };
    expect(() => writer.start(start)).toThrow();
    expect(db.prepare("SELECT id FROM messages WHERE thread_id = ? AND role = 'user'").all(THREAD_ID)).toEqual([]);
    expect(db.prepare("SELECT id FROM canonical_agent_turns WHERE thread_id = ?").all(THREAD_ID)).toEqual([]);
    expect(plans.getById(version.id)?.status).toBe("ready");
    expect(requests.read(requestId)?.status).toBe("preparing");
  });

  it("stages only parent-owned tools while retaining its canonical delegation anchor", async () => {
    writer.start(startInput());
    const canonical = new CanonicalAgentStore(db, () => {});
    canonical.startCodexChildDelegation({ parentThreadId: THREAD_ID, parentTurnId: TURN_ID,
      parentExecutionId: EXECUTION_ID, parentItemId: "toolCall:spawn", providerIdentities: [] });
    const input = terminalProjectionInput();
    const base = input.narrative.find((item) => item.kind === "toolCall");
    if (!base || base.kind !== "toolCall") throw new Error("Fixture tool is missing");
    const parent = { ...base, record: { ...base.record, id: "spawn", tool_name: "Agent",
      input_summary: JSON.stringify({ codexCollabKind: "spawnAgent" }) } };
    const child = { ...base, record: { ...base.record, id: "child-tool", parent_tool_call_id: "spawn",
      input_summary: "private child input", output_summary: "private child output" } };
    const nested = { ...child, record: { ...child.record, id: "nested-tool", parent_tool_call_id: "child-tool" } };
    const staged = writer.stageTerminalProjection({ ...input, narrative: [parent, child, nested, base] });
    expect(new ToolCallRecordRepo(db).listByMessage(staged.messageId!).map((record) => record.id))
      .toEqual(["spawn", "tool-1"]);
    expect(staged.projection.narrative.flatMap((entry) => entry.kind === "toolCall" ? [entry.record.id] : []))
      .toEqual(["spawn", "tool-1"]);
    await writer.finish({ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
      providerId: "codex", providerIdentities: [], outcome: "completed", projection: staged.projection });
    expect(canonical.loadItem("toolCall:spawn")?.payload.projection).toBe("codexSubagent");
    expect(canonical.loadItem("toolCall:child-tool")).toBeNull();
    expect(canonical.loadItem("toolCall:nested-tool")).toBeNull();
  });

  it("does not stage the assistant after a later user prompt", () => {
    writer.start(startInput());
    const messages = new MessageRepo(db);
    messages.createSystemNotice(THREAD_ID, "Provider notice", 2, undefined);
    messages.create(THREAD_ID, "user", "Later prompt", 3);
    const messageId = deriveTurnAssistantMessageId(THREAD_ID, "user-1");

    expect(writer.stageLiveAssistant({ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID }, {
      precedingMessageId: "user-1", messageId, content: "Answer", model: null, attachments: [],
    })).toBe(false);
    expect(messages.findByIdInThreadIncludingInternal(THREAD_ID, messageId)).toBeNull();
  });

  it("commits cloneable start, event checkpoint and terminal projection across a reload", async () => {
    const start = startInput();
    expect(() => structuredClone(start)).not.toThrow();
    expect(writer.start(start).outcome).toBe("committed");
    expect(writer.start(start).outcome).toBe("duplicate");

    const event = {
      eventId: `${EXECUTION_ID}:item-1`,
      routing: { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, itemId: "item-1" },
      sourceProviderId: "codex",
      sourceIdentities: [],
      payload: {
        type: "item.recorded" as const,
        item: {
          id: "item-1",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          kind: "message" as const,
          providerIdentities: [],
          payload: { projection: "message", content: "Event" },
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    };
    expect(writer.append({ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: [event] }).outcome)
      .toBe("committed");
    expect(writer.append({ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, phase: "running", events: [event] }).outcome)
      .toBe("duplicate");

    const staged = new MessageRepo(db).create(THREAD_ID, "assistant", "Answer", 2, undefined, undefined, undefined, "model", true);
    const finish = finishInput(staged);
    expect(() => structuredClone(finish)).not.toThrow();
    expect((await writer.finish(finish)).outcome).toBe("committed");
    expect((await writer.finish(finish)).outcome).toBe("terminal-outcome-confirmed");
    expect(published.flat()).toContain(`${EXECUTION_ID}:turn.completed`);

    db.close(true);
    db = openDatabase({ dbPath: path });
    const checkpoint = db.prepare("SELECT phase, terminal_outcome, last_accepted_sequence, last_durable_sequence FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?")
      .get(EXECUTION_ID) as { phase: string; terminal_outcome: string; last_accepted_sequence: number; last_durable_sequence: number };
    expect(checkpoint).toMatchObject({ phase: "completed", terminal_outcome: "completed" });
    expect(checkpoint.last_accepted_sequence).toBe(checkpoint.last_durable_sequence);
    expect(checkpoint.last_accepted_sequence).toBeGreaterThan(4);
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, staged.id)).toMatchObject({ is_internal: false, outcome: "completed" });
  });

  it("rolls back a failed user-message projection with canonical start", () => {
    db.prepare("UPDATE threads SET user_completed_at = ? WHERE id = ?").run(NOW, THREAD_ID);
    db.run("CREATE TRIGGER fail_user_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'message unavailable'); END");
    expect(() => writer.start({ ...startInput(), reopenThread: true })).toThrow("message unavailable");
    expect(db.prepare("SELECT user_completed_at FROM threads WHERE id = ?").get(THREAD_ID)).toEqual({ user_completed_at: NOW });
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_agent_ingest_checkpoints").get()).toEqual({ count: 0 });
    expect(published).toEqual([]);
  });

  it("reuses a queued user message while reopening the thread and answering a plan question", () => {
    const messages = new MessageRepo(db);
    const queued = messages.create(THREAD_ID, "user", "Queued answer", 1);
    const plan = messages.create(THREAD_ID, "assistant", "Question", 2);
    db.prepare("UPDATE threads SET user_completed_at = ? WHERE id = ?").run(NOW, THREAD_ID);
    const input: DataOnlyParentTurnStartInput = {
      ...startInput(),
      userMessage: { kind: "existing", messageId: queued.id },
      reopenThread: true,
      answeredPlanQuestionMessageId: plan.id,
    };

    expect(writer.start(structuredClone(input)).outcome).toBe("committed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'user'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT user_completed_at FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ user_completed_at: null });
    expect(new PlanQuestionAnswersRepo(db).isAnswered(plan.id)).toBe(true);
  });

  it("does not confirm a terminal checkpoint when assistant publication fails", async () => {
    writer.start(startInput());
    const staged = new MessageRepo(db).create(THREAD_ID, "assistant", "Answer", 2, undefined, undefined, undefined, "model", true);
    db.run("CREATE TRIGGER fail_assistant_outcome BEFORE UPDATE OF outcome ON messages BEGIN SELECT RAISE(ABORT, 'outcome unavailable'); END");
    const finish = finishInput(staged);
    await expect(writer.finish(finish)).rejects.toThrow("outcome unavailable");
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: null });
    expect(new MessageRepo(db).listIncludingInternal(THREAD_ID).find((message) => message.id === staged.id))
      .toMatchObject({ is_internal: true, outcome: null });
    expect(published.flat()).not.toContain(`${EXECUTION_ID}:turn.completed`);

    db.run("DROP TRIGGER fail_assistant_outcome");
    expect((await writer.finish(finish)).outcome).toBe("committed");
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, staged.id)).toMatchObject({ is_internal: false, outcome: "completed" });
  });

  it("persists owned commentary equal to the answer across terminal finish and database reload", async () => {
    writer.start(startInput());
    const input = terminalProjectionInput();
    const commentaryId = `assistant-text:${"a".repeat(64)}`;
    const explicitFinalId = `assistant-text:${"b".repeat(64)}`;
    input.narrative = [
      { kind: "narrationSegment", record: { id: commentaryId, message_id: "", text: "Answer",
        started_at: NOW, ended_at: NOW, sort_order: 1, is_final_response: 0 } },
      { kind: "narrationSegment", record: { id: explicitFinalId, message_id: "", text: "Answer",
        started_at: NOW, ended_at: NOW, sort_order: 2, is_final_response: 1 } },
    ];
    const staged = writer.stageTerminalProjection(input);
    const message = staged.projection.message;
    if (!message) throw new Error("Missing staged response");
    expect((await writer.finish({ ...finishInput(message), projection: staged.projection })).outcome).toBe("committed");
    db.close(true);
    db = openDatabase({ dbPath: path });
    expect(db.prepare("SELECT text, is_final_response FROM thought_segments WHERE id = ?").get(commentaryId))
      .toEqual({ text: "Answer", is_final_response: 0 });
    expect(db.prepare("SELECT text, is_final_response FROM thought_segments WHERE id = ?").get(explicitFinalId))
      .toEqual({ text: "Answer", is_final_response: 1 });
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, message.id)?.content).toBe("Answer");
  });

  it("persists reasoning equal to the answer as non-final reasoning", async () => {
    writer.start(startInput());
    const input = terminalProjectionInput();
    input.narrative = [
      { kind: "narrationSegment", record: { id: "reasoning-1", message_id: "", text: "Answer",
        started_at: NOW, ended_at: NOW, sort_order: 1, kind: "reasoning" } },
    ];
    const staged = writer.stageTerminalProjection(input);
    const message = staged.projection.message;
    if (!message) throw new Error("Missing staged response");
    expect((await writer.finish({ ...finishInput(message), projection: staged.projection })).outcome).toBe("committed");
    expect(db.prepare("SELECT text, kind, is_final_response FROM thought_segments WHERE id = 'reasoning-1'").get())
      .toEqual({ text: "Answer", kind: "reasoning", is_final_response: 0 });
  });

  it("stages cloneable terminal rows once and publishes only after finish", async () => {
    writer.start(startInput());
    const input = terminalProjectionInput();
    expect(() => structuredClone(input)).not.toThrow();
    new ToolCallRecordRepo(db).create({
      toolCallId: "tool-1", messageId: "user-1", toolName: "Read", inputSummary: "earlier",
      outputSummary: "", status: "running", startedAt: NOW, sortOrder: 1,
    });

    const first = writer.stageTerminalProjection(input);
    expect(first.messageId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.toolCallCount).toBe(1);
    expect(db.prepare("SELECT is_internal, outcome FROM messages WHERE id = ?").get(first.messageId!))
      .toEqual({ is_internal: 1, outcome: null });
    expect(db.prepare("SELECT message_id, status, completed_at FROM tool_call_records WHERE id = 'tool-1'").get())
      .toEqual({ message_id: first.messageId, status: "completed", completed_at: input.endedAt });
    expect(db.prepare("SELECT message_id, is_final_response FROM thought_segments WHERE id = 'thought-1'").get())
      .toEqual({ message_id: first.messageId, is_final_response: 1 });
    expect(db.prepare("SELECT message_id, ended_at FROM hook_executions WHERE id = 'hook-1'").get())
      .toEqual({ message_id: first.messageId, ended_at: input.endedAt });
    expect(published.flat()).not.toContain(`${EXECUTION_ID}:turn.completed`);

    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalParentTurnWrite(db, (events) => {
      published.push(events.map((event) => event.eventId));
    });
    const repeated = writer.stageTerminalProjection(input);
    expect(repeated.messageId).toBe(first.messageId);
    expect(repeated.toolCallCount).toBe(1);
    expect(() => structuredClone(repeated.projection)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM tool_call_records WHERE message_id = ?").get(first.messageId!))
      .toEqual({ count: 1 });
    const finish = { ...finishInput(first.projection.message!), projection: first.projection };
    expect((await writer.finish(finish)).outcome).toBe("committed");
    expect(published.flat()).toContain(`${EXECUTION_ID}:turn.completed`);
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, first.messageId!))
      .toMatchObject({ is_internal: false, outcome: "completed", attachments: input.assistant.attachments });
    expect(writer.stageTerminalProjection(input).messageId).toBe(first.messageId);
  });

  it("keeps an assigned public assistant identity through writer staging and reload", async () => {
    writer.start(startInput());
    const messageId = deriveTurnAssistantMessageId(THREAD_ID, "user-1");
    const input = terminalProjectionInput();
    input.assistant.messageId = messageId;
    const staged = writer.stageTerminalProjection(input);
    expect(staged.messageId).toBe(messageId);

    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalParentTurnWrite(db, (events) => {
      published.push(events.map((event) => event.eventId));
    });
    expect(writer.stageTerminalProjection(input).messageId).toBe(messageId);
    const finish = { ...finishInput(staged.projection.message!), projection: { kind: "writer-staged" as const, messageId } };
    expect(() => writer.finish({ ...finish, projection: { kind: "writer-staged", messageId: "0".repeat(64) } }))
      .toThrow("Staged assistant projection not found");
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: null });
    expect((await writer.finish(finish)).outcome).toBe("committed");
    expect(new MessageRepo(db).findByIdInThread(THREAD_ID, messageId)).toMatchObject({
      is_internal: false, outcome: "completed", content: input.assistant.content,
    });
  });

  it("commits selected diff evidence with the assigned terminal assistant", async () => {
    writer.start(startInput());
    const messageId = deriveTurnAssistantMessageId(THREAD_ID, "user-1");
    const input = terminalProjectionInput();
    input.assistant.messageId = messageId;
    writer.stageTerminalProjection(input);
    const patch = "diff --git a/a.txt b/a.txt\nindex 1..2\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const finish: DataOnlyParentTurnFinishInput = {
      ...finishInput(new MessageRepo(db).findByIdInThreadIncludingInternal(THREAD_ID, messageId)!),
      projection: { kind: "writer-staged", messageId },
      selectedTurnDiff: { thread_id: THREAD_ID, source: "native", patch, revision: 2 },
    };
    await expect(writer.finish({ ...finish, selectedTurnDiff: { ...finish.selectedTurnDiff!, thread_id: "other" } }))
      .rejects.toThrow("Invalid selected turn diff");
    db.run("CREATE TRIGGER fail_turn_diff BEFORE INSERT ON turn_diff_snapshots BEGIN SELECT RAISE(ABORT, 'diff unavailable'); END");
    await expect(writer.finish(finish)).rejects.toThrow("diff unavailable");
    expect(db.prepare("SELECT is_internal FROM messages WHERE id = ?").get(messageId)).toEqual({ is_internal: 1 });
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: null });
    db.run("DROP TRIGGER fail_turn_diff");
    expect((await writer.finish(finish)).outcome).toBe("committed");
    expect(db.prepare("SELECT message_id, source, patch, revision FROM turn_diff_snapshots WHERE message_id = ?")
      .get(messageId)).toEqual({ message_id: messageId, source: "native", patch, revision: 2 });
    expect(db.prepare("SELECT count(*) AS count FROM turn_diff_snapshots").get()).toEqual({ count: 1 });
  });

  it("commits exact-execution file evidence with the terminal assistant or rolls it all back", async () => {
    writer.start(startInput());
    const messageId = deriveTurnAssistantMessageId(THREAD_ID, "user-1");
    const input = terminalProjectionInput();
    input.assistant.messageId = messageId;
    const staged = writer.stageTerminalProjection(input);
    const patch = "diff --git a/a.txt b/a.txt\nindex 1..2\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const fileEffects = {
      revision: 1, fileCount: 1, additions: 1, deletions: 1,
      effects: [{ path: "a.txt", kind: "edited" as const, scope: "workspace" as const,
        additions: 1, deletions: 1, binary: false, toolCallIds: ["tool-1"] }],
    };
    const fileEvidence: PreparedExecutionFileEvidence = {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, deliveryAttempt: 2,
      fileEffects, filesChanged: ["a.txt"],
      snapshot: {
        threadId: THREAD_ID, executionId: EXECUTION_ID, refBefore: "a".repeat(40),
        refAfter: "b".repeat(40), filesChanged: ["a.txt"], fileEffects, worktreePath: null,
      },
      selectedTurnDiff: { thread_id: THREAD_ID, source: "native", patch, revision: 2 },
    };
    const finish: DataOnlyParentTurnFinishInput = {
      ...finishInput(new MessageRepo(db).findByIdInThreadIncludingInternal(THREAD_ID, messageId)!),
      projection: { kind: "writer-staged", messageId }, deliveryAttempt: 2, fileEvidence,
    };
    await expect(writer.finish({ ...finish, fileEvidence: { ...fileEvidence, executionId: "old-execution" } }))
      .rejects.toThrow("Invalid execution file evidence");
    await expect(writer.finish({ ...finish, deliveryAttempt: 1 })).rejects.toThrow("Invalid execution file evidence");
    db.run("CREATE TRIGGER fail_snapshot BEFORE INSERT ON turn_snapshots BEGIN SELECT RAISE(ABORT, 'snapshot unavailable'); END");
    await expect(writer.finish(structuredClone(finish))).rejects.toThrow("snapshot unavailable");
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: null });
    expect(db.prepare("SELECT is_internal FROM messages WHERE id = ?").get(messageId)).toEqual({ is_internal: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM turn_diff_snapshots").get()).toEqual({ count: 0 });
    db.run("DROP TRIGGER fail_snapshot");
    expect((await writer.finish(finish)).outcome).toBe("committed");
    expect(db.prepare("SELECT message_id, thread_id, files_changed, ref_before, ref_after FROM turn_snapshots WHERE message_id = ?")
      .get(messageId)).toEqual({
        message_id: messageId, thread_id: THREAD_ID, files_changed: '["a.txt"]',
        ref_before: "a".repeat(40), ref_after: "b".repeat(40),
      });
    expect(db.prepare("SELECT source, patch FROM turn_diff_snapshots WHERE message_id = ?").get(messageId))
      .toEqual({ source: "native", patch });
    expect(db.prepare("SELECT has_file_changes FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ has_file_changes: 1 });
    expect((await writer.finish({ ...finish, projection: staged.projection })).outcome).toBe("terminal-outcome-confirmed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM turn_snapshots").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM turn_diff_snapshots").get()).toEqual({ count: 1 });
  });

  it("commits Git-compared files when no file effect was tracked, but only between real refs", async () => {
    writer.start(startInput());
    const messageId = deriveTurnAssistantMessageId(THREAD_ID, "user-1");
    const input = terminalProjectionInput();
    input.assistant.messageId = messageId;
    writer.stageTerminalProjection(input);
    const fileEffects = { revision: 0, fileCount: 0, additions: 0, deletions: 0, effects: [] };
    const snapshot = {
      threadId: THREAD_ID, executionId: EXECUTION_ID, refBefore: "a".repeat(40),
      refAfter: "b".repeat(40), filesChanged: ["shell.txt"], fileEffects, worktreePath: null,
    };
    const fileEvidence: PreparedExecutionFileEvidence = {
      threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID, deliveryAttempt: 2,
      fileEffects, filesChanged: ["shell.txt"], snapshot, selectedTurnDiff: null,
    };
    const finish: DataOnlyParentTurnFinishInput = {
      ...finishInput(new MessageRepo(db).findByIdInThreadIncludingInternal(THREAD_ID, messageId)!),
      projection: { kind: "writer-staged", messageId }, deliveryAttempt: 2, fileEvidence,
    };
    await expect(writer.finish({ ...finish, fileEvidence: { ...fileEvidence, snapshot: { ...snapshot, refBefore: "" } } }))
      .rejects.toThrow("Invalid execution file evidence");
    expect((await writer.finish(finish)).outcome).toBe("committed");
    expect(db.prepare("SELECT files_changed FROM turn_snapshots WHERE message_id = ?").get(messageId))
      .toEqual({ files_changed: '["shell.txt"]' });
    expect(db.prepare("SELECT has_file_changes FROM threads WHERE id = ?").get(THREAD_ID))
      .toEqual({ has_file_changes: 1 });
  });

  it("refuses to reuse a public assistant row as a staged turn projection", () => {
    writer.start(startInput());
    const input = terminalProjectionInput();
    const messageId = deriveTurnAssistantMessageId(THREAD_ID, "user-1");
    input.assistant.messageId = messageId;
    new MessageRepo(db).createAssistantIdempotent({
      id: messageId, threadId: THREAD_ID, content: input.assistant.content,
      sequence: 2, model: input.assistant.model, attachments: [...input.assistant.attachments],
    });

    expect(() => writer.stageTerminalProjection(input)).toThrow("already public");
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: null });
  });

  it("rolls back all staged rows when a narrative write fails", async () => {
    writer.start(startInput());
    const input = terminalProjectionInput();
    db.run("CREATE TRIGGER fail_hook BEFORE INSERT ON hook_executions BEGIN SELECT RAISE(ABORT, 'hook unavailable'); END");
    expect(() => writer.stageTerminalProjection(input)).toThrow("hook unavailable");
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tool_call_records").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM thought_segments").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?").get(EXECUTION_ID))
      .toEqual({ terminal_outcome: null });
    expect(published.flat()).not.toContain(`${EXECUTION_ID}:turn.completed`);

    db.run("DROP TRIGGER fail_hook");
    const staged = writer.stageTerminalProjection(input);
    expect(staged.messageId).not.toBeNull();
    expect(staged.toolCallCount).toBe(1);
  });
});
