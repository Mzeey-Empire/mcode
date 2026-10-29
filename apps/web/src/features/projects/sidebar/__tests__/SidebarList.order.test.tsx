import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@/transport/types";
import { pushEmitter } from "@/transport/ws-transport";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

vi.mock("@/components/ui/virtual-viewport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/virtual-viewport")>()),
  VirtualViewport: (await import("./fake-virtual-viewport")).FakeVirtualViewport,
}));

vi.mock("@/features/conversation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/conversation")>()),
  schedulePrefetch: vi.fn(),
  cancelPrefetch: vi.fn(),
  prefetchOnPointerDown: vi.fn(),
}));

// Every rendered thread row resolves its checkout label once, so counting calls per thread id
// counts row renders without reaching into React internals.
const checkoutLabelCalls = vi.hoisted(() => new Map<string, number>());
vi.mock("@/lib/checkout-label", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/checkout-label")>();
  return {
    ...actual,
    resolveThreadCheckoutLabel: (thread: Parameters<typeof actual.resolveThreadCheckoutLabel>[0]) => {
      const id = (thread as { id?: string } | null | undefined)?.id;
      if (id) checkoutLabelCalls.set(id, (checkoutLabelCalls.get(id) ?? 0) + 1);
      return actual.resolveThreadCheckoutLabel(thread);
    },
  };
});

import { useWorkspaceStore } from "../../state/workspaceStore";
import { useSidebarUiStore } from "../sidebar-ui-store";
import { useProjectTreeMenus } from "../../ProjectTree";
import { SidebarList } from "../SidebarList";
import { useSidebarModel } from "../use-sidebar-model";
import { PROJECT_ROW_CAP } from "../sidebar-model";
import { ProjectSidebar } from "../ProjectSidebar";
import { FakeVirtualViewport } from "./fake-virtual-viewport";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const WORKSPACE = createMockWorkspace({ id: "ws-1", name: "Alpha", path: "/alpha" });
const SECOND_WORKSPACE = createMockWorkspace({ id: "ws-2", name: "Beta", path: "/beta" });

function threadAt(id: string, minutesAgo: number, overrides: Partial<Thread> = {}): Thread {
  const at = new Date(NOW - minutesAgo * 60_000).toISOString();
  return createMockThread({ id, workspace_id: overrides.workspace_id ?? "ws-1", title: `Title ${id}`, provider: "claude", last_activity_at: at, created_at: at, updated_at: at, ...overrides });
}

function Harness() {
  const { model } = useSidebarModel();
  const { ctx, overlays } = useProjectTreeMenus();
  return (
    <>
      <SidebarList items={model.items} ctx={ctx} />
      {overlays}
    </>
  );
}

function renderedThreadIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-testid='thread-item']")].map((row) => row.dataset.threadId ?? "");
}

function seed(threads: Thread[], activeThreadId: string | null = null): void {
  useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads, activeWorkspaceId: "ws-1", activeThreadId });
}

describe("SidebarList order", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    checkoutLabelCalls.clear();
    useSidebarUiStore.setState({ view: "projects", scope: "active", expandedProjects: new Set(["ws-1"]), showMore: new Set() });
  });

  afterEach(() => {
    stopPushListeners();
    vi.useRealTimers();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  it("renders threads in activity order, newest first", () => {
    seed([threadAt("mid", 30), threadAt("new", 1), threadAt("old", 90)]);
    render(<Harness />);
    expect(renderedThreadIds()).toEqual(["new", "mid", "old"]);
  });

  it("reveals the rows past the cap through Show more", () => {
    const threads = Array.from({ length: PROJECT_ROW_CAP + 2 }, (_, index) => threadAt(`t${index}`, index + 1));
    seed(threads);
    render(<Harness />);
    expect(renderedThreadIds()).toHaveLength(PROJECT_ROW_CAP);

    fireEvent.click(screen.getByRole("button", { name: "Show more (2)" }));

    expect(renderedThreadIds()).toEqual(threads.map((thread) => thread.id));
  });

  it("renders the selected thread past the cap exactly once", () => {
    const threads = Array.from({ length: PROJECT_ROW_CAP + 2 }, (_, index) => threadAt(`t${index}`, index + 1));
    const selected = threads.at(-1)!.id;
    seed(threads, selected);
    render(<Harness />);
    expect(renderedThreadIds().filter((id) => id === selected)).toHaveLength(1);
  });

  it("opens a focused row on Enter and keeps focus on it", () => {
    const setActiveThread = vi.fn();
    seed([threadAt("first", 1), threadAt("second", 2)]);
    useWorkspaceStore.setState({ setActiveThread });
    render(<Harness />);
    const row = within(document.querySelector<HTMLElement>("[data-thread-id='second']")!).getByRole("button", { name: /^Provider, Claude Title second/ });

    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });

    expect(setActiveThread).toHaveBeenCalledWith("second");
    expect(document.activeElement).toBe(row);
  });

  it("re-renders only the row a thread.status push names", () => {
    seed([threadAt("first", 1, { status: "paused" }), threadAt("second", 2, { status: "paused" })]);
    render(<Harness />);
    startPushListeners();
    const before = new Map(checkoutLabelCalls);

    act(() => pushEmitter.emit("thread.status", { threadId: "second", status: "active" }));

    expect(checkoutLabelCalls.get("second")).toBeGreaterThan(before.get("second") ?? 0);
    expect(checkoutLabelCalls.get("first")).toBe(before.get("first"));
  });
});

describe("SidebarList Threads view", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    localStorage.clear();
    FakeVirtualViewport.published.length = 0;
    FakeVirtualViewport.flips.length = 0;
    useSidebarUiStore.setState({ view: "projects", scope: "active", expandedProjects: new Set(["ws-1", "ws-2"]), showMore: new Set() });
    useWorkspaceStore.setState({
      workspaces: [WORKSPACE, SECOND_WORKSPACE],
      threads: [threadAt("a-old", 50), threadAt("b-new", 1, { workspace_id: "ws-2" }), threadAt("a-new", 5), threadAt("b-old", 70, { workspace_id: "ws-2" })],
      activeWorkspaceId: "ws-1",
      activeThreadId: null,
      // The list under test is fed from the seeded store; a real load would replace it.
      loadWorkspaces: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  it("shows one flat list across projects in activity order without a FLIP", () => {
    render(<ProjectSidebar />);
    expect(renderedThreadIds()).toEqual(["a-new", "a-old", "b-new", "b-old"]);
    const flipsBefore = FakeVirtualViewport.flips.length;

    fireEvent.click(screen.getByRole("button", { name: "Show as one list" }));

    expect(renderedThreadIds()).toEqual(["b-new", "a-new", "a-old", "b-old"]);
    expect(screen.queryByTestId("project-row-ws-1")).toBeNull();
    expect(within(document.querySelector<HTMLElement>("[data-thread-id='b-new']")!).getByText("Beta")).toBeVisible();
    expect(FakeVirtualViewport.flips.slice(flipsBefore)).not.toContain(true);
  });

  it("keeps the Threads view across a remount from persisted state", async () => {
    const first = render(<ProjectSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Show as one list" }));
    first.unmount();
    const stored = localStorage.getItem("mcode-sidebar-ui");

    // A fresh window starts from defaults and reads only what was written to storage.
    useSidebarUiStore.setState({ view: "projects" });
    localStorage.setItem("mcode-sidebar-ui", stored ?? "");
    await act(() => useSidebarUiStore.persist.rehydrate());
    render(<ProjectSidebar />);

    expect(screen.getByRole("button", { name: "Group by project" })).toBeVisible();
    expect(renderedThreadIds()).toEqual(["b-new", "a-new", "a-old", "b-old"]);
  });
});

describe("SidebarList frozen order", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    FakeVirtualViewport.published.length = 0;
    FakeVirtualViewport.flips.length = 0;
    useSidebarUiStore.setState({ view: "projects", scope: "active", expandedProjects: new Set(["ws-1"]), showMore: new Set(), frozen: null });
    useWorkspaceStore.setState({
      workspaces: [WORKSPACE],
      threads: [threadAt("a", 1), threadAt("b", 5), threadAt("c", 10)],
      activeWorkspaceId: "ws-1",
      activeThreadId: null,
      loadWorkspaces: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    stopPushListeners();
    vi.useRealTimers();
    useSidebarUiStore.setState({ frozen: null });
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  function list(): HTMLElement {
    return screen.getByTestId("thread-list").parentElement!;
  }

  function flipWhenPublished(order: string[]): boolean | undefined {
    const keys = order.map((id) => `thread:${id}`);
    const index = FakeVirtualViewport.published.findIndex((ids) => ids.filter((id) => id.startsWith("thread:")).join() === keys.join());
    return index < 0 ? undefined : FakeVirtualViewport.flips[index];
  }

  it("holds the order under the pointer and slides the rows on leave", () => {
    render(<ProjectSidebar />);
    startPushListeners();
    fireEvent.pointerEnter(list());

    act(() => pushEmitter.emit("thread.activity", { threadId: "c", at: new Date(NOW).toISOString() }));
    expect(renderedThreadIds()).toEqual(["a", "b", "c"]);

    fireEvent.pointerLeave(list());

    expect(renderedThreadIds()).toEqual(["c", "a", "b"]);
    expect(flipWhenPublished(["c", "a", "b"])).toBe(true);
  });

  it("reorders a reconnect hydration without a FLIP", () => {
    render(<ProjectSidebar />);

    act(() => useWorkspaceStore.setState((state) => ({
      threads: state.threads.map((thread) => (thread.id === "c" ? { ...thread, last_activity_at: new Date(NOW).toISOString() } : thread)),
      threadSnapshotEpoch: state.threadSnapshotEpoch + 1,
    })));

    expect(renderedThreadIds()).toEqual(["c", "a", "b"]);
    expect(flipWhenPublished(["c", "a", "b"])).toBe(false);
  });
});
