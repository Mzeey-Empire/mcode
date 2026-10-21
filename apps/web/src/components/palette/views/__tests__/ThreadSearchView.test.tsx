import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "@/components/ui/command";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useUiStore } from "@/stores/uiStore";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import type { ThreadStartup } from "@mcode/contracts";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
import { createMockThread, createMockWorkspace } from "@/__tests__/mocks/transport";
import type { RecentThread } from "@/transport/types";

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

vi.mock("@/stores/recentThreadsStore", () => ({
  useRecentThreadsStore: (selector: (state: unknown) => unknown) =>
    selector({ threads: [], loading: false, fetch: vi.fn() }),
}));

vi.mock("@/stores/sidebarSearchStore", () => ({
  useSidebarSearchStore: (selector: (state: unknown) => unknown) =>
    selector({
      serverResults: [thread],
      serverWorkspaces: [workspace],
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
      workspaces: [workspace],
      threads: [thread],
      checksById: {},
      pendingStartupByThreadId: {},
      setActiveWorkspace: hoisted.setActiveWorkspace,
      setActiveThread: hoisted.setActiveThread,
    }),
}));

import { filterAndSortRecentThreads, ThreadSearchView } from "../ThreadSearchView";

function setupStartup(threadId: string, setup: ThreadStartup["steps"][number]["state"], block?: ThreadStartup["block"]): ThreadStartup {
  return {
    startupId: `startup-${threadId}`,
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
  act(() => {
    useUiStore.setState({
      projectThreadViews: { "another-project": "active" },
    });
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

  it("shows the sidebar lane marker for the thread's row state", () => {
    act(() => {
      threadAttentionStore.setState({ byThreadId: { [thread.id]: {
        threadId: thread.id,
        waiting: { kind: "approval", since: "2026-10-10T10:00:00.000Z" },
        lastTurn: { outcome: "errored", endedAt: "2026-10-10T10:00:00.000Z", sequence: 4, changedFileCount: null },
        seen: { sequence: null, at: null },
        hasUnfinishedDelegatedTasks: false,
      } } });
    });
    const { rerender } = render(<Command shouldFilter={false}><ThreadSearchView /></Command>);
    expect(screen.getByRole("img", { name: "Approval required" })).toHaveAttribute("data-status-mark", "attention");

    act(() => {
      threadAttentionStore.setState((state) => ({ byThreadId: { [thread.id]: { ...state.byThreadId[thread.id]!, waiting: null } } }));
    });
    rerender(<Command shouldFilter={false}><ThreadSearchView /></Command>);
    expect(screen.getByRole("img", { name: "Failed" })).toHaveAttribute("data-status-mark", "error");
    expect(screen.queryByText("Errored")).not.toBeInTheDocument();
  });

  it("shows Setup failed from the thread's startup record", () => {
    act(() => {
      const startup = setupStartup(thread.id, "failed", SETUP_FAILED_BLOCK);
      useThreadStartupStore.setState({ recordsByStartupId: { [startup.startupId]: startup }, startupIdByThreadId: { [thread.id]: startup.startupId } });
    });
    render(<Command shouldFilter={false}><ThreadSearchView /></Command>);

    expect(screen.getByRole("img", { name: "Setup failed" })).toHaveAttribute("data-status-mark", "attention");
  });

  it("opens the selected thread inside its project", () => {
    render(
      <Command shouldFilter={false}>
        <ThreadSearchView />
      </Command>,
    );

    fireEvent.click(screen.getByTestId("thread-search-result-thread-search"));

    expect(hoisted.setActiveWorkspace).toHaveBeenCalledWith("ws-search");
    expect(hoisted.setActiveThread).toHaveBeenCalledWith("thread-search");
    expect(useUiStore.getState().projectThreadViews).toEqual({
      "another-project": "active",
      "ws-search": "completed",
    });
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
