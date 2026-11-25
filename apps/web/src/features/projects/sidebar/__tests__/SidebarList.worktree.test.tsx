import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread, WorktreeInfo } from "@/transport/types";

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

import { useWorkspaceStore } from "../../state/workspaceStore";
import { useSidebarUiStore } from "../sidebar-ui-store";
import { ProjectSidebar } from "../ProjectSidebar";

const WORKSPACE = createMockWorkspace({ id: "ws-1", name: "Alpha", path: "/alpha" });

function recentWorktreeThread(id: string): Thread {
  const at = new Date().toISOString();
  return createMockThread({
    id, workspace_id: "ws-1", title: `Title ${id}`, mode: "worktree", worktree_path: `/alpha-worktrees/${id}`,
    created_at: at, updated_at: at, last_activity_at: at,
  });
}

function listed(...threads: Thread[]): WorktreeInfo[] {
  return threads.map((thread) => ({ name: thread.id, path: thread.worktree_path!, branch: thread.id, managed: true }));
}

function row(threadId: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-thread-id='${threadId}']`)!;
}

async function settle(): Promise<void> {
  await act(async () => {});
}

const EXISTING = recentWorktreeThread("existing");
const ARRIVED = recentWorktreeThread("arrived");

describe("SidebarList worktree presence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(mockTransport.listWorktrees).mockReset();
    useSidebarUiStore.setState({ view: "projects", scope: "active", expandedProjects: new Set(["ws-1"]), showMore: new Set() });
    useWorkspaceStore.setState({
      workspaces: [WORKSPACE],
      threads: [EXISTING],
      activeWorkspaceId: "ws-1",
      activeThreadId: null,
      loadWorkspaces: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    cleanup();
    useWorkspaceStore.getState().setActiveWorkspace(null);
    useWorkspaceStore.setState({ workspaces: [], threads: [] });
    vi.useRealTimers();
  });

  it("does not mark a worktree thread that arrives after the list loaded as unavailable", async () => {
    vi.mocked(mockTransport.listWorktrees).mockResolvedValueOnce(listed(EXISTING)).mockResolvedValue(listed(EXISTING, ARRIVED));
    render(<ProjectSidebar />);
    await settle();

    act(() => useWorkspaceStore.setState((state) => ({ threads: [ARRIVED, ...state.threads] })));
    await settle();

    expect(mockTransport.listWorktrees).toHaveBeenCalledTimes(2);
    expect(within(row("arrived")).queryByText("Worktree unavailable")).not.toBeInTheDocument();
    expect(within(row("existing")).queryByText("Worktree unavailable")).not.toBeInTheDocument();
  });

  it("marks a newly arrived worktree thread when the fresh listing leaves it out", async () => {
    vi.mocked(mockTransport.listWorktrees).mockResolvedValue(listed(EXISTING));
    render(<ProjectSidebar />);
    await settle();

    act(() => useWorkspaceStore.setState((state) => ({ threads: [ARRIVED, ...state.threads] })));
    await settle();

    expect(mockTransport.listWorktrees).toHaveBeenCalledTimes(2);
    expect(within(row("arrived")).getByText("Worktree unavailable")).toBeInTheDocument();
  });

  it("marks a worktree thread whose directory git no longer lists", async () => {
    vi.mocked(mockTransport.listWorktrees).mockResolvedValue([]);
    render(<ProjectSidebar />);
    await settle();

    expect(within(row("existing")).getByText("Worktree unavailable")).toBeInTheDocument();
  });

  it("leaves worktree threads unmarked when the listing fails", async () => {
    vi.mocked(mockTransport.listWorktrees).mockRejectedValue(new Error("git timed out after 10000ms"));
    render(<ProjectSidebar />);
    await settle();

    expect(screen.queryByText("Worktree unavailable")).not.toBeInTheDocument();
  });

  it("asks git again after a failed listing and marks a worktree the retry no longer finds", async () => {
    vi.mocked(mockTransport.listWorktrees).mockRejectedValueOnce(new Error("git timed out after 10000ms")).mockResolvedValue([]);
    render(<ProjectSidebar />);
    await settle();
    expect(screen.queryByText("Worktree unavailable")).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(mockTransport.listWorktrees).toHaveBeenCalledTimes(2);
    expect(within(row("existing")).getByText("Worktree unavailable")).toBeInTheDocument();
  });
});
