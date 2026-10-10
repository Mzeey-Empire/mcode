import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlanStore } from "@/stores/planStore";
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

function segmentStates(): (string | null)[] {
  return Array.from(document.querySelectorAll("[data-segment]"), (node) =>
    node.getAttribute("data-segment"),
  );
}

describe("ComposerTray", () => {
  beforeEach(() => {
    useTaskStore.setState({
      tasksByThread: {},
      taskBubbleByThread: {},
      pendingTaskBubbleReplacementByThread: {},
    });
    usePlanStore.setState({ plansByThread: {} });
  });

  it("renders nothing without tasks", () => {
    const { container } = render(<ComposerTray threadId={THREAD} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders the title, settled count and one segment per task", () => {
    useTaskStore.getState().setTasks(THREAD, FOUR_TASKS, "msg-1");

    render(<ComposerTray threadId={THREAD} />);

    const row = screen.getByRole("group", { name: "Tasks, 1 of 4 done" });
    expect(row).toHaveTextContent("Tasks");
    expect(row).toHaveTextContent("1/4");
    expect(segmentStates()).toEqual(["done", "current", "pending", "pending"]);
  });

  it("titles the row with the plan version the task list's turn implemented", () => {
    useTaskStore.getState().setTasks(THREAD, FOUR_TASKS, "msg-implement");
    usePlanStore.setState({
      plansByThread: {
        [THREAD]: [{
          id: "00000000-0000-4000-8000-000000000001",
          threadId: THREAD,
          messageId: null,
          version: 1,
          title: "Tidy thread actions menu",
          contentMd: "",
          status: "accepted",
          author: "agent",
          providerId: null,
          captureSource: "native",
          baseVersionId: null,
          revision: 0,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          acceptedAt: "2026-10-01T00:00:00.000Z",
          acceptedMessageId: "msg-implement",
        }],
      },
    });

    render(<ComposerTray threadId={THREAD} />);

    expect(screen.getByRole("group", { name: "Tidy thread actions menu, 1 of 4 done" })).toBeInTheDocument();
  });

  it("expands on chevron click and collapses on Escape", () => {
    useTaskStore.getState().setTasks(THREAD, FOUR_TASKS, "msg-1");
    render(<ComposerTray threadId={THREAD} />);

    const chevron = screen.getByRole("button", { name: "Show tasks" });
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chevron);

    const list = screen.getByRole("list", { name: "Tasks" });
    expect(screen.getByRole("button", { name: "Hide tasks" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "Completed: Read the menu",
      "In progress: Adding Archive",
      "Pending: Add shortcut",
      "Pending: Run tests",
    ]);

    list.focus();
    fireEvent.keyDown(list, { key: "Escape" });

    expect(screen.queryByRole("list", { name: "Tasks" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show tasks" })).toHaveFocus();
  });

  it("toggles from the keyboard with Enter on the chevron", async () => {
    useTaskStore.getState().setTasks(THREAD, FOUR_TASKS, "msg-1");
    render(<ComposerTray threadId={THREAD} />);
    const user = userEvent.setup();

    screen.getByRole("button", { name: "Show tasks" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("list", { name: "Tasks" })).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(screen.queryByRole("list", { name: "Tasks" })).not.toBeInTheDocument();
  });

  it("renders the expanded list before the task row so the tray grows upward", () => {
    useTaskStore.getState().setTasks(THREAD, FOUR_TASKS, "msg-1");
    render(<ComposerTray threadId={THREAD} />);

    fireEvent.click(screen.getByRole("group", { name: "Tasks, 1 of 4 done" }));

    const list = screen.getByRole("list", { name: "Tasks" });
    const row = screen.getByRole("group", { name: "Tasks, 1 of 4 done" });
    expect(list.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
