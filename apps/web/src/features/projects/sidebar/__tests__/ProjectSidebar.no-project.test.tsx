import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DndContextProps, DragEndEvent } from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@/transport/types";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

// jsdom has no layout, so a real drag cannot run; the list's own drop handler is what the reorder tests call.
const dnd = vi.hoisted(() => ({ onDragEnd: undefined as DndContextProps["onDragEnd"] }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: DndContextProps) => {
      dnd.onDragEnd = props.onDragEnd;
      return <actual.DndContext {...props} />;
    },
  };
});

vi.mock("@/components/ui/virtual-viewport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/virtual-viewport")>()),
  VirtualViewport: (await import("./fake-virtual-viewport")).FakeVirtualViewport,
}));

import { useWorkspaceStore } from "../../state/workspaceStore";
import { useSidebarUiStore } from "../sidebar-ui-store";
import { NO_PROJECT_GROUP_KEY } from "../sidebar-model";
import { ProjectSidebar } from "../ProjectSidebar";

const PROJECT = createMockWorkspace({ id: "ws-project", name: "Alpha", path: "/alpha" });
const HIDDEN = createMockWorkspace({ id: "ws-hidden", name: "No project", path: "/home/.mcode/no-project/a", kind: "no_project", is_git_repo: false });

function thread(overrides: Partial<Thread>): Thread {
  return createMockThread({ workspace_id: HIDDEN.id, last_activity_at: new Date().toISOString(), ...overrides });
}

function seed(workspaces = [PROJECT, HIDDEN], threads: Thread[] = []): void {
  useWorkspaceStore.setState({
    workspaces,
    threads,
    activeWorkspaceId: null,
    activeThreadId: null,
    loadWorkspaces: vi.fn().mockResolvedValue(undefined),
  });
}

function header(): HTMLElement {
  return screen.getByRole("group", { name: /^No project, \d+ threads?$/ });
}

describe("ProjectSidebar No project group", () => {
  beforeEach(() => {
    useSidebarUiStore.setState({ view: "projects", scope: "active", expandedProjects: new Set([NO_PROJECT_GROUP_KEY, PROJECT.id]), showMore: new Set() });
  });

  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
    localStorage.clear();
  });

  it("shows the group above the projects, holding the No project threads of every hidden workspace", () => {
    const second = createMockWorkspace({ id: "ws-hidden-2", name: "No project", kind: "no_project", is_git_repo: false });
    seed([PROJECT, HIDDEN, second], [
      thread({ id: "t-1", title: "Sketch a schema" }),
      thread({ id: "t-2", title: "Trip notes", workspace_id: second.id }),
      thread({ id: "t-3", title: "Project work", workspace_id: PROJECT.id }),
    ]);

    render(<ProjectSidebar />);

    const projectRow = screen.getByTestId("project-row-ws-project");
    const follows = (before: HTMLElement, after: HTMLElement) => Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(header(), screen.getByRole("button", { name: /^Sketch a schema/ }))).toBe(true);
    expect(follows(screen.getByRole("button", { name: /^Sketch a schema/ }), screen.getByRole("button", { name: /^Trip notes/ }))).toBe(true);
    expect(follows(screen.getByRole("button", { name: /^Trip notes/ }), projectRow)).toBe(true);
    expect(follows(projectRow, screen.getByRole("button", { name: /^Project work/ }))).toBe(true);
  });

  it("renders no group when no No project thread is in scope", () => {
    seed([PROJECT, HIDDEN], [thread({ id: "t-closed", title: "Done", user_completed_at: "2026-11-01T00:00:00.000Z" }), thread({ id: "t-p", title: "Project work", workspace_id: PROJECT.id })]);

    render(<ProjectSidebar />);

    expect(screen.queryByTestId("no-project-row")).toBeNull();
    expect(screen.getByTestId("project-row-ws-project")).toBeInTheDocument();
  });

  it("offers a plus that starts a thread without a project, and no options menu", () => {
    seed([PROJECT, HIDDEN], [thread({ id: "t-1", title: "Sketch a schema" })]);
    render(<ProjectSidebar />);

    expect(within(header()).queryByRole("button", { name: /options/i })).toBeNull();
    fireEvent.click(within(header()).getByRole("button", { name: "New thread without a project" }));

    expect(useWorkspaceStore.getState()).toMatchObject({ pendingNewThread: true, activeWorkspaceId: null, newThreadTarget: { kind: "no-project" } });
  });

  it("remembers whether the group is collapsed across a remount and a reload", () => {
    seed([PROJECT, HIDDEN], [thread({ id: "t-1", title: "Sketch a schema" })]);
    const { unmount } = render(<ProjectSidebar />);

    fireEvent.click(within(header()).getByRole("button", { name: "Toggle threads for No project" }));
    expect(screen.queryByRole("button", { name: /^Sketch a schema/ })).toBeNull();
    unmount();
    render(<ProjectSidebar />);

    expect(screen.queryByRole("button", { name: /^Sketch a schema/ })).toBeNull();
    expect(header()).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("mcode-sidebar-ui") ?? "{}").state.expandedProjects).not.toContain(NO_PROJECT_GROUP_KEY);
  });

  it("reaches closed No project threads from the scope switch with no projects", () => {
    seed([HIDDEN], [thread({ id: "t-closed", title: "Old sketch", user_completed_at: "2026-11-01T00:00:00.000Z" })]);
    render(<ProjectSidebar />);

    expect(screen.queryByRole("button", { name: /^Old sketch/ })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /^Closed/ }));

    expect(screen.getByRole("button", { name: /^Old sketch/ })).toBeInTheDocument();
  });

  it("keeps the add-project well off an open No project thread when there are no projects", () => {
    seed([HIDDEN], [thread({ id: "t-1", title: "Sketch a schema" })]);

    render(<ProjectSidebar />);

    expect(screen.queryByTestId("project-drop-well")).toBeNull();
    expect(screen.getByRole("button", { name: /^Sketch a schema/ })).toBeInTheDocument();
  });

  it("shows neither the switch nor a group with no projects and no threads", () => {
    seed([HIDDEN], []);

    render(<ProjectSidebar />);

    expect(screen.queryByRole("radiogroup", { name: "Thread scope" })).toBeNull();
    expect(screen.queryByTestId("no-project-row")).toBeNull();
    expect(screen.getByTestId("project-drop-well")).toBeInTheDocument();
  });
});

describe("ProjectSidebar project reorder with a No project row", () => {
  const BETA = createMockWorkspace({ id: "ws-beta", name: "Beta", path: "/beta" });
  const GAMMA = createMockWorkspace({ id: "ws-gamma", name: "Gamma", path: "/gamma" });

  beforeEach(() => {
    useSidebarUiStore.setState({ view: "projects", scope: "active", expandedProjects: new Set(), showMore: new Set() });
    vi.mocked(mockTransport.reorderWorkspace).mockClear();
  });

  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  function dropOnto(activeId: string, overId: string): void {
    const event = {
      active: { id: activeId },
      over: { id: overId, rect: { top: 0, height: 32 } },
      activatorEvent: new KeyboardEvent("keydown"),
      delta: { x: 0, y: 1 },
    } as unknown as DragEndEvent;
    act(() => dnd.onDragEnd?.(event));
  }

  it("sends the target's place among projects, so a hidden row before it does not shift the index", () => {
    seed([PROJECT, HIDDEN, BETA, GAMMA]);
    render(<ProjectSidebar />);

    dropOnto(PROJECT.id, BETA.id);

    expect(mockTransport.reorderWorkspace).toHaveBeenCalledExactlyOnceWith(PROJECT.id, 1);
    expect(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id)).toEqual([BETA.id, HIDDEN.id, PROJECT.id, GAMMA.id]);
  });

  it("sends the same index when the hidden row comes after both projects", () => {
    seed([PROJECT, BETA, HIDDEN]);
    render(<ProjectSidebar />);

    dropOnto(PROJECT.id, BETA.id);

    expect(mockTransport.reorderWorkspace).toHaveBeenCalledExactlyOnceWith(PROJECT.id, 1);
    expect(useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id)).toEqual([BETA.id, PROJECT.id, HIDDEN.id]);
  });
});
