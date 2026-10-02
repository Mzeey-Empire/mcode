import "reflect-metadata";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
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
  let setup: Database;
  let tasks: TaskRepo;
  let narrative: NarrativeStore;
  let service: TaskPersistenceService;
  let liveThread: string;
  let intentThread: string;
  let execution: ExecutionIdentity;
  let reducer: TaskToolIntentReducer;

  beforeEach(async () => {
    setup = openAgentStorageTestDatabase();
    db = openReadOnlyDatabase(setup.filename);
    const writer = agentStorageTestWriter(setup);
    const workspace = await new WorkspaceRepo(db, writer).create("task-tool-reducer", `${process.cwd()}#task-tool-reducer`, false);
    const threads = new ThreadRepo(db, writer);
    liveThread = (await threads.create(workspace.id, "live", "direct", "main")).id;
    intentThread = (await threads.create(workspace.id, "intents", "direct", "main")).id;
    tasks = new TaskRepo(db, writer);
    narrative = new NarrativeStore(
      new MessageRepo(db, writer),
      new ToolCallRecordRepo(db, writer),
      new ThoughtSegmentRepo(db, writer),
      new HookExecutionRepo(db, writer),
    );
    narrative.beginTurn(liveThread);
    service = new TaskPersistenceService(tasks, narrative);
    execution = { threadId: liveThread, turnId: "turn-1", executionId: "execution-1" };
    reducer = new TaskToolIntentReducer(execution);
  });

  afterEach(async () => { db.close(true); await closeAgentStorageTestDatabases(); });

  async function applyToIntentThread(intents: readonly TaskToolWriteIntent[]): Promise<void> {
    for (const intent of intents) {
      switch (intent.kind) {
        case "upsert-group": await tasks.upsertGroup(intentThread, intent.group, intent.tasks); break;
        case "append-task": await tasks.appendTask(intentThread, intent.task); break;
        case "update-task": await tasks.updateTask(intentThread, intent.id, intent.patch, intent.group); break;
        case "remove-task": await tasks.removeTask(intentThread, intent.id, intent.group); break;
      }
    }
  }

  async function compare(command: TaskToolCommand, applyLive: () => Promise<void>): Promise<TaskToolWriteIntent[]> {
    const reduction = reducer.reduce(execution, command);
    expect(reduction.kind).toBe("intents");
    if (reduction.kind !== "intents") throw new Error("Expected task intents");
    expect(structuredClone(reduction)).toEqual(reduction);
    await applyToIntentThread(reduction.intents);
    await applyLive();
    expect(tasks.get(liveThread)).toEqual(tasks.get(intentThread));
    return reduction.intents;
  }

  async function toolUse(
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    parentToolCallId?: string,
  ): Promise<TaskToolWriteIntent[]> {
    const attributedParent = narrative.bufferToolCall(liveThread, {
      toolCallId, toolName, toolInput, parentToolCallId,
    });
    return compare({
      kind: "tool-use", toolName, toolInput,
      parentToolCallId: attributedParent,
      bufferedCalls: narrative.getBufferedToolCalls(liveThread),
    }, () => service.onToolUse(liveThread, { toolName, toolInput, parentToolCallId: attributedParent }));
  }

  async function toolResult(toolCallId: string, output: string, isError = false): Promise<TaskToolWriteIntent[]> {
    return compare({
      kind: "tool-result", toolCallId, output, isError,
      bufferedCalls: narrative.getBufferedToolCalls(liveThread),
    }, () => service.onToolResult(liveThread, toolCallId, output, isError));
  }

  it("matches live rows for grouped TodoWrite, update_plan, and status normalization", async () => {
    expect(await toolUse("todos-main", "TodoWrite", {
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

    await toolUse("agent", "Agent", { description: "  Build sub feature  " });
    expect(await toolUse("todos-sub", "TodoWrite", {
      todos: [{ content: "sub cancelled", status: "canceled" }],
    }, "agent")).toEqual([{
      kind: "upsert-group", group: "Build sub feature",
      tasks: [{ content: "sub cancelled", status: "cancelled", group: "Build sub feature" }],
    }]);
    narrative.clearAgentStackOnMessage(liveThread);
    expect(await toolUse("plan", "update_plan", {
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

  it("matches live rows for TaskCreate result IDs, updates, and deletion", async () => {
    await toolUse("agent", "Agent", { prompt: "  Inspect files  " });
    expect(await toolUse("create", "TaskCreate", {
      subject: "  Write tests  ", description: "  Cover edge cases  ", activeForm: "  Writing tests  ",
    }, "agent")).toEqual([]);
    expect(await toolResult("create", "Created task #27 successfully")).toEqual([{
      kind: "append-task",
      task: {
        id: "27", content: "Write tests - Cover edge cases", status: "pending",
        activeForm: "Writing tests", group: "Inspect files",
      },
    }]);
    expect(await toolUse("update", "TaskUpdate", {
      taskId: 27, status: "inProgress", subject: "  Test updates  ", activeForm: "  Checking  ",
    }, "agent")).toEqual([{
      kind: "update-task", id: "27", group: "Inspect files",
      patch: { status: "in_progress", content: "Test updates", activeForm: "Checking" },
    }]);
    expect(tasks.get(liveThread)).toEqual([{
      id: "27", content: "Test updates", status: "in_progress",
      activeForm: "Checking", group: "Inspect files",
    }]);
    expect(await toolUse("delete", "TaskUpdate", { taskId: "27", status: "deleted" }, "agent"))
      .toEqual([{ kind: "remove-task", id: "27", group: "Inspect files" }]);
    expect(tasks.get(liveThread)).toEqual([]);
  });

  it("emits no writes for malformed and unsuccessful tool effects", async () => {
    expect(await toolUse("bad-todos", "TodoWrite", { todos: [null, { content: " " }] })).toEqual([]);
    expect(await toolUse("bad-plan", "update_plan", { plan: [], tasks: [{ title: "ignored" }] })).toEqual([]);
    expect(await toolUse("bad-update", "TaskUpdate", { taskId: "", status: "completed" })).toEqual([]);
    await toolUse("create", "TaskCreate", { title: "Valid title" });
    expect(await toolResult("create", "Created task #1", true)).toEqual([]);
    expect(await toolResult("create", "Created task without an id")).toEqual([]);
    expect(await toolResult("missing", "Created task #1")).toEqual([]);
    expect(tasks.get(liveThread)).toBeNull();
  });

  it("bounds malformed parent chains before selecting a sub-agent group", () => {
    expect(reducer.reduce(execution, {
      kind: "tool-use", toolName: "TodoWrite",
      toolInput: { todos: [{ content: "Task" }] }, parentToolCallId: "first",
      bufferedCalls: [
        { toolCallId: "first", toolName: "Other", parentToolCallId: "second", _rawToolInput: {} },
        { toolCallId: "second", toolName: "Other", parentToolCallId: "first", _rawToolInput: {} },
      ],
    })).toEqual({
      kind: "intents", execution,
      intents: [{ kind: "upsert-group", group: "Sub-agent",
        tasks: [{ content: "Task", status: "pending", group: "Sub-agent" }] }],
    });
  });

  it("keeps colliding harness IDs scoped to their agent group", async () => {
    await toolUse("agent-a", "Agent", { description: "Agent A" });
    await toolUse("agent-b", "Agent", { description: "Agent B" });
    await toolUse("create-a", "TaskCreate", { subject: "A task" }, "agent-a");
    await toolUse("create-b", "TaskCreate", { subject: "B task" }, "agent-b");
    await toolResult("create-a", "Created #1");
    await toolResult("create-b", "Created #1");
    await toolUse("ambiguous", "TaskUpdate", { taskId: "1", status: "completed" }, "missing-parent");
    expect(tasks.get(liveThread)).toEqual([
      { id: "1", content: "A task", status: "pending", group: "Agent A" },
      { id: "1", content: "B task", status: "pending", group: "Agent B" },
    ]);
    await toolUse("scoped", "TaskUpdate", { taskId: "1", status: "completed" }, "agent-a");
    expect(tasks.get(liveThread)).toEqual([
      { id: "1", content: "A task", status: "completed", group: "Agent A" },
      { id: "1", content: "B task", status: "pending", group: "Agent B" },
    ]);
    await toolUse("remove-b", "TaskUpdate", { taskId: "1", status: "deleted" }, "agent-b");
    await toolUse("sole-match", "TaskUpdate", { taskId: "1", status: "cancelled" }, "missing-parent");
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
