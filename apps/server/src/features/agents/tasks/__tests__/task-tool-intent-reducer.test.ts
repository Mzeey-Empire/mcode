import "reflect-metadata";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";
import { TaskRepo } from "../../orchestration/persistence/task-repo.js";
import type { ExecutionIdentity } from "../../execution/execution-mailbox-protocol.js";
import { TaskPersistenceService } from "../task-persistence-service.js";
import {
  TaskToolIntentReducer,
  type TaskToolCommand,
  type TaskToolWriteIntent,
} from "../task-tool-intent-reducer.js";

describe("TaskToolIntentReducer", () => {
  let db: Database;
  let tasks: TaskRepo;
  let narrative: NarrativeStore;
  let service: TaskPersistenceService;
  let liveThread: string;
  let intentThread: string;
  let execution: ExecutionIdentity;
  let reducer: TaskToolIntentReducer;

  beforeEach(() => {
    db = openMemoryDatabase();
    const workspace = new WorkspaceRepo(db).create("task-tool-reducer", `${process.cwd()}#task-tool-reducer`, false);
    const threads = new ThreadRepo(db);
    liveThread = threads.create(workspace.id, "live", "direct", "main").id;
    intentThread = threads.create(workspace.id, "intents", "direct", "main").id;
    tasks = new TaskRepo(db);
    narrative = new NarrativeStore(
      new MessageRepo(db),
      new ToolCallRecordRepo(db),
      new ThoughtSegmentRepo(db),
      new HookExecutionRepo(db),
      db,
    );
    narrative.beginTurn(liveThread);
    service = new TaskPersistenceService(tasks, narrative);
    execution = { threadId: liveThread, turnId: "turn-1", executionId: "execution-1" };
    reducer = new TaskToolIntentReducer(execution);
  });

  afterEach(() => db.close());

  function applyToIntentThread(intents: readonly TaskToolWriteIntent[]): void {
    for (const intent of intents) {
      switch (intent.kind) {
        case "upsert-group": tasks.upsertGroup(intentThread, intent.group, intent.tasks); break;
        case "append-task": tasks.appendTask(intentThread, intent.task); break;
        case "update-task": tasks.updateTask(intentThread, intent.id, intent.patch, intent.group); break;
        case "remove-task": tasks.removeTask(intentThread, intent.id, intent.group); break;
      }
    }
  }

  function compare(command: TaskToolCommand, applyLive: () => void): TaskToolWriteIntent[] {
    const reduction = reducer.reduce(execution, command);
    expect(reduction.kind).toBe("intents");
    if (reduction.kind !== "intents") throw new Error("Expected task intents");
    expect(structuredClone(reduction)).toEqual(reduction);
    applyToIntentThread(reduction.intents);
    applyLive();
    expect(tasks.get(liveThread)).toEqual(tasks.get(intentThread));
    return reduction.intents;
  }

  function toolUse(
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    parentToolCallId?: string,
  ): TaskToolWriteIntent[] {
    const attributedParent = narrative.bufferToolCall(liveThread, {
      toolCallId, toolName, toolInput, parentToolCallId,
    });
    return compare({
      kind: "tool-use", toolName, toolInput,
      parentToolCallId: attributedParent,
      bufferedCalls: narrative.getBufferedToolCalls(liveThread),
    }, () => service.onToolUse(liveThread, { toolName, toolInput, parentToolCallId: attributedParent }));
  }

  function toolResult(toolCallId: string, output: string, isError = false): TaskToolWriteIntent[] {
    return compare({
      kind: "tool-result", toolCallId, output, isError,
      bufferedCalls: narrative.getBufferedToolCalls(liveThread),
    }, () => service.onToolResult(liveThread, toolCallId, output, isError));
  }

  it("matches live rows for grouped TodoWrite, update_plan, and status normalization", () => {
    expect(toolUse("todos-main", "TodoWrite", {
      todos: [
        { content: "main pending", status: "unknown" },
        { content: "main active", status: "in-progress" },
        { content: "   ", status: "completed" },
      ],
    })).toEqual([{
      kind: "upsert-group", group: "Tasks",
      tasks: [
        { content: "main pending", status: "pending", group: "Tasks" },
        { content: "main active", status: "in_progress", group: "Tasks" },
      ],
    }]);

    toolUse("agent", "Agent", { description: "  Build sub feature  " });
    expect(toolUse("todos-sub", "TodoWrite", {
      todos: [{ content: "sub cancelled", status: "canceled" }],
    }, "agent")).toEqual([{
      kind: "upsert-group", group: "Build sub feature",
      tasks: [{ content: "sub cancelled", status: "cancelled", group: "Build sub feature" }],
    }]);
    narrative.clearAgentStackOnMessage(liveThread);
    expect(toolUse("plan", "update_plan", {
      tasks: ["first step", { title: "second step", status: "inProgress" }, { description: " " }],
    })).toEqual([{
      kind: "upsert-group", group: "Tasks",
      tasks: [
        { content: "first step", status: "pending", group: "Tasks" },
        { content: "second step", status: "in_progress", group: "Tasks" },
      ],
    }]);
    expect(tasks.get(liveThread)).toEqual([
      { content: "sub cancelled", status: "cancelled", group: "Build sub feature" },
      { content: "first step", status: "pending", group: "Tasks" },
      { content: "second step", status: "in_progress", group: "Tasks" },
    ]);
  });

  it("matches live rows for TaskCreate result IDs, updates, and deletion", () => {
    toolUse("agent", "Agent", { prompt: "  Inspect files  " });
    expect(toolUse("create", "TaskCreate", {
      subject: "  Write tests  ", description: "  Cover edge cases  ", activeForm: "  Writing tests  ",
    }, "agent")).toEqual([]);
    expect(toolResult("create", "Created task #27 successfully")).toEqual([{
      kind: "append-task",
      task: {
        id: "27", content: "Write tests - Cover edge cases", status: "pending",
        activeForm: "Writing tests", group: "Inspect files",
      },
    }]);
    expect(toolUse("update", "TaskUpdate", {
      taskId: 27, status: "inProgress", subject: "  Test updates  ", activeForm: "  Checking  ",
    }, "agent")).toEqual([{
      kind: "update-task", id: "27", group: "Inspect files",
      patch: { status: "in_progress", content: "Test updates", activeForm: "Checking" },
    }]);
    expect(tasks.get(liveThread)).toEqual([{
      id: "27", content: "Test updates", status: "in_progress",
      activeForm: "Checking", group: "Inspect files",
    }]);
    expect(toolUse("delete", "TaskUpdate", { taskId: "27", status: "deleted" }, "agent"))
      .toEqual([{ kind: "remove-task", id: "27", group: "Inspect files" }]);
    expect(tasks.get(liveThread)).toEqual([]);
  });

  it("emits no writes for malformed and unsuccessful tool effects", () => {
    expect(toolUse("bad-todos", "TodoWrite", { todos: [null, { content: " " }] })).toEqual([]);
    expect(toolUse("bad-plan", "update_plan", { plan: [], tasks: [{ title: "ignored" }] })).toEqual([]);
    expect(toolUse("bad-update", "TaskUpdate", { taskId: "", status: "completed" })).toEqual([]);
    toolUse("create", "TaskCreate", { title: "Valid title" });
    expect(toolResult("create", "Created task #1", true)).toEqual([]);
    expect(toolResult("create", "Created task without an id")).toEqual([]);
    expect(toolResult("missing", "Created task #1")).toEqual([]);
    expect(tasks.get(liveThread)).toBeNull();
  });

  it("keeps colliding harness IDs scoped to their agent group", () => {
    toolUse("agent-a", "Agent", { description: "Agent A" });
    toolUse("agent-b", "Agent", { description: "Agent B" });
    toolUse("create-a", "TaskCreate", { subject: "A task" }, "agent-a");
    toolUse("create-b", "TaskCreate", { subject: "B task" }, "agent-b");
    toolResult("create-a", "Created #1");
    toolResult("create-b", "Created #1");
    toolUse("ambiguous", "TaskUpdate", { taskId: "1", status: "completed" }, "missing-parent");
    expect(tasks.get(liveThread)).toEqual([
      { id: "1", content: "A task", status: "pending", group: "Agent A" },
      { id: "1", content: "B task", status: "pending", group: "Agent B" },
    ]);
    toolUse("scoped", "TaskUpdate", { taskId: "1", status: "completed" }, "agent-a");
    expect(tasks.get(liveThread)).toEqual([
      { id: "1", content: "A task", status: "completed", group: "Agent A" },
      { id: "1", content: "B task", status: "pending", group: "Agent B" },
    ]);
    toolUse("remove-b", "TaskUpdate", { taskId: "1", status: "deleted" }, "agent-b");
    toolUse("sole-match", "TaskUpdate", { taskId: "1", status: "cancelled" }, "missing-parent");
    expect(tasks.get(liveThread)).toEqual([
      { id: "1", content: "A task", status: "cancelled", group: "Agent A" },
    ]);
  });

  it("rejects stale execution identities before emitting writer intents", () => {
    const command: TaskToolCommand = {
      kind: "tool-use", toolName: "TodoWrite",
      toolInput: { todos: [{ content: "must not appear" }] }, bufferedCalls: [],
    };
    expect(reducer.reduce({ ...execution, executionId: "previous" }, command))
      .toEqual({ kind: "stale-execution" });
    expect(reducer.reduce({ ...execution, turnId: "previous" }, command))
      .toEqual({ kind: "stale-execution" });
    expect(reducer.reduce({ ...execution, threadId: intentThread }, command))
      .toEqual({ kind: "stale-execution" });
    const result: TaskToolCommand = {
      kind: "tool-result", toolCallId: "create", output: "Created #9", isError: false,
      bufferedCalls: [{ toolCallId: "create", toolName: "TaskCreate", _rawToolInput: { subject: "late task" } }],
    };
    expect(reducer.reduce({ ...execution, executionId: "previous" }, result))
      .toEqual({ kind: "stale-execution" });
    expect(reducer.reduce(execution, result)).toEqual({
      kind: "intents", execution,
      intents: [{ kind: "append-task", task: { id: "9", content: "late task", status: "pending", group: "Tasks" } }],
    });
    expect(tasks.get(liveThread)).toBeNull();
  });
});
