import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore } from "@/stores/planStore";
import { useQueueStore } from "@/stores/queueStore";
import { useTaskStore, type TaskItem } from "@/stores/taskStore";
import { ComposerTray } from "./ComposerTray";

const THREAD = "thread-tray";

function item(id: string, status: TaskItem["status"], content: string, activeForm?: string): TaskItem {
  return { id, content, status, group: "Tasks", ...(activeForm ? { activeForm } : {}) };
}

const FOUR_TASKS = [
  item("one", "completed", "Read the menu"),
  item("two", "in_progress", "Add Archive", "Adding Archive"),
  item("three", "pending", "Add shortcut"),
  item("four", "pending", "Run tests"),
];

describe("ComposerTray", () => {
  beforeEach(() => {
    useTaskStore.setState({
      tasksByThread: {},
      taskBubbleByThread: {},
      pendingTaskBubbleReplacementByThread: {},
    });
    usePlanStore.setState({ plansByThread: {} });
    useQueueStore.setState({ queues: {} });
  });

  it("shows queued rows without a task list", () => {
    useQueueStore.getState().enqueue(THREAD, {
      content: "next",
      displayContent: "next",
      attachments: [],
      model: "",
      permissionMode: "full",
    });
    render(<ComposerTray threadId={THREAD} running={false} queue={<p>queued rows</p>} />);

    expect(screen.getByText("queued rows")).toBeInTheDocument();
  });

  it("renders nothing when tasks are its only content", () => {
    useTaskStore.getState().setTasks(THREAD, FOUR_TASKS, "msg-1");

    const { container } = render(<ComposerTray threadId={THREAD} running={false} queue={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
