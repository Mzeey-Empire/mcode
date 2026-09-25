import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { AgentEventType, type PlanQuestion } from "@mcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { PlanRepo } from "../../planning/persistence/plan-repo.js";
import { AgentEventPublicationRegistry } from "../../orchestration/agent-event-publication-registry.js";
import { deriveTurnAssistantMessageId } from "../../turns/turn-assistant-message-id.js";
import type { ExecutionSemanticOperation } from "../../execution/execution-worker-handler.js";
import { CanonicalExecutionSemanticWriter } from "../canonical-execution-semantic-writer.js";
import { CanonicalAgentWriterClient } from "../canonical-agent-writer-client.js";
import { CanonicalExecutionWriterPort } from "../canonical-execution-writer-port.js";
import { ExecutionLivePublicationRelease } from "../execution-live-publication-release.js";
import { ExecutionPlanQuestionRelease } from "../execution-plan-question-release.js";
import type { DataOnlyParentTurnStartInput } from "../canonical-parent-turn-write.js";

const THREAD_ID = "thread-plan";
const TURN_ID = "turn-plan";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000091";
const NOW = "2026-09-24T10:00:00.000Z";
const execution = { threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID } as const;
const lease = { ownerEpoch: 1, workerIndex: 0, workerGeneration: 1, leaseId: "lease-plan" } as const;
const questions = [{ id: "q1", category: "AUTH", question: "Which login?", options: [
  { id: "o1", title: "Passkey", description: "Use passkeys.", recommended: true },
  { id: "o2", title: "Password", description: "Use passwords." },
] }];
const planOutput = { title: "Login plan", contentMd: "# Login plan\n## Build\nUse passkeys.",
  sectionsJson: '[{"id":"s1","title":"Build","level":2}]', changeSummary: null };

function seedThread(db: Database): void {
  db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("workspace-plan", "Workspace", "C:/fixture", NOW, NOW);
  db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(THREAD_ID, "workspace-plan", "Thread", "main", "codex", NOW, NOW);
}

function startInput(): DataOnlyParentTurnStartInput {
  return {
    thread: { id: THREAD_ID, workspaceId: "workspace-plan", providerId: "codex", createdAt: NOW },
    turnId: TURN_ID, executionId: EXECUTION_ID, permissionMode: "supervised", providerIdentities: [],
    userMessage: { kind: "create", messageId: "user-plan", content: "Plan login", sequence: 1 },
  };
}

function operation(ordinal: number, mutation: ExecutionSemanticOperation["mutation"]): ExecutionSemanticOperation {
  return { operationId: `${lease.leaseId}:${ordinal}`, execution, lease, ordinal, mutation };
}

describe("Codex live plan projections on the sole writer", () => {
  let directory: string;
  let path: string;
  let db: Database;
  let writer: CanonicalExecutionSemanticWriter;

  beforeEach(async () => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-plan-projection-"));
    path = NodePath.join(directory, "mcode.db");
    db = openDatabase({ dbPath: path });
    seedThread(db);
    writer = new CanonicalExecutionSemanticWriter(db, () => {});
    expect((await writer.transact(operation(1, { kind: "begin", providerId: "codex", input: startInput() }))).kind)
      .toBe("committed");
  });

  afterEach(() => {
    db.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("replays the question publication receipt after the writer restarts", async () => {
    const block = `\`\`\`plan-questions\n${JSON.stringify(questions)}\n\`\`\``;
    const event = { type: AgentEventType.TextDelta, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
      isFinalResponse: true, delta: block };
    const write = { ...operation(2, { kind: "live-event", text: { kind: "append", inputs: [
      { ...execution, sequence: 1, text: block },
    ] }, planQuestions: questions }), livePublication: [{ after: "writer" as const, event }] };
    const published: Array<{ threadId: string; questions: readonly PlanQuestion[] }> = [];
    const release = new ExecutionPlanQuestionRelease((threadId, batch) => published.push({ threadId, questions: batch }));
    expect(published).toEqual([]);
    const receipt = await writer.transact(write);
    expect(receipt).toMatchObject({ kind: "committed", planQuestions: {
      publicationId: "lease-plan:2:plan-questions", threadId: THREAD_ID, questions,
    }, livePublication: [{ event }] });
    release.release(write, receipt);
    release.release(write, receipt);
    expect(published).toEqual([{ threadId: THREAD_ID, questions }]);
    const compound = { ...write, mutation: {
      kind: "append-events" as const, phase: "running", nativeCursor: null, events: [],
      parentLive: { text: write.mutation.text, planQuestions: questions },
    } };
    expect(new ExecutionPlanQuestionRelease(() => {}).validate(compound, receipt)).toEqual(receipt.kind === "committed"
      ? receipt.planQuestions : null);
    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalExecutionSemanticWriter(db, () => {});
    expect(await writer.transact(write)).toEqual(receipt);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "lease-plan:2")).toEqual({ count: 1 });
  });

  it("publishes questions through the worker port only after its receipt", async () => {
    const block = `\`\`\`plan-questions\n${JSON.stringify(questions)}\n\`\`\``;
    const event = { type: AgentEventType.TextDelta, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
      isFinalResponse: true, delta: block };
    const write = { ...operation(2, { kind: "live-event", text: { kind: "append", inputs: [
      { ...execution, sequence: 1, text: block },
    ] }, planQuestions: questions }), livePublication: [{ after: "writer" as const, event }] };
    const published: string[] = [];
    const registry = new AgentEventPublicationRegistry();
    registry.bind((item) => published.push(`agent:${item.type}`));
    const client = new CanonicalAgentWriterClient(path);
    const port = new CanonicalExecutionWriterPort(client, () => {},
      new ExecutionLivePublicationRelease(registry),
      new ExecutionPlanQuestionRelease(() => published.push("plan.questions")));
    try {
      expect(published).toEqual([]);
      expect((await port.transact(write)).kind).toBe("committed");
      expect(published).toEqual(["agent:textDelta", "plan.questions"]);
      expect((await port.transact(write)).kind).toBe("committed");
      expect(published).toEqual(["agent:textDelta", "plan.questions"]);
    } finally {
      await client.close();
    }
  });

  it("persists a plan with its staged assistant before acknowledging the message", async () => {
    const messageId = deriveTurnAssistantMessageId(THREAD_ID, "user-plan");
    const content = "# Login plan\n## Build\nUse passkeys.";
    const event = { type: AgentEventType.Message, threadId: THREAD_ID, turnExecutionId: EXECUTION_ID,
      messageId, content, model: null, tokens: null };
    const write = { ...operation(2, { kind: "live-event", text: { kind: "unchanged" },
      message: { precedingMessageId: "user-plan", messageId, content, model: null, attachments: [] },
      planOutput,
    }), livePublication: [{ after: "writer" as const, event }] };
    db.run("CREATE TRIGGER fail_plan_receipt BEFORE INSERT ON canonical_writer_operation_receipts WHEN NEW.kind = 'semantic:live-event' BEGIN SELECT RAISE(ABORT, 'plan receipt unavailable'); END");
    await expect(writer.transact(write)).rejects.toThrow("plan receipt unavailable");
    expect(new PlanRepo(db).listByThread(THREAD_ID)).toEqual([]);
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get(messageId)).toBeNull();
    db.run("DROP TRIGGER fail_plan_receipt");

    const receipt = await writer.transact(write);
    expect(receipt).toMatchObject({ kind: "committed", planOutput: {
      threadId: THREAD_ID, messageId, title: planOutput.title, version: 1,
    }, livePublication: [{ event }] });
    expect(db.prepare("SELECT is_internal FROM messages WHERE id = ?").get(messageId)).toEqual({ is_internal: 1 });
    expect(new PlanRepo(db).getByMessageId(messageId)).toEqual(receipt.kind === "committed" ? receipt.planOutput : null);
    db.close(true);
    db = openDatabase({ dbPath: path });
    writer = new CanonicalExecutionSemanticWriter(db, () => {});
    expect(await writer.transact(write)).toEqual(receipt);
    expect(new PlanRepo(db).listByThread(THREAD_ID)).toHaveLength(1);
    expect(await writer.transact({ ...write, mutation: { ...write.mutation, planOutput: {
      ...planOutput, title: "Different plan",
    } } })).toEqual({ kind: "conflict", operationId: "lease-plan:2" });
  });

  it("rejects detached or malformed plan data without advancing the execution", async () => {
    const event = { type: AgentEventType.TextDelta, threadId: THREAD_ID,
      turnExecutionId: EXECUTION_ID, isFinalResponse: true, delta: "text" };
    const base = { ...operation(2, { kind: "live-event", text: { kind: "append", inputs: [
      { ...execution, sequence: 1, text: "text" },
    ] } }), livePublication: [{ after: "writer" as const, event }] };
    expect(await writer.transact({ ...base, mutation: { ...base.mutation,
      planOutput } })).toEqual({ kind: "conflict", operationId: "lease-plan:2" });
    expect(await writer.transact({ ...base, mutation: { ...base.mutation,
      planQuestions: [{ ...questions[0], options: [] }] } })).toEqual({ kind: "conflict", operationId: "lease-plan:2" });
    expect(new PlanRepo(db).listByThread(THREAD_ID)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM canonical_writer_operation_receipts WHERE execution_id = ? AND operation_id = ?")
      .get(EXECUTION_ID, "lease-plan:2")).toEqual({ count: 0 });
  });
});
