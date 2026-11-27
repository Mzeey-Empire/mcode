import { createMockBackgroundCommand, createMockThread, createMockThreadAttention, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DndContextProps, DragEndEvent, DragMoveEvent } from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundCommand } from "@mcode/contracts/models/tool-call-record";
import type { Thread } from "@/transport/types";

// The background-command store subscribes to pushes; these tests send it none.
vi.mock("@/transport", () => ({ getTransport: () => mockTransport, pushEmitter: { on: vi.fn(), off: vi.fn() } }));

// A real pointer drag runs through the real sensors and collision detection. The captured props also let the
// project-reorder cases hand the list the drop event jsdom cannot produce, as ProjectSidebar.no-project.test does.
const dnd = vi.hoisted(() => ({ onDragEnd: undefined as DndContextProps["onDragEnd"], onDragMove: undefined as DndContextProps["onDragMove"] }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: DndContextProps) => {
      dnd.onDragEnd = props.onDragEnd;
      dnd.onDragMove = props.onDragMove;
      return <actual.DndContext {...props} />;
    },
  };
});

vi.mock("@/components/ui/virtual-viewport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/virtual-viewport")>()),
  VirtualViewport: (await import("./fake-virtual-viewport")).FakeVirtualViewport,
}));

import { useBackgroundCommandStore } from "@/features/background-commands/backgroundCommandStore";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { useThreadStore } from "@/stores/threadStore";
import { useCompletionStore } from "../completion-store";
import { useMoveThreadStore, closeMoveThreadDialog } from "../../thread-move/move-thread-store";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useSidebarUiStore } from "../sidebar-ui-store";
import { NO_PROJECT_GROUP_KEY } from "../sidebar-model";
import { ProjectSidebar } from "../ProjectSidebar";

const ALPHA = createMockWorkspace({ id: "ws-alpha", name: "Alpha", path: "/alpha" });
const BETA = createMockWorkspace({ id: "ws-beta", name: "Beta", path: "/beta" });
const HIDDEN = createMockWorkspace({ id: "ws-hidden", name: "No project", path: "/home/.mcode/no-project/a", kind: "no_project", is_git_repo: false });

function thread(overrides: Partial<Thread>): Thread {
  return createMockThread({ workspace_id: HIDDEN.id, last_activity_at: new Date().toISOString(), ...overrides });
}

const LOOSE = thread({ id: "t-loose", title: "Loose thread" });
const RUNNING = thread({ id: "t-running", title: "Running thread" });
const IN_ALPHA = thread({ id: "t-alpha", title: "Alpha thread", workspace_id: ALPHA.id });

function seed(threads: Thread[]): void {
  useWorkspaceStore.setState({
    workspaces: [ALPHA, BETA, HIDDEN],
    threads,
    activeWorkspaceId: null,
    activeThreadId: null,
    loadWorkspaces: vi.fn().mockResolvedValue(undefined),
  });
}

function row(title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${title}`) });
}

function header(workspaceId: string): HTMLElement {
  return screen.getByTestId(`project-row-${workspaceId}`);
}

// jsdom has no layout. Give Alpha's header a box so the pointer can be inside it or outside every droppable. The
// droppable is the wrapper around the header, so the wrapper gets the box.
const HEADER_BOX = { top: 200, bottom: 232, left: 0, right: 240, width: 240, height: 32 };
const POINTER_ON_HEADER = { clientX: 40, clientY: 216 };
const POINTER_ON_HEADER_TOP_HALF = { clientX: 40, clientY: 205 };
const POINTER_OFF_EVERYTHING = { clientX: 40, clientY: 600 };

function boxHeaders(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const wrapsAlphaHeader = this.querySelector(`:scope > [data-testid="project-row-${ALPHA.id}"]`) !== null;
    const box = wrapsAlphaHeader ? HEADER_BOX : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    return { ...box, x: box.left, y: box.top, toJSON: () => box } as DOMRect;
  });
}

const PRIMARY = { button: 0, isPrimary: true, pointerId: 1 };

type Point = { clientX: number; clientY: number };

async function renderSidebar(): Promise<void> {
  render(<ProjectSidebar />);
  // A row can be dragged only once its background-command list has loaded, so let the loads that rendering began land.
  await act(async () => {});
}

async function pressAndMove(target: HTMLElement, to: Point): Promise<void> {
  await act(async () => { fireEvent.pointerDown(target, { ...PRIMARY, clientX: 10, clientY: 10 }); });
  await movePointer({ clientX: 10, clientY: 40 });
  await movePointer(to);
}

async function movePointer(to: Point): Promise<void> {
  await act(async () => { fireEvent.pointerMove(document, { ...PRIMARY, ...to }); });
}

async function release(at: Point): Promise<void> {
  await act(async () => { fireEvent.pointerUp(document, { ...PRIMARY, ...at }); });
}

const dragging = () => document.body.style.cursor === "grabbing";

describe("SidebarList thread drag", () => {
  beforeEach(() => {
    useSidebarUiStore.setState({ view: "projects", scope: "active", expandedProjects: new Set([NO_PROJECT_GROUP_KEY, ALPHA.id, BETA.id]), showMore: new Set() });
    useThreadStore.setState({ runningThreadIds: new Set() });
    vi.mocked(mockTransport.moveThreadToProject).mockClear();
    vi.mocked(mockTransport.reorderWorkspace).mockClear();
    useBackgroundCommandStore.setState({ loads: new Map() });
    vi.mocked(mockTransport.listBackgroundCommands).mockReset().mockResolvedValue([]);
    boxHeaders();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    closeMoveThreadDialog();
    document.body.style.cursor = "";
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
    useThreadStore.setState({ runningThreadIds: new Set() });
    threadAttentionStore.setState({ byThreadId: {}, visitBaselines: {}, onScreenThreadId: null });
    useCompletionStore.setState({ entries: new Map(), hoveredThreadId: null, undoLineThreadId: null });
  });

  it("shows the move hint in place of the header's actions while the thread is over it, and hides it when it leaves", async () => {
    seed([LOOSE]);
    await renderSidebar();

    await pressAndMove(row("Loose thread"), POINTER_ON_HEADER);

    expect(within(header(ALPHA.id)).getByText("Move to project…")).toBeVisible();
    expect(within(header(ALPHA.id)).queryByTestId(`project-row-actions-${ALPHA.id}`)).toBeNull();
    expect(within(header(BETA.id)).queryByText("Move to project…")).toBeNull();

    await movePointer(POINTER_OFF_EVERYTHING);
    expect(within(header(ALPHA.id)).queryByText("Move to project…")).toBeNull();
    expect(within(header(ALPHA.id)).getByTestId(`project-row-actions-${ALPHA.id}`)).toBeInTheDocument();
  });

  it("opens the move dialog with the project under the pointer when the thread is dropped, and moves nothing", async () => {
    seed([LOOSE]);
    await renderSidebar();

    await pressAndMove(row("Loose thread"), POINTER_ON_HEADER);
    await release(POINTER_ON_HEADER);

    expect(useMoveThreadStore.getState()).toEqual({ threadId: LOOSE.id, projectId: ALPHA.id });
    expect(mockTransport.moveThreadToProject).not.toHaveBeenCalled();
    expect(dragging()).toBe(false);
  });

  it("does nothing when the thread is dropped outside every project header", async () => {
    seed([LOOSE]);
    await renderSidebar();

    await pressAndMove(row("Loose thread"), POINTER_OFF_EVERYTHING);
    await release(POINTER_OFF_EVERYTHING);

    expect(useMoveThreadStore.getState().threadId).toBeNull();
    expect(mockTransport.reorderWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    ["the No project header", { current: undefined }],
    ["a thread row", { current: { type: "thread", threadId: IN_ALPHA.id } }],
  ] as const)("does nothing when a thread is dropped on %s, which is not a target", async (_name, overData) => {
    seed([LOOSE, IN_ALPHA]);
    await renderSidebar();
    const event = {
      active: { id: `thread:${LOOSE.id}`, data: { current: { type: "thread", threadId: LOOSE.id } } },
      over: { id: "not-a-project", data: overData, rect: { top: 0, height: 32 } },
      activatorEvent: new MouseEvent("pointerdown"),
      delta: { x: 0, y: 0 },
    } as unknown as DragEndEvent;

    act(() => dnd.onDragEnd?.(event));

    expect(useMoveThreadStore.getState().threadId).toBeNull();
    expect(mockTransport.reorderWorkspace).not.toHaveBeenCalled();
  });

  it("does not start a project reorder from a thread drag", async () => {
    seed([LOOSE]);
    await renderSidebar();

    await pressAndMove(row("Loose thread"), POINTER_ON_HEADER);
    await release(POINTER_ON_HEADER);

    expect(mockTransport.reorderWorkspace).not.toHaveBeenCalled();
  });

  it("reorders when a project is dropped on another, and never opens the move dialog", async () => {
    seed([LOOSE]);
    await renderSidebar();
    const projectData = (workspaceId: string) => ({ current: { type: "project", workspaceId } });
    const event = {
      active: { id: ALPHA.id, data: projectData(ALPHA.id) },
      over: { id: BETA.id, data: projectData(BETA.id), rect: { top: 0, height: 32 } },
      activatorEvent: new KeyboardEvent("keydown"),
      delta: { x: 0, y: 1 },
    } as unknown as DragEndEvent;

    act(() => dnd.onDragEnd?.(event));

    expect(mockTransport.reorderWorkspace).toHaveBeenCalledExactlyOnceWith(ALPHA.id, 1);
    expect(useMoveThreadStore.getState().threadId).toBeNull();
  });

  it("starts a project drag from a header, and a project dragged over another header does not offer a move", async () => {
    seed([LOOSE]);
    await renderSidebar();

    await pressAndMove(header(BETA.id), POINTER_ON_HEADER);

    expect(dragging()).toBe(true);
    expect(within(header(ALPHA.id)).queryByText("Move to project…")).toBeNull();
  });

  it.each([
    ["a project", { type: "project", workspaceId: BETA.id }, true],
    ["a thread", { type: "thread", threadId: LOOSE.id }, false],
  ] as const)("draws the reorder's insertion line over a header only for %s", async (_name, dragged, line) => {
    seed([LOOSE]);
    await renderSidebar();
    const event = {
      active: { id: "dragged", data: { current: dragged } },
      over: { id: ALPHA.id, data: { current: { type: "project", workspaceId: ALPHA.id } }, rect: { top: 0, height: 32 } },
      activatorEvent: new MouseEvent("pointermove"),
      delta: { x: 0, y: 1 },
    } as unknown as DragMoveEvent;

    act(() => dnd.onDragMove?.(event));

    expect(screen.queryByTestId("drop-indicator") !== null).toBe(line);
  });

  it("still reorders projects by dragging a header onto another", async () => {
    seed([LOOSE]);
    await renderSidebar();

    await pressAndMove(header(BETA.id), POINTER_ON_HEADER_TOP_HALF);
    await release(POINTER_ON_HEADER_TOP_HALF);

    expect(mockTransport.reorderWorkspace).toHaveBeenCalledExactlyOnceWith(BETA.id, 0);
    expect(useMoveThreadStore.getState().threadId).toBeNull();
  });

  it("accepts the drop on a project header in the Older section too", async () => {
    const stale = new Date(Date.now() - 60 * 86_400_000).toISOString();
    seed([LOOSE, thread({ id: "t-stale", title: "Stale alpha thread", workspace_id: ALPHA.id, last_activity_at: stale, created_at: stale, updated_at: stale })]);
    useSidebarUiStore.setState({ olderOpen: true });
    await renderSidebar();
    expect(screen.queryByText("Stale alpha thread")).not.toBeNull();

    await pressAndMove(row("Loose thread"), POINTER_ON_HEADER);
    expect(within(header(ALPHA.id)).getByText("Move to project…")).toBeVisible();
    await release(POINTER_ON_HEADER);

    expect(useMoveThreadStore.getState()).toEqual({ threadId: LOOSE.id, projectId: ALPHA.id });
  });

  it("starts a drag from an open No project thread", async () => {
    seed([LOOSE]);
    await renderSidebar();

    await pressAndMove(row("Loose thread"), POINTER_OFF_EVERYTHING);

    expect(dragging()).toBe(true);
  });

  it.each([
    ["a thread that is running", () => {
      seed([RUNNING]);
      useThreadStore.setState({ runningThreadIds: new Set([RUNNING.id]) });
    }, "Running thread"],
    ["a thread with work running in the background", () => {
      seed([RUNNING]);
      act(() => threadAttentionStore.getState().apply(createMockThreadAttention({ threadId: RUNNING.id, descendants: "running" })));
    }, "Running thread"],
    ["a thread that already lives in a project", () => seed([IN_ALPHA]), "Alpha thread"],
  ] as const)("does not start a drag from %s", async (_name, arrange, title) => {
    arrange();
    await renderSidebar();

    await pressAndMove(row(title), POINTER_OFF_EVERYTHING);

    expect(dragging()).toBe(false);
  });

  describe("before the thread's background commands have loaded", () => {
    function holdCommandList(): (commands: BackgroundCommand[]) => Promise<void> {
      let answer: (commands: BackgroundCommand[]) => void = () => {};
      vi.mocked(mockTransport.listBackgroundCommands).mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
      return (commands) => act(async () => answer(commands));
    }

    it("does not start a drag, and starts one once the list loads with nothing running", async () => {
      const load = holdCommandList();
      seed([LOOSE]);
      await renderSidebar();

      await pressAndMove(row("Loose thread"), POINTER_OFF_EVERYTHING);
      expect(dragging()).toBe(false);

      await load([]);
      await pressAndMove(row("Loose thread"), POINTER_OFF_EVERYTHING);
      expect(dragging()).toBe(true);
    });

    it("keeps blocking the drag when the list loads with a command still running", async () => {
      const load = holdCommandList();
      seed([LOOSE]);
      await renderSidebar();
      await pressAndMove(row("Loose thread"), POINTER_OFF_EVERYTHING);
      expect(dragging()).toBe(false);
      await release(POINTER_OFF_EVERYTHING);

      await load([createMockBackgroundCommand({ toolCallId: "sleep", status: "running", awaited: false })]);
      await pressAndMove(row("Loose thread"), POINTER_OFF_EVERYTHING);

      expect(dragging()).toBe(false);
    });
  });

  it("does not start a drag from a row that is being closed", async () => {
    seed([LOOSE]);
    useCompletionStore.setState({ entries: new Map([[LOOSE.id, { phase: "holding", attempt: 1 }]]) });
    await renderSidebar();

    await pressAndMove(row("Loose thread"), POINTER_OFF_EVERYTHING);

    expect(dragging()).toBe(false);
  });

  it("does not start a drag from the title field while the thread is being renamed", async () => {
    seed([LOOSE]);
    await renderSidebar();
    fireEvent.doubleClick(row("Loose thread"));
    const field = await screen.findByRole("textbox");

    await pressAndMove(field, POINTER_OFF_EVERYTHING);

    expect(dragging()).toBe(false);
  });

  it("does not start a drag from a closed row", async () => {
    seed([{ ...LOOSE, user_completed_at: "2026-11-20T10:00:00.000Z" }]);
    useSidebarUiStore.setState({ scope: "completed" });
    await renderSidebar();

    await pressAndMove(row("Loose thread"), POINTER_OFF_EVERYTHING);

    expect(dragging()).toBe(false);
  });

  it("does not start a drag from a row in the Threads view, which has no project headers to drop on", async () => {
    seed([LOOSE]);
    useSidebarUiStore.setState({ view: "threads" });
    await renderSidebar();

    await pressAndMove(screen.getByRole("button", { name: /No project.*Loose thread/ }), POINTER_OFF_EVERYTHING);

    expect(dragging()).toBe(false);
  });
});
