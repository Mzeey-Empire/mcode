import { createMockThread, createMockThreadAttention, createMockWorkspace } from "@mcode/contracts/testing";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "@/components/ui/command";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useSidebarUiStore } from "@/features/projects/sidebar/sidebar-ui-store";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import type { ThreadStartup } from "@mcode/contracts/thread-startup";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";

import type { RecentThread, Thread } from "@/transport/types";

const hoisted = vi.hoisted(() => ({
  setActiveWorkspace: vi.fn(),
  setActiveThread: vi.fn(),
  setSearchQuery: vi.fn(),
  clearSearchQuery: vi.fn(),
}));

const workspace = createMockWorkspace({
  id: "ws-search",
  name: "Caravan",
  path: "C:/src/Caravan",
});

const thread = createMockThread({
  id: "thread-search",
  workspace_id: workspace.id,
  title: "Premium sidebar",
  provider: "codex",
  branch: "feature/sidebar",
  mode: "worktree",
  worktree_path: "C:/worktrees/quiet-lantern",
  updated_at: new Date().toISOString(),
  user_completed_at: "2026-08-12T08:00:00.000Z",
});

const noProjectWorkspace = createMockWorkspace({
  id: "ws-none",
  name: "No project",
  path: "C:/mcode/no-project/abc",
  kind: "no_project",
  is_git_repo: false,
});

const noProjectThread = createMockThread({
  id: "thread-none",
  workspace_id: noProjectWorkspace.id,
  title: "Sketch a schema",
  branch: "main",
  updated_at: new Date().toISOString(),
});

let searchResults: Thread[] = [thread];
let searchWorkspaces = [workspace];
let storeWorkspaces = [workspace];
let recentResults: RecentThread[] = [];

vi.mock("@/stores/recentThreadsStore", () => ({
  useRecentThreadsStore: (selector: (state: unknown) => unknown) =>
    selector({ threads: recentResults, loading: false, fetch: vi.fn() }),
}));

vi.mock("@/stores/sidebarSearchStore", () => ({
  useSidebarSearchStore: (selector: (state: unknown) => unknown) =>
    selector({
      serverResults: searchResults,
      serverWorkspaces: searchWorkspaces,
      isSearching: false,
      searchError: false,
      setQuery: hoisted.setSearchQuery,
      clearQuery: hoisted.clearSearchQuery,
      filters: { status: [], provider: [] },
      toggleFilter: vi.fn(),
      clearFilters: vi.fn(),
      sortField: "updated_at",
      sortDirection: "desc",
      setSortField: vi.fn(),
      toggleSortDirection: vi.fn(),
    }),
}));

vi.mock("@/features/projects/state/workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({
      workspaces: storeWorkspaces,
      threads: [thread],
      checksById: {},
      pendingStartupByThreadId: {},
      setActiveWorkspace: hoisted.setActiveWorkspace,
      setActiveThread: hoisted.setActiveThread,
    }),
}));

import { filterAndSortRecentThreads, ThreadSearchView } from "../ThreadSearchView";
import { statusGlyph } from "@/features/thread-attention/__tests__/status-glyph";

function setupStartup(threadId: string, setup: ThreadStartup["steps"][number]["state"], block?: ThreadStartup["block"]): ThreadStartup {
  return {
    startupId: `startup-${threadId}`,
    failureSeenAt: null,
    workspaceId: "ws-1",
    threadId,
    kind: "managed-worktree",
    state: setup === "running" ? "running" : "blocked",
    phase: "setup",
    steps: [
      { phase: "thread", state: "completed" },
      { phase: "worktree", state: "completed" },
      { phase: "setup", state: setup },
      { phase: "agent", state: "pending" },
    ],
    transcript: [],
    cancellation: "none",
    revision: setup === "running" ? 1 : 2,
    createdAt: "",
    updatedAt: "",
    ...(block ? { block } : {}),
  };
}

const SETUP_FAILED_BLOCK = { code: "SETUP_FAILED", message: "Setup failed", actions: ["retry", "continue"] } satisfies ThreadStartup["block"];

beforeAll(() => {
  if (typeof window.ResizeObserver === "undefined") {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  searchResults = [thread];
  searchWorkspaces = [workspace];
  storeWorkspaces = [workspace];
  recentResults = [];
  act(() => {
    useSidebarUiStore.setState({ scope: "active" });
    useCommandPaletteStore.getState().open({ intent: "threadSearch" });
    useCommandPaletteStore.getState().setQuery("quiet-lantern");
    threadAttentionStore.setState({ byThreadId: {}, onScreenThreadId: null });
    useThreadStartupStore.setState({ recordsByStartupId: {}, startupIdByThreadId: {}, dismissedStartupIds: new Set() });
  });
});

describe("ThreadSearchView", () => {
  it("shows a compact provider-free record with project, branch, and state", () => {
    render(
      <Command shouldFilter={false}>
        <ThreadSearchView />
      </Command>,
    );

    expect(screen.getByText("Premium sidebar")).toBeInTheDocument();
    expect(screen.getByText("Premium sidebar")).toHaveClass("line-through");
    expect(screen.getByText("Caravan")).toBeInTheDocument();
    expect(screen.getByText("feature/sidebar")).toBeInTheDocument();
    expect(screen.getByText("now")).toBeInTheDocument();
    expect(screen.queryByText("quiet-lantern")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Provider, codex")).not.toBeInTheDocument();
  });

  it("labels a No project result No project, with no branch, never Unknown project", () => {
    searchResults = [noProjectThread];
    searchWorkspaces = [noProjectWorkspace];
    storeWorkspaces = [workspace, noProjectWorkspace];

    render(<Command shouldFilter={false}><ThreadSearchView /></Command>);

    expect(screen.getByLabelText("Project, No project")).toBeInTheDocument();
    expect(screen.queryByText("Unknown project")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Branch,/)).not.toBeInTheDocument();
  });

  it("labels a recent No project thread No project, with no branch", () => {
    useCommandPaletteStore.getState().setQuery("");
    storeWorkspaces = [workspace, noProjectWorkspace];
    recentResults = [{ ...noProjectThread, status: "active", workspace_name: noProjectWorkspace.name, workspace_path: noProjectWorkspace.path }];

    render(<Command shouldFilter={false}><ThreadSearchView /></Command>);

    expect(screen.getByLabelText("Project, No project")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Branch,/)).not.toBeInTheDocument();
  });

  it("shows the sidebar lane marker for the thread's row state", () => {
    act(() => {
      threadAttentionStore.setState({ byThreadId: { [thread.id]: createMockThreadAttention({
        threadId: thread.id,
        waiting: { kind: "approval", since: "2026-10-10T10:00:00.000Z" },
        lastTurn: { outcome: "errored", endedAt: "2026-10-10T10:00:00.000Z", sequence: 4, changedFileCount: null },
      }) } });
    });
    const { rerender } = render(<Command shouldFilter={false}><ThreadSearchView /></Command>);
    expect(statusGlyph(screen.getByRole("img", { name: "Approval required" }))).toBe("shield-alert");

    act(() => {
      threadAttentionStore.setState((state) => ({ byThreadId: { [thread.id]: { ...state.byThreadId[thread.id]!, waiting: null } } }));
    });
    rerender(<Command shouldFilter={false}><ThreadSearchView /></Command>);
    expect(statusGlyph(screen.getByRole("img", { name: "Failed" }))).toBe("circle-alert");
    expect(screen.queryByText("Errored")).not.toBeInTheDocument();
  });

  it("shows Setup failed from the thread's startup record", () => {
    act(() => {
      const startup = setupStartup(thread.id, "failed", SETUP_FAILED_BLOCK);
      useThreadStartupStore.setState({ recordsByStartupId: { [startup.startupId]: startup }, startupIdByThreadId: { [thread.id]: startup.startupId } });
    });
    render(<Command shouldFilter={false}><ThreadSearchView /></Command>);

    expect(statusGlyph(screen.getByRole("img", { name: "Setup failed" }))).toBe("circle-alert");
  });

  it("opens the selected thread inside its project and switches the global scope to its lifecycle", () => {
    render(
      <Command shouldFilter={false}>
        <ThreadSearchView />
      </Command>,
    );

    fireEvent.click(screen.getByTestId("thread-search-result-thread-search"));

    expect(hoisted.setActiveWorkspace).toHaveBeenCalledWith("ws-search");
    expect(hoisted.setActiveThread).toHaveBeenCalledWith("thread-search");
    expect(useSidebarUiStore.getState().scope).toBe("completed");
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it("applies the active filters and sort order to recent threads", () => {
    const recentThreads: RecentThread[] = [
      {
        ...thread,
        id: "recent-zulu",
        title: "Zulu",
        status: "completed",
        workspace_name: "Caravan",
        workspace_path: "C:/src/Caravan",
      },
      {
        ...thread,
        id: "recent-alpha",
        title: "Alpha",
        status: "active",
        workspace_name: "Caravan",
        workspace_path: "C:/src/Caravan",
      },
      {
        ...thread,
        id: "recent-beta",
        title: "Beta",
        status: "active",
        workspace_name: "Caravan",
        workspace_path: "C:/src/Caravan",
      },
    ];

    const rows = filterAndSortRecentThreads(
      recentThreads,
      { status: ["active"], provider: [] },
      "title",
      "asc",
    );

    expect(rows.map((recentThread) => recentThread.title)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });
});
