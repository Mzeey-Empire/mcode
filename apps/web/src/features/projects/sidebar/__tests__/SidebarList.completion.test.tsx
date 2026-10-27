import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import type { ThreadCompletionResult } from "@mcode/contracts/ws/methods";
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@/transport/types";

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
import { useCompletionStore } from "../completion-store";
import { useSidebarUiStore } from "../sidebar-ui-store";
import { ProjectSidebar } from "../ProjectSidebar";
import { CLOSE_MS } from "../sidebar-motion";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const WORKSPACE = createMockWorkspace({ id: "ws-1", name: "Alpha", path: "/alpha" });

function threadAt(id: string, minutesAgo: number, overrides: Partial<Thread> = {}): Thread {
  const at = new Date(NOW - minutesAgo * 60_000).toISOString();
  return createMockThread({ id, workspace_id: "ws-1", title: `Title ${id}`, provider: "claude", last_activity_at: at, created_at: at, updated_at: at, ...overrides });
}

const TARGET = threadAt("target", 2);
const COMPLETED_TARGET: Thread = { ...TARGET, user_completed_at: new Date(NOW + 3000).toISOString() };

function replyAfter(ms: number, result: ThreadCompletionResult): Promise<ThreadCompletionResult> {
  return new Promise((resolve) => setTimeout(() => resolve(result), ms));
}

function renderedThreadIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-testid='thread-item']")].map((row) => row.dataset.threadId ?? "");
}

function targetRow(): HTMLElement {
  return within(document.querySelector<HTMLElement>("[data-thread-id='target']")!).getByRole("button", { name: /^Provider, Claude Title target/ });
}

function closingRow(): Element | null {
  return document.querySelector("[data-thread-id='target']")?.closest(".sidebar-row-closing") ?? null;
}

function completedCount(): string | null {
  const bar = screen.queryByTestId("sidebar-scope-bar");
  return bar ? within(bar).getByRole("radio", { name: /Completed/ }).textContent : null;
}

function renderSidebar(): void {
  render(<ProjectSidebar />);
}

describe("SidebarList completion", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.mocked(mockTransport.completeThread).mockReset();
    vi.mocked(mockTransport.reopenThread).mockReset().mockResolvedValue(TARGET);
    useSidebarUiStore.setState({ view: "projects", scope: "active", expandedProjects: new Set(["ws-1"]), showMore: new Set() });
    useCompletionStore.setState({ entries: new Map(), hoveredThreadId: null, undoLineThreadId: null });
    useWorkspaceStore.setState({
      workspaces: [WORKSPACE],
      threads: [threadAt("newer", 1), TARGET, threadAt("older", 3)],
      activeWorkspaceId: "ws-1",
      activeThreadId: null,
      loadWorkspaces: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  it("strikes the row in place on Complete", () => {
    vi.mocked(mockTransport.completeThread).mockReturnValue(replyAfter(3000, { ok: true, thread: COMPLETED_TARGET }));
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Complete Title target" }));

    expect(renderedThreadIds()).toEqual(["newer", "target", "older"]);
    expect(within(targetRow()).getByText("Title target")).toHaveClass("sidebar-strike");
    expect(mockTransport.completeThread).toHaveBeenCalledWith("target", 3000);
  });

  it("keeps the strike when the row remounts during the hold", () => {
    vi.mocked(mockTransport.completeThread).mockReturnValue(replyAfter(3000, { ok: true, thread: COMPLETED_TARGET }));
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Complete Title target" }));

    fireEvent.click(screen.getByTestId("project-row-ws-1"));
    expect(renderedThreadIds()).toEqual([]);
    fireEvent.click(screen.getByTestId("project-row-ws-1"));

    expect(within(targetRow()).getByText("Title target")).toHaveClass("sidebar-strike");
    expect(screen.getByRole("button", { name: "Undo completing Title target" })).toBeInTheDocument();
  });

  it("restores the row on Undo within the hold", async () => {
    vi.mocked(mockTransport.completeThread).mockReturnValue(replyAfter(3000, { ok: false, refusal: "cancelled" }));
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Complete Title target" }));

    await act(() => vi.advanceTimersByTimeAsync(2900));
    fireEvent.click(screen.getByRole("button", { name: "Undo completing Title target" }));
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(mockTransport.reopenThread).toHaveBeenCalledWith("target");
    expect(renderedThreadIds()).toEqual(["newer", "target", "older"]);
    expect(screen.getByRole("button", { name: "Complete Title target" })).toBeInTheDocument();
    expect(within(targetRow()).getByText("Title target")).not.toHaveClass("sidebar-strike");
  });

  it("moves the row out of Active and raises the count when the hold ends", async () => {
    vi.mocked(mockTransport.completeThread).mockReturnValue(replyAfter(3000, { ok: true, thread: COMPLETED_TARGET }));
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Complete Title target" }));
    expect(completedCount()).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(closingRow()).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(CLOSE_MS));

    expect(renderedThreadIds()).toEqual(["newer", "older"]);
    expect(completedCount()).toContain("1");
  });

  it("returns a refused row with the reason and Retry", async () => {
    vi.mocked(mockTransport.completeThread).mockReturnValue(replyAfter(3000, { ok: false, refusal: "running" }));
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Complete Title target" }));

    await act(() => vi.advanceTimersByTimeAsync(3000));

    expect(renderedThreadIds()).toEqual(["newer", "target", "older"]);
    expect(within(targetRow()).getByRole("status")).toHaveTextContent("The thread is running");
    vi.mocked(mockTransport.completeThread).mockReturnValue(replyAfter(3000, { ok: true, thread: COMPLETED_TARGET }));
    fireEvent.click(screen.getByRole("button", { name: "Retry completing Title target" }));
    expect(mockTransport.completeThread).toHaveBeenCalledTimes(2);
  });

  it("keeps a hovered row at hold end until the pointer leaves", async () => {
    vi.mocked(mockTransport.completeThread).mockReturnValue(replyAfter(3000, { ok: true, thread: COMPLETED_TARGET }));
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Complete Title target" }));
    fireEvent.mouseEnter(targetRow());

    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(renderedThreadIds()).toEqual(["newer", "target", "older"]);

    expect(closingRow()).toBeNull();

    fireEvent.mouseLeave(targetRow());
    expect(closingRow()).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(CLOSE_MS));
    expect(renderedThreadIds()).toEqual(["newer", "older"]);
  });

  it("opens Completed with the thread selected from the Undo line title", async () => {
    const setActiveThread = vi.fn((threadId: string | null) => useWorkspaceStore.setState({ activeThreadId: threadId }));
    useWorkspaceStore.setState({ setActiveThread });
    vi.mocked(mockTransport.completeThread).mockReturnValue(replyAfter(3000, { ok: true, thread: COMPLETED_TARGET }));
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Complete Title target" }));
    await act(() => vi.advanceTimersByTimeAsync(3000));

    fireEvent.click(within(screen.getByTestId("completion-undo-line")).getByRole("button", { name: "Title target" }));

    expect(useSidebarUiStore.getState().scope).toBe("completed");
    expect(setActiveThread).toHaveBeenCalledWith("target");
    expect(renderedThreadIds()).toEqual(["target"]);
    expect(screen.queryByTestId("completion-undo-line")).toBeNull();
  });
});
