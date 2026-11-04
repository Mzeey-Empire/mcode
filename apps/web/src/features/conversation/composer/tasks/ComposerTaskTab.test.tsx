import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlanStore } from "@/stores/planStore";
import { useTaskStore, type TaskItem } from "@/stores/taskStore";
import { ComposerTaskTab } from "./ComposerTaskTab";

const THREAD = "thread-task-tab";

function item(id: string, status: TaskItem["status"], content: string, activeForm?: string): TaskItem {
  return { id, content, status, group: "Tasks", ...(activeForm ? { activeForm } : {}) };
}

const NINE_TASKS = [
  item("1", "completed", "Read the menu"),
  item("2", "cancelled", "Drop the old row"),
  item("3", "in_progress", "Add Archive", "Adding Archive"),
  item("4", "pending", "Add shortcut"),
  item("5", "pending", "Wire the store"),
  item("6", "pending", "Write tests"),
  item("7", "pending", "Run lint"),
  item("8", "pending", "Run typecheck"),
  item("9", "pending", "Open PR"),
];

function stubReducedMotion(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: reduce,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

interface StubAnimation {
  onfinish: (() => void) | null;
  readonly cancel: () => void;
}

function stubAnimate() {
  const running: StubAnimation[] = [];
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: () => {
      const animation: StubAnimation = { onfinish: null, cancel: vi.fn() };
      running.push(animation);
      return animation;
    },
  });
  return {
    finishAll: () => {
      for (const animation of running.splice(0)) animation.onfinish?.();
    },
  };
}

/** The tab, not the tray header, which shares its accessible name. */
function tab(): HTMLElement {
  const [found] = screen
    .getAllByRole("button", { name: "Tasks, 2 of 9 done", hidden: true })
    .filter((button) => button.hasAttribute("data-task-tab"));
  if (!found) throw new Error("task tab not rendered");
  return found;
}

function listedTasks(): string[] {
  return within(screen.getByRole("list", { name: "Tasks" }))
    .getAllByRole("listitem")
    .map((row) => row.textContent ?? "");
}

describe("ComposerTaskTab", () => {
  beforeEach(() => {
    useTaskStore.setState({ tasksByThread: {}, taskBubbleByThread: {}, pendingTaskBubbleReplacementByThread: {} });
    usePlanStore.setState({ plansByThread: {} });
    stubReducedMotion(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(Element.prototype, "animate");
  });

  it("names the tab with the settled count and renders nothing without tasks", () => {
    const { unmount } = render(<ComposerTaskTab threadId={THREAD} covered={false} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    unmount();

    useTaskStore.getState().setTasks(THREAD, NINE_TASKS, "msg-1");
    render(<ComposerTaskTab threadId={THREAD} covered={false} />);

    expect(tab()).toHaveTextContent("2/9");
    expect(tab()).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a tray that folds settled tasks until the fold is opened", () => {
    useTaskStore.getState().setTasks(THREAD, NINE_TASKS, "msg-1");
    render(<ComposerTaskTab threadId={THREAD} covered={false} />);

    fireEvent.click(tab());

    expect(tab()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "Tasks" })).toBeInTheDocument();
    const fold = screen.getByRole("button", { name: "2 done" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(listedTasks()).toEqual([
      "In progress: Adding Archive",
      "Pending: Add shortcut",
      "Pending: Wire the store",
      "Pending: Write tests",
      "Pending: Run lint",
      "Pending: Run typecheck",
      "Pending: Open PR",
    ]);

    fireEvent.click(fold);

    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(listedTasks()).toHaveLength(9);
    expect(listedTasks()[0]).toBe("Completed: Read the menu");
  });

  it("lists every task without a fold when the list is fully settled", () => {
    useTaskStore.getState().setTasks(THREAD, [item("1", "completed", "Read"), item("2", "cancelled", "Drop")], "msg-1");
    render(<ComposerTaskTab threadId={THREAD} covered={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Tasks, 2 of 2 done" }));

    expect(screen.queryByRole("button", { name: /^\d+ done$/ })).not.toBeInTheDocument();
    expect(listedTasks()).toEqual(["Completed: Read", "Cancelled: Drop"]);
  });

  it("closes on Escape and on a header click, returning focus to the tab", () => {
    useTaskStore.getState().setTasks(THREAD, NINE_TASKS, "msg-1");
    render(<ComposerTaskTab threadId={THREAD} covered={false} />);

    fireEvent.click(tab());
    const header = within(screen.getByRole("region")).getByRole("button", { name: "Tasks, 2 of 9 done" });
    expect(header).toHaveFocus();
    fireEvent.keyDown(header, { key: "Escape" });

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(tab()).toHaveFocus();

    fireEvent.click(tab());
    fireEvent.click(within(screen.getByRole("region")).getByRole("button", { name: "Tasks, 2 of 9 done" }));

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(tab()).toHaveFocus();
  });

  it("keeps the tray mounted while it folds back into the tab", () => {
    stubReducedMotion(false);
    const animations = stubAnimate();
    useTaskStore.getState().setTasks(THREAD, NINE_TASKS, "msg-1");
    render(<ComposerTaskTab threadId={THREAD} covered={false} />);

    fireEvent.click(tab());
    animations.finishAll();
    fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" });

    expect(screen.getByRole("region")).toBeInTheDocument();
    expect(tab()).toHaveAttribute("aria-expanded", "false");

    act(() => animations.finishAll());

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(tab()).toHaveFocus();
  });

  it("closes on a pointerdown outside but not inside", () => {
    useTaskStore.getState().setTasks(THREAD, NINE_TASKS, "msg-1");
    render(
      <>
        <button type="button">elsewhere</button>
        <ComposerTaskTab threadId={THREAD} covered={false} />
      </>,
    );

    fireEvent.click(tab());
    fireEvent.pointerDown(screen.getByRole("list", { name: "Tasks" }));
    expect(screen.getByRole("region")).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("closes for good when the slash menu covers it", () => {
    useTaskStore.getState().setTasks(THREAD, NINE_TASKS, "msg-1");
    const { rerender } = render(<ComposerTaskTab threadId={THREAD} covered={false} />);

    fireEvent.click(tab());
    rerender(<ComposerTaskTab threadId={THREAD} covered />);

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(tab().closest("[inert]")).not.toBeNull();

    rerender(<ComposerTaskTab threadId={THREAD} covered={false} />);

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(tab()).toHaveAttribute("aria-expanded", "false");
  });

  it("titles the tray with the plan version the task list's turn implemented", () => {
    useTaskStore.getState().setTasks(THREAD, NINE_TASKS, "msg-implement");
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
    render(<ComposerTaskTab threadId={THREAD} covered={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Tidy thread actions menu, 2 of 9 done" }));

    const region = screen.getByRole("region", { name: "Tidy thread actions menu" });
    expect(within(region).getByRole("button", { name: "Tidy thread actions menu, 2 of 9 done" })).toHaveTextContent(
      "Tidy thread actions menu",
    );
  });
});
