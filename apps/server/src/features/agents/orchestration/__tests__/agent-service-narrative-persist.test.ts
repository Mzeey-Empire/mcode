import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { container } from "tsyringe";
import { openWorkerTurnFixture } from "./worker-turn-fixture.js";
import { TaskRepo } from "../persistence/task-repo.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";

describe("AgentService narrative persistence through worker admission", () => {
  let fixture: Awaited<ReturnType<typeof openWorkerTurnFixture>>;
  beforeEach(async () => { fixture = await openWorkerTurnFixture(); });
  afterEach(async () => { await fixture?.close(); });

  it("persists TaskCreate at result time keyed by the harness-assigned id", async () => {
    const tasks = new TaskRepo(fixture.db, fixture.writer);
    await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, toolCallId: "create-1", toolName: "TaskCreate",
      toolInput: { subject: "Buy groceries", description: "Pick up milk", activeForm: "Buying groceries" } });
    expect(tasks.get(fixture.thread.id)).toBeNull();
    await fixture.emit({ type: "toolResult", threadId: fixture.thread.id, toolCallId: "create-1",
      output: "Task #1 created successfully: Buy groceries", isError: false });
    expect(tasks.get(fixture.thread.id)).toEqual([{
      id: "1", content: "Buy groceries - Pick up milk", status: "pending", activeForm: "Buying groceries", group: "Tasks",
    }]);
  });

  it("does not persist a TaskCreate whose result errored", async () => {
    const tasks = new TaskRepo(fixture.db, fixture.writer);
    await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, toolCallId: "create-1", toolName: "TaskCreate", toolInput: { subject: "Doomed" } });
    await fixture.emit({ type: "toolResult", threadId: fixture.thread.id, toolCallId: "create-1", output: "Task #2 created successfully", isError: true });
    expect(tasks.get(fixture.thread.id)).toBeNull();
  });

  it.each([
    ["status transition", { taskId: "1", status: "in_progress" }, [{ id: "1", content: "Original", status: "in_progress", group: "Tasks" }]],
    ["deletion", { taskId: "1", status: "deleted" }, []],
    ["subject and activeForm", { taskId: "1", subject: "Run unit tests", activeForm: "Running unit tests" },
      [{ id: "1", content: "Run unit tests", status: "pending", activeForm: "Running unit tests", group: "Tasks" }]],
  ])("persists a TaskUpdate %s by harness id", async (_name, toolInput, expected) => {
    const tasks = new TaskRepo(fixture.db, fixture.writer);
    await tasks.upsert(fixture.thread.id, [{ id: "1", content: "Original", status: "pending", group: "Tasks" }]);
    await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, toolCallId: "update-1", toolName: "TaskUpdate", toolInput });
    expect(tasks.get(fixture.thread.id)).toEqual(expected);
  });

  it("persists Codex update_plan tool calls for Scope hydration", async () => {
    await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, toolCallId: "plan-1", toolName: "update_plan",
      toolInput: { plan: [{ step: "First", status: "pending" }, { step: "Second", status: "inProgress" }, { step: "Third", status: "completed" }] } });
    expect(new TaskRepo(fixture.db, fixture.writer).get(fixture.thread.id)).toEqual([
      { content: "First", status: "pending", group: "Tasks" },
      { content: "Second", status: "in_progress", group: "Tasks" },
      { content: "Third", status: "completed", group: "Tasks" },
    ]);
  });

  it("persists a shell exit code from its tool result", async () => {
    await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, toolCallId: "shell-1", toolName: "command_execution", toolInput: { command: "exit 1" } });
    await fixture.emit({ type: "toolResult", threadId: fixture.thread.id, toolCallId: "shell-1", output: "", isError: true, exitCode: 1 });
    await fixture.finish();
    expect(fixture.tools.listByMessage(fixture.assistant()!.id)).toEqual([
      expect.objectContaining({ id: "shell-1", exit_code: 1, status: "failed" }),
    ]);
  });

  it("segments thoughts split by tool calls with strictly-ordered sortOrder", async () => {
    await fixture.emit({ type: "textDelta", threadId: fixture.thread.id, delta: "I will read.", isFinalResponse: false });
    await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, toolCallId: "read-1", toolName: "Read", toolInput: {} });
    await fixture.emit({ type: "textDelta", threadId: fixture.thread.id, delta: "Now respond.", isFinalResponse: false });
    await fixture.finish();
    const id = fixture.assistant()!.id;
    expect(fixture.thoughts.listByMessage(id)).toEqual([
      expect.objectContaining({ text: "I will read.", sort_order: 0 }),
      expect.objectContaining({ text: "Now respond.", sort_order: 2 }),
    ]);
    expect(fixture.tools.listByMessage(id)).toEqual([expect.objectContaining({ id: "read-1", sort_order: 1 })]);
  });

  it("applies reasoning as its own segment, closing narration and later answer text", async () => {
    await fixture.emit({ type: "textDelta", threadId: fixture.thread.id, delta: "I will check.", isFinalResponse: false });
    await fixture.emit({ type: "reasoningDelta", threadId: fixture.thread.id, delta: "Weighing", reasoningItemId: "rs-1" });
    await fixture.emit({ type: "reasoningDelta", threadId: fixture.thread.id, delta: " options.", reasoningItemId: "rs-1" });
    await fixture.emit({ type: "textDelta", threadId: fixture.thread.id, delta: "Answer.", isFinalResponse: true });
    await fixture.finish();
    expect(fixture.assistant()).toMatchObject({ content: "Answer." });
    expect(fixture.thoughts.listByMessage(fixture.assistant()!.id)).toEqual([
      expect.objectContaining({ text: "I will check.", kind: "narration" }),
      expect.objectContaining({ text: "Weighing options.", kind: "reasoning" }),
    ]);
  });

  it("records a hook execution between tool calls with didBlock round-trip", async () => {
    await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, toolCallId: "first", toolName: "Bash", toolInput: { command: "ls" } });
    await fixture.emit({ type: "hookStarted", threadId: fixture.thread.id, hookName: "PreToolUse", hookType: "permission", toolName: "Bash" });
    await fixture.emit({ type: "hookCompleted", threadId: fixture.thread.id, hookName: "PreToolUse", exitCode: 2, durationMs: 55, didBlock: true });
    await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, toolCallId: "second", toolName: "Read", toolInput: {} });
    await fixture.finish();
    expect(fixture.hooks.listByMessage(fixture.assistant()!.id)).toEqual([
      expect.objectContaining({ hook_name: "PreToolUse", duration_ms: 55, did_block: true, sort_order: 1 }),
    ]);
  });

  it.each([true, false])("classifies a message boundary with isFinalResponse=%s", async (isFinalResponse) => {
    await fixture.emit({ type: "textDelta", threadId: fixture.thread.id, delta: "Boundary text" });
    await fixture.emit({ type: "assistantMessageBoundary", threadId: fixture.thread.id, isFinalResponse });
    await fixture.finish();
    expect(fixture.assistant()).toMatchObject({ content: isFinalResponse ? "Boundary text" : "" });
    expect(fixture.thoughts.listByMessage(fixture.assistant()!.id).map((thought) => thought.text))
      .toEqual(isFinalResponse ? [] : ["Boundary text"]);
  });

  it("keeps Codex child payload out of the parent narrative", async () => {
    const canonical = container.resolve(CanonicalAgentBoundary);
    await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, toolCallId: "spawn-1", toolName: "Agent", toolInput: {} },
      { providerId: "codex", kind: "codex-collaboration", collaboration: { kind: "spawnAgent", receiverThreadIds: ["child-native"], prompt: "private child prompt" } });
    const delegation = canonical.loadCodexChildDelegation(fixture.thread.id, "toolCall:spawn-1");
    expect(delegation?.childThread.activityState).toBe("Starting");
    const child = { nativeThreadId: "child-native", nativeTurnId: "child-turn", parentCollaborationItemId: "spawn-1" };
    await fixture.emit({ type: "turnStarted", threadId: fixture.thread.id }, { providerId: "codex", kind: "codex-collaboration", child });
    await fixture.emit({ type: "textDelta", threadId: fixture.thread.id, delta: "private child answer", isFinalResponse: true },
      { providerId: "codex", kind: "codex-collaboration", child });
    await fixture.emit({ type: "message", threadId: fixture.thread.id, content: "Parent answer", tokens: null });
    await fixture.finish();
    expect(fixture.assistant()).toMatchObject({ content: "Parent answer" });
    expect(fixture.messages.listByThread(fixture.thread.id, 100).messages.map((message) => message.content))
      .not.toContain("private child answer");
    expect(fixture.published.filter((event) => event.type === "textDelta" && event.delta === "private child answer")).toEqual([]);
  });
});
