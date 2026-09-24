import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import type { ParentNarrativeRecoveryItem } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { deriveTurnAssistantMessageId } from "../../turns/turn-assistant-message-id.js";
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
    db = openDatabase({ dbPath: path });
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
