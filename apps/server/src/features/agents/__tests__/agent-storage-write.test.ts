import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../runtime/persistence/sqlite/database.js";
import { openReadOnlyDatabase } from "../../../runtime/persistence/sqlite/read-only-database.js";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { ToolCallRecordRepo } from "../tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../events/persistence/hook-execution-repo.js";
import { TaskRepo } from "../orchestration/persistence/task-repo.js";
import { PlanRepo } from "../planning/persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../planning/persistence/plan-question-answers-repo.js";
import { TurnSnapshotRepo } from "../turns/persistence/turn-snapshot-repo.js";
import { TurnDiffRepo } from "../turns/persistence/turn-diff-repo.js";
import { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { PlanQuestionService } from "../planning/plan-question-service.js";

describe("agent storage through the application writer", () => {
  let directory: string;
  let reader: Database;
  let writer: ApplicationDatabaseWriter;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-agent-storage-"));
    const dbPath = NodePath.join(directory, "app.sqlite");
    const setup = openDatabase({ dbPath });
    setup.run("INSERT INTO workspaces (id, name, path) VALUES ('workspace', 'Fixture', 'fixture')");
    setup.run("INSERT INTO threads (id, workspace_id, title, branch) VALUES ('thread', 'workspace', 'Fixture', 'main')");
    setup.run("CREATE TRIGGER reject_test_hook BEFORE INSERT ON hook_executions WHEN NEW.hook_name = 'reject' BEGIN SELECT RAISE(ABORT, 'hook projection rejected'); END");
    setup.close(true);
    reader = openReadOnlyDatabase(dbPath);
    writer = new ApplicationDatabaseWriter(dbPath);
  });

  afterEach(async () => {
    await writer.close();
    reader.close(true);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("commits messages, narrative, answers and settled evidence before synchronous reads observe them", async () => {
    const messages = new MessageRepo(reader, writer);
    const tools = new ToolCallRecordRepo(reader, writer);
    const thoughts = new ThoughtSegmentRepo(reader, writer);
    const hooks = new HookExecutionRepo(reader, writer);
    const answers = new PlanQuestionAnswersRepo(reader, writer);
    const snapshots = new TurnSnapshotRepo(reader, writer);
    const diffs = new TurnDiffRepo(reader, writer);
    const message = await messages.create("thread", "assistant", "Complete", 1);
    await messages.setAssistantOutcome(message.id, "completed", "execution");
    await answers.markAnswered(message.id, "thread");
    await tools.create({ toolCallId: "tool", messageId: message.id, toolName: "Read", inputSummary: "file", outputSummary: "contents", status: "completed", sortOrder: 1 });
    await thoughts.create({ id: "thought", messageId: message.id, text: "Complete", startedAt: "2026-10-01T10:00:00Z", endedAt: null, sortOrder: 2, isFinalResponse: 1 });
    await hooks.create({ id: "hook", messageId: message.id, hookName: "after", toolName: null, phase: "after", payload: "{}", durationMs: 1, didBlock: false, startedAt: "2026-10-01T10:00:00Z", endedAt: null, sortOrder: 3 });
    const snapshot = await snapshots.create({ messageId: message.id, threadId: "thread", refBefore: "before", refAfter: "after", filesChanged: ["file"], worktreePath: null });
    await diffs.create({ id: "diff", message_id: message.id, thread_id: "thread", source: "tracked", patch: "diff", revision: 1 });
    expect(messages.findById(message.id)?.outcome).toBe("completed");
    expect(answers.isAnswered(message.id)).toBe(true);
    expect(snapshots.getByMessage(message.id)?.id).toBe(snapshot.id);
    expect(diffs.latest("thread")?.id).toBe("diff");
    expect(new NarrativeStore(messages, tools, thoughts, hooks, reader).loadForMessages([message]).map(entry => entry.kind))
      .toEqual(["toolCall", "assistantMessage", "hook"]);
  });

  it("serializes concurrent task read-modify-write operations without losing groups", async () => {
    const tasks = new TaskRepo(reader, writer);
    await Promise.all([
      tasks.upsertGroup("thread", "Agent A", [{ id: "1", content: "A", status: "pending", group: "Agent A" }]),
      tasks.upsertGroup("thread", "Agent B", [{ id: "1", content: "B", status: "pending", group: "Agent B" }]),
    ]);
    expect(await tasks.updateTask("thread", "1", { status: "completed" }, "Agent B")).toBe(true);
    expect(tasks.get("thread")).toEqual([
      { id: "1", content: "A", status: "pending", group: "Agent A" },
      { id: "1", content: "B", status: "completed", group: "Agent B" },
    ]);
  });

  it("serializes attachment merges without losing an overlapping append", async () => {
    const messages = new MessageRepo(reader, writer);
    const message = await messages.create("thread", "assistant", "Attachments", 1);
    const first = { id: "first", name: "first.txt", mimeType: "text/plain", sizeBytes: 1 };
    const second = { id: "second", name: "second.txt", mimeType: "text/plain", sizeBytes: 2 };
    await Promise.all([
      messages.appendAttachments(message.id, [first]),
      messages.appendAttachments(message.id, [second]),
    ]);
    expect(messages.findById(message.id)?.attachments).toEqual([first, second]);
  });

  it("allocates concurrent plan versions atomically and preserves ready versions after a failed command", async () => {
    const messages = new MessageRepo(reader, writer);
    const plans = new PlanRepo(reader, writer);
    const message = await messages.create("thread", "assistant", "Plan", 1);
    const first = await plans.create("thread", message.id, { title: "First", contentMd: "First", captureSource: "fence" }, null);
    await expect(plans.create("thread", "missing-message", { title: "Invalid", contentMd: "Invalid", captureSource: "fence" }, null)).rejects.toThrow("FOREIGN KEY");
    expect(plans.getLatestForThread("thread")?.status).toBe("ready");
    const results = await Promise.all([
      plans.create("thread", message.id, { title: "Second", contentMd: "Second", captureSource: "fence" }, null),
      plans.create("thread", message.id, { title: "Third", contentMd: "Third", captureSource: "fence" }, null),
    ]);
    expect([first.version, ...results.map(plan => plan.version)]).toEqual([1, 2, 3]);
    expect(plans.listByThread("thread").map(plan => plan.status)).toEqual(["superseded", "superseded", "ready"]);
  });

  it("commits bounded narrative prefixes and validates every row before the first write", async () => {
    const messages = new MessageRepo(reader, writer);
    const thoughts = new ThoughtSegmentRepo(reader, writer);
    const message = await messages.create("thread", "assistant", "Narrative", 1);
    const rows = Array.from({ length: 7 }, (_, index) => ({ id: `thought-${index}`, messageId: message.id, text: "thinking", startedAt: "2026-10-01T10:00:00Z", endedAt: null, sortOrder: index }));
    const result = await thoughts.bulkCreateBatched(rows, { maxRows: 2, maxBytes: 4096, maxElapsedMs: 1000 });
    expect(result).toMatchObject({ batches: 4, rows: 7 });
    expect(thoughts.listByMessage(message.id)).toHaveLength(7);
    await expect(thoughts.bulkCreateBatched([
      { ...rows[0]!, id: "valid" }, { ...rows[1]!, id: "oversized", text: "x".repeat(4096) },
    ], { maxRows: 2, maxBytes: 1024, maxElapsedMs: 1000 })).rejects.toThrow("exceeds");
    expect(thoughts.listByMessage(message.id)).toHaveLength(7);
  });

  it("awaits saved plan dismissal before its answer marker becomes visible", async () => {
    const messages = new MessageRepo(reader, writer);
    const answers = new PlanQuestionAnswersRepo(reader, writer);
    const message = await messages.create("thread", "assistant", "```plan-questions\n[]\n```", 1);
    const service = new PlanQuestionService(messages, answers);
    expect(await service.dismiss("thread")).toBe(message.id);
    expect(answers.isAnswered(message.id)).toBe(true);
  });

  it("rolls back every recovered narrative table when the last projection fails", async () => {
    const messages = new MessageRepo(reader, writer);
    const tools = new ToolCallRecordRepo(reader, writer);
    const thoughts = new ThoughtSegmentRepo(reader, writer);
    const hooks = new HookExecutionRepo(reader, writer);
    const source = await messages.create("thread", "assistant", "Source", 1);
    const target = await messages.create("thread", "assistant", "Recovered", 2);
    const tool = await tools.create({ toolCallId: "source-tool", messageId: source.id, toolName: "Read", inputSummary: "file", outputSummary: "contents", status: "completed", sortOrder: 1 });
    const thought = await thoughts.create({ id: "source-thought", messageId: source.id, text: "thinking", startedAt: "2026-10-01T10:00:00Z", endedAt: null, sortOrder: 2 });
    const hook = await hooks.create({ id: "source-hook", messageId: source.id, hookName: "allowed", toolName: null, phase: "after", payload: "{}", durationMs: 1, didBlock: false, startedAt: "2026-10-01T10:00:00Z", endedAt: null, sortOrder: 3 });
    await expect(messages.persistRecoveredNarrative(target.id, [
      { kind: "toolCall", record: { ...tool, id: "recovered-tool" } },
      { kind: "narrationSegment", record: { ...thought, id: "recovered-thought" } },
      { kind: "hook", record: { ...hook, id: "recovered-hook", hook_name: "reject" } },
    ])).rejects.toThrow("hook projection rejected");
    expect(tools.listByMessage(target.id)).toEqual([]);
    expect(thoughts.listByMessage(target.id)).toEqual([]);
    expect(hooks.listByMessage(target.id)).toEqual([]);
    await hooks.create({ id: "following-hook", messageId: target.id, hookName: "allowed", toolName: null, phase: "after", payload: "{}", durationMs: 1, didBlock: false, startedAt: "2026-10-01T10:00:00Z", endedAt: null, sortOrder: 4 });
    expect(hooks.listByMessage(target.id)).toHaveLength(1);
  });
});
