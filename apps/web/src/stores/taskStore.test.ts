import { beforeEach, describe, expect, it } from "vitest";
import type { PlanVersion } from "@mcode/contracts";
import { selectTaskProgress, useTaskStore, type TaskItem } from "./taskStore";

const THREAD = "thread-task-bubble";

function task(id: string, status: TaskItem["status"], group = "Tasks"): TaskItem {
  return { id, content: id, status, group };
}

function plan(title: string, acceptedMessageId: string | null): PlanVersion {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    threadId: THREAD,
    messageId: null,
    version: 1,
    title,
    contentMd: "",
    status: acceptedMessageId ? "accepted" : "ready",
    author: "agent",
    providerId: null,
    captureSource: "native",
    baseVersionId: null,
    revision: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    acceptedAt: null,
    acceptedMessageId,
  };
}

describe("task bubble lifecycle", () => {
  beforeEach(() => {
    useTaskStore.setState({
      tasksByThread: {},
      taskBubbleByThread: {},
      pendingTaskBubbleReplacementByThread: {},
    });
  });

  it("shows parent-agent tasks and excludes sub-agent groups", () => {
    useTaskStore.getState().setTasks(THREAD, [
      task("parent", "pending"),
      task("child", "pending", "Child agent"),
    ], "msg-1");

    expect(useTaskStore.getState().taskBubbleByThread[THREAD]).toEqual({
      tasks: [task("parent", "pending")],
      sourceMessageId: "msg-1",
    });
  });

  it("records the source only for parent-list writes", () => {
    useTaskStore.getState().setGroupTasks(THREAD, "Tasks", [task("parent", "pending")], "msg-1");
    useTaskStore.getState().setGroupTasks(THREAD, "Child agent", [task("child", "pending")], "msg-2");

    expect(useTaskStore.getState().taskBubbleByThread[THREAD]?.sourceMessageId).toBe("msg-1");
  });

  it("clears settled parent tasks on new send", () => {
    useTaskStore.getState().setGroupTasks(THREAD, "Tasks", [
      task("done", "completed"),
      task("dropped", "cancelled"),
    ]);

    useTaskStore.getState().prepareTaskBubbleForNewTurn(THREAD);

    expect(useTaskStore.getState().taskBubbleByThread[THREAD]).toBeUndefined();
  });

  it("keeps unsettled old tasks and their source until the first parent-task update replaces them", () => {
    useTaskStore.getState().setGroupTasks(THREAD, "Tasks", [task("old", "pending")], "msg-old");

    useTaskStore.getState().prepareTaskBubbleForNewTurn(THREAD);
    expect(useTaskStore.getState().taskBubbleByThread[THREAD]).toEqual({
      tasks: [task("old", "pending")],
      sourceMessageId: "msg-old",
    });

    useTaskStore.getState().setGroupTasks(THREAD, "Tasks", [task("new", "in_progress")], "msg-new");

    expect(useTaskStore.getState().taskBubbleByThread[THREAD]).toEqual({
      tasks: [task("new", "in_progress")],
      sourceMessageId: "msg-new",
    });
    expect(useTaskStore.getState().pendingTaskBubbleReplacementByThread[THREAD]).toBeUndefined();
  });

  it("clears unsettled old tasks when the new turn ends without parent-task updates", () => {
    useTaskStore.getState().setGroupTasks(THREAD, "Tasks", [task("old", "pending")]);

    useTaskStore.getState().prepareTaskBubbleForNewTurn(THREAD);
    useTaskStore.getState().clearTaskBubbleIfAwaitingReplacement(THREAD);

    expect(useTaskStore.getState().taskBubbleByThread[THREAD]).toBeUndefined();
  });
});

describe("selectTaskProgress", () => {
  const mixed = [
    task("a", "completed"),
    task("b", "cancelled"),
    task("c", "in_progress"),
    task("d", "pending"),
  ];

  it("returns null without a list or with an empty list", () => {
    expect(selectTaskProgress(undefined, [])).toBeNull();
    expect(selectTaskProgress({ tasks: [], sourceMessageId: "msg-1" }, [])).toBeNull();
  });

  it("counts cancelled tasks as settled and maps each task to a segment", () => {
    expect(selectTaskProgress({ tasks: mixed, sourceMessageId: null }, undefined)).toEqual({
      title: "Tasks",
      settled: 2,
      total: 4,
      segments: ["done", "done", "current", "pending"],
    });
  });

  it("titles a list from an ordinary turn \"Tasks\"", () => {
    const progress = selectTaskProgress({ tasks: mixed, sourceMessageId: "msg-ordinary" }, undefined);

    expect(progress?.title).toBe("Tasks");
  });

  it("titles a list with the plan version whose accepted message started the turn", () => {
    const plans = [plan("Old plan", "msg-other"), plan("Tidy thread actions menu", "msg-implement")];

    const progress = selectTaskProgress({ tasks: mixed, sourceMessageId: "msg-implement" }, plans);

    expect(progress?.title).toBe("Tidy thread actions menu");
  });

  it("titles a list \"Tasks\" when no plan version was accepted by its turn", () => {
    const plans = [plan("Unaccepted plan", null), plan("Other turn's plan", "msg-other")];

    const progress = selectTaskProgress({ tasks: mixed, sourceMessageId: "msg-ordinary" }, plans);

    expect(progress?.title).toBe("Tasks");
  });
});
