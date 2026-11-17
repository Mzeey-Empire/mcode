import { createMockThread, createMockThreadPullRequest, createMockWorkspace } from "@mcode/contracts/testing";
import type { ThreadAttention } from "@mcode/contracts/models/thread-attention";
import { mockTransport } from "@/__tests__/mocks/transport";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
import { useSidebarUiStore } from "../sidebar-ui-store";
import { useProjectTreeMenus } from "../../ProjectTree";
import { SidebarList } from "../SidebarList";
import { useSidebarModel } from "../use-sidebar-model";
import { PREVIEW_SCROLL_SETTLE_MS } from "../preview-scroll-guard";
import { FakeVirtualViewport } from "./fake-virtual-viewport";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { useThreadStore } from "@/stores/threadStore";

const WORKSPACE = createMockWorkspace({ id: "ws-1", name: "Alpha", path: "/alpha" });
const PR_URL = (number: number) => `https://github.com/acme/app/pull/${number}`;

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

function renderThread(overrides: Partial<Thread> = {}): HTMLElement {
  const thread = createMockThread({ id: "t1", workspace_id: "ws-1", title: "Row title", provider: "claude", mode: "worktree", last_activity_at: new Date().toISOString(), ...overrides });
  useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [thread], activeWorkspaceId: "ws-1", activeThreadId: null });
  render(<Harness />);
  return screen.getByRole("button", { name: /^Provider, Claude Row title/ });
}

function finished(threadId: string): ThreadAttention {
  return {
    threadId,
    waiting: null,
    lastTurn: { outcome: "completed", endedAt: "2026-10-27T11:00:00.000Z", sequence: 3, changedFileCount: null },
    seen: { sequence: null, at: null },
    hasUnfinishedDelegatedTasks: false,
  };
}

describe("SidebarThreadRow", () => {
  const openExternalUrl = vi.fn();
  const resolveNavigation = vi.fn(() => new Promise<never>(() => {}));

  beforeEach(() => {
    vi.useFakeTimers();
    useSidebarUiStore.setState({ view: "projects", scope: "active", expandedProjects: new Set(["ws-1"]), showMore: new Set() });
    Object.assign(window, { desktopBridge: { openExternalUrl, preview: { resolveNavigation } } });
  });

  afterEach(() => {
    // Testing Library's automatic cleanup runs after this hook, too late to stop mounted rows ticking.
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    Reflect.deleteProperty(window, "desktopBridge");
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  it("swaps the status label for the row actions on hover", () => {
    act(() => threadAttentionStore.getState().apply(finished("t1")));
    const row = renderThread();
    const label = within(screen.getByTestId("thread-status")).getByText("Finished");
    const complete = screen.getByRole("button", { name: "Close Row title" });
    expect(label).toBeVisible();
    expect(complete).not.toBeVisible();

    fireEvent.mouseEnter(row);
    expect(label).not.toBeVisible();
    expect(complete).toBeVisible();

    fireEvent.mouseLeave(row);
    expect(label).toBeVisible();
    expect(complete).not.toBeVisible();
  });

  describe("flat Threads row", () => {
    function renderFlat(overrides: Partial<Thread> = {}): HTMLElement {
      useSidebarUiStore.setState({ view: "threads" });
      const thread = createMockThread({ id: "t1", workspace_id: "ws-1", title: "Row title", provider: "claude", mode: "worktree", last_activity_at: new Date().toISOString(), ...overrides });
      useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [thread], activeWorkspaceId: "ws-1", activeThreadId: null });
      render(<Harness />);
      return screen.getByRole("button", { name: /^Alpha / });
    }

    function waiting(threadId: string): ThreadAttention {
      return { ...finished(threadId), waiting: { kind: "approval", since: "2026-10-27T11:00:00.000Z" } };
    }

    afterEach(() => {
      useThreadStore.setState({ runningThreadIds: new Set() });
      act(() => threadAttentionStore.getState().apply({ ...finished("t1"), lastTurn: null }));
    });

    it("reads project, title, then branch with the provider mark last", () => {
      const row = renderFlat({ branch: "feat/rows" });
      const lines = within(row).getAllByTestId(/^thread-line-/).map((line) => line.dataset.testid);
      expect(lines).toEqual(["thread-line-project", "thread-line-title", "thread-line-branch"]);
      const branchLine = within(row).getByTestId("thread-line-branch");
      const provider = within(branchLine).getByLabelText("Provider, Claude");
      expect(branchLine.lastElementChild?.contains(provider)).toBe(true);
    });

    it("shows the relative time in the corner of a quiet row", () => {
      renderFlat();
      expect(screen.getByTestId("thread-status")).toHaveTextContent(/^now$/);
    });

    it("shows an unseen outcome over the time", () => {
      act(() => threadAttentionStore.getState().apply(finished("t1")));
      renderFlat();
      expect(screen.getByTestId("thread-status")).toHaveTextContent(/^Finished$/);
    });

    it("shows Running over an unseen outcome, without an elapsed clock", () => {
      act(() => threadAttentionStore.getState().apply(finished("t1")));
      useThreadStore.setState({ runningThreadIds: new Set(["t1"]) });
      renderFlat();
      expect(screen.getByTestId("thread-status")).toHaveTextContent(/^Running$/);
    });

    it("shows what needs the user over Running", () => {
      act(() => threadAttentionStore.getState().apply(waiting("t1")));
      useThreadStore.setState({ runningThreadIds: new Set(["t1"]) });
      renderFlat();
      expect(screen.getByTestId("thread-status")).toHaveTextContent(/^Approval required$/);
    });

    it("swaps the corner for Close on hover and keyboard focus", () => {
      act(() => threadAttentionStore.getState().apply(finished("t1")));
      const row = renderFlat();
      const close = screen.getByRole("button", { name: "Close Row title" });
      expect(close).not.toBeVisible();

      fireEvent.mouseEnter(row);
      expect(close).toBeVisible();
      expect(close).toHaveTextContent("Close");
      expect(screen.getByTestId("thread-status")).not.toBeVisible();
      fireEvent.mouseLeave(row);

      act(() => row.focus());
      expect(close).toBeVisible();
    });

    it("offers no Close on a running row and keeps its status", () => {
      useThreadStore.setState({ runningThreadIds: new Set(["t1"]) });
      const row = renderFlat();
      fireEvent.mouseEnter(row);
      expect(screen.queryByRole("button", { name: "Close Row title" })).toBeNull();
      expect(screen.getByTestId("thread-status")).toHaveTextContent("Running");
      expect(screen.getByTestId("thread-status")).toBeVisible();
    });

    it("offers no Close on a row waiting for approval and keeps its status", () => {
      act(() => threadAttentionStore.getState().apply(waiting("t1")));
      const row = renderFlat();
      fireEvent.mouseEnter(row);
      expect(screen.queryByRole("button", { name: "Close Row title" })).toBeNull();
      expect(screen.getByTestId("thread-status")).toHaveTextContent("Approval required");
      expect(screen.getByTestId("thread-status")).toBeVisible();
    });

    it("lets Escape on Close reach the document, so open menus and popups still dismiss", () => {
      const row = renderFlat();
      fireEvent.mouseEnter(row);
      const onDocumentKeyDown = vi.fn();
      document.addEventListener("keydown", onDocumentKeyDown);
      try {
        fireEvent.keyDown(screen.getByRole("button", { name: "Close Row title" }), { key: "Escape" });
      } finally {
        document.removeEventListener("keydown", onDocumentKeyDown);
      }
      expect(onDocumentKeyDown).toHaveBeenCalledOnce();
    });
  });

  it("keeps a closing row's open layout while it leaves the Open list", () => {
    useSidebarUiStore.setState({ view: "threads" });
    const thread = createMockThread({ id: "t1", workspace_id: "ws-1", title: "Row title", provider: "claude", mode: "worktree", branch: "feat/rows", last_activity_at: new Date().toISOString() });
    useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [thread], activeWorkspaceId: "ws-1", activeThreadId: null });
    // The motion layer keeps a closing row's last item listed while it folds away, so the list's
    // items stay frozen while the thread itself turns closed.
    function FrozenHarness() {
      const { model } = useSidebarModel();
      const [items] = useState(model.items);
      const { ctx } = useProjectTreeMenus();
      return <SidebarList items={items} ctx={ctx} />;
    }
    render(<FrozenHarness />);

    act(() => useWorkspaceStore.setState({ threads: [{ ...thread, user_completed_at: new Date().toISOString() }] }));

    expect(screen.getByTestId("thread-line-branch")).toBeInTheDocument();
  });

  it.each(["projects", "threads"] as const)("keeps a title's parenthetical ending whole in the %s view", (view) => {
    useSidebarUiStore.setState({ view });
    const thread = createMockThread({ id: "t1", workspace_id: "ws-1", title: "Fix login (continued)", last_activity_at: new Date().toISOString() });
    useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [thread], activeWorkspaceId: "ws-1", activeThreadId: null });
    render(<Harness />);
    expect(screen.getByTestId("thread-title-head")).toHaveTextContent(/^Fix login$/);
    expect(screen.getByTestId("thread-title-ending")).toHaveTextContent(/^\(continued\)$/);
  });

  describe("closed row", () => {
    const CLOSED_AT = "2026-10-27T11:00:00.000Z";

    function renderClosed(overrides: Partial<Thread> = {}, view: "threads" | "projects" = "threads"): HTMLElement {
      useSidebarUiStore.setState({ view, scope: "completed" });
      const thread = createMockThread({ id: "t1", workspace_id: "ws-1", title: "Row title", provider: "claude", last_activity_at: new Date().toISOString(), user_completed_at: CLOSED_AT, ...overrides });
      useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [thread], activeWorkspaceId: "ws-1", activeThreadId: null });
      render(<Harness />);
      return screen.getByRole("button", { name: /^Row title/ });
    }

    it("is one line with the title and no branch line", () => {
      const row = renderClosed();
      expect(within(row).getByTestId("thread-title")).toHaveTextContent("Row title");
      expect(within(row).queryByTestId("thread-line-branch")).toBeNull();
      expect(within(row).queryByLabelText(/^Provider,/)).toBeNull();
    });

    it("shows Restore on hover and on keyboard focus", () => {
      const row = renderClosed();
      const restore = screen.getByRole("button", { name: "Restore Row title" });
      expect(restore).not.toBeVisible();
      fireEvent.mouseEnter(row);
      expect(restore).toBeVisible();
      expect(restore).toHaveTextContent("Restore");
      fireEvent.mouseLeave(row);
      expect(restore).not.toBeVisible();
      act(() => row.focus());
      expect(restore).toBeVisible();
    });

    it("keeps Retry and the cleanup failure visible without hover", () => {
      renderClosed({ cleanup_state: "blocked", cleanup_reason: "Dirty worktree" }, "projects");
      expect(screen.getByRole("button", { name: "Retry cleanup for Row title" })).toBeVisible();
      expect(screen.getByText("Cleanup blocked")).toBeVisible();
    });

    it("keeps a closed title's parenthetical ending whole", () => {
      useSidebarUiStore.setState({ scope: "completed" });
      const thread = createMockThread({ id: "t1", workspace_id: "ws-1", title: "Fix login (continued)", last_activity_at: new Date().toISOString(), user_completed_at: CLOSED_AT });
      useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [thread], activeWorkspaceId: "ws-1", activeThreadId: null });
      render(<Harness />);
      expect(screen.getByTestId("thread-title-ending")).toHaveTextContent(/^\(continued\)$/);
    });
  });

  it("shows the top-ranked PR's icon and +2 for three PRs", () => {
    renderThread({
      pull_requests: [
        createMockThreadPullRequest({ number: 10, state: "merged", url: PR_URL(10) }),
        createMockThreadPullRequest({ number: 11, state: "open", url: PR_URL(11) }),
        createMockThreadPullRequest({ number: 12, state: "closed", url: PR_URL(12) }),
      ],
    });
    const chip = screen.getByRole("button", { name: "3 pull requests" });
    expect(chip).toHaveTextContent(/^\+2$/);
    expect(chip.querySelector("svg")).toHaveClass("text-success");
  });

  it("shows an unresolved PR's number with no state colour", () => {
    renderThread({ pull_requests: [createMockThreadPullRequest({ number: 7, state: "unresolved", url: null })] });
    const chip = screen.getByRole("button", { name: "PR #7, unresolved" });
    expect(chip).toHaveTextContent(/^7$/);
    expect(chip.querySelector("svg")?.getAttribute("class")).not.toMatch(/text-(success|pr-merged|error|muted)/);
  });

  it("expands the PR list from the chip without selecting the row", () => {
    const setActiveThread = vi.fn();
    useWorkspaceStore.setState({ setActiveThread });
    renderThread({
      pull_requests: [
        createMockThreadPullRequest({ number: 10, state: "merged", url: PR_URL(10), title: "Merged change" }),
        createMockThreadPullRequest({ number: 11, state: "open", url: PR_URL(11), title: "Open change" }),
      ],
    });
    expect(screen.queryByRole("list", { name: "Pull requests" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "2 pull requests" }));

    const list = screen.getByRole("list", { name: "Pull requests" });
    expect(within(list).getAllByRole("button").map((entry) => entry.getAttribute("aria-label"))).toEqual([
      "Open change, PR #11, open",
      "Merged change, PR #10, merged",
    ]);
    expect(screen.getByRole("button", { name: "2 pull requests" })).toHaveAttribute("aria-expanded", "true");
    expect(setActiveThread).not.toHaveBeenCalled();
  });

  it("opens a PR in the system browser on click and in the in-app browser on Ctrl+click", () => {
    const setActiveThread = vi.fn();
    useWorkspaceStore.setState({ setActiveThread });
    renderThread({ pull_requests: [createMockThreadPullRequest({ number: 42, state: "open", url: PR_URL(42) })] });
    const chip = screen.getByRole("button", { name: "PR #42, open" });

    fireEvent.click(chip);
    expect(openExternalUrl).toHaveBeenCalledWith(PR_URL(42));
    expect(resolveNavigation).not.toHaveBeenCalled();

    openExternalUrl.mockClear();
    fireEvent.click(chip, { ctrlKey: true });
    act(() => vi.runOnlyPendingTimers());
    expect(resolveNavigation).toHaveBeenCalledWith(PR_URL(42), expect.anything());
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(setActiveThread).not.toHaveBeenCalled();
  });

  describe("thread menu", () => {
    const menu = () => screen.queryByRole("menu");
    const optionsButton = (title = "Row title") => screen.getByRole("button", { name: `Thread options for ${title}` });
    const settle = () => act(() => vi.advanceTimersByTimeAsync(500));
    const clickOptions = async (button: HTMLElement) => {
      act(() => button.focus());
      fireEvent.click(button);
      await settle();
    };

    it("closes the options menu on Escape pressed where the click left focus", async () => {
      renderThread();
      await clickOptions(optionsButton());
      expect(menu()).not.toBeNull();

      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await settle();
      expect(menu()).toBeNull();
    });

    it("closes the options menu on a second click of its button", async () => {
      renderThread();
      await clickOptions(optionsButton());
      expect(menu()).not.toBeNull();

      const button = optionsButton();
      fireEvent.pointerDown(button, { pointerType: "mouse" });
      fireEvent.mouseDown(button);
      fireEvent.pointerUp(button, { pointerType: "mouse" });
      fireEvent.mouseUp(button);
      fireEvent.click(button);
      await settle();
      expect(menu()).toBeNull();
    });

    it("moves focus onto a menu item on ArrowDown", async () => {
      renderThread();
      await clickOptions(optionsButton());

      fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowDown" });
      await settle();
      expect(document.activeElement?.getAttribute("role")).toMatch(/^menuitem/);
    });

    it("does not select the thread when its options button is clicked", async () => {
      renderThread();
      await clickOptions(optionsButton());
      expect(useWorkspaceStore.getState().activeThreadId).toBeNull();
    });

    it("closes the right-click menu when the list scrolls", async () => {
      const row = renderThread();
      fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });
      expect(menu()).not.toBeNull();

      const viewport = FakeVirtualViewport.latest?.viewport;
      if (!viewport) throw new Error("no viewport");
      fireEvent.scroll(viewport);
      await settle();
      expect(menu()).toBeNull();
    });

    it("keeps another thread's hover preview shut while a thread menu is open", async () => {
      const first = createMockThread({ id: "t1", workspace_id: "ws-1", title: "First", provider: "claude", mode: "worktree", last_activity_at: new Date().toISOString() });
      const second = createMockThread({ id: "t2", workspace_id: "ws-1", title: "Second", provider: "claude", mode: "worktree", last_activity_at: new Date().toISOString() });
      useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [first, second], activeWorkspaceId: "ws-1", activeThreadId: null });
      render(<Harness />);
      await clickOptions(optionsButton("First"));
      expect(menu()).not.toBeNull();

      const secondRow = screen.getByRole("button", { name: /^Provider, Claude Second/ });
      fireEvent.pointerOver(secondRow, { pointerType: "mouse" });
      fireEvent.mouseEnter(secondRow, { clientX: 40, clientY: 60 });
      fireEvent.mouseMove(secondRow, { clientX: 41, clientY: 60 });
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(screen.queryByTestId("thread-preview-t2")).toBeNull();
    });
  });

  describe("row preview while the list scrolls", () => {
    const preview = () => screen.queryByTestId("thread-preview-t1");
    const scroller = () => {
      const viewport = FakeVirtualViewport.latest?.viewport;
      if (!viewport) throw new Error("no viewport");
      return viewport;
    };
    const hoverOpen = async (row: HTMLElement) => {
      fireEvent.pointerOver(row, { pointerType: "mouse" });
      fireEvent.mouseEnter(row, { clientX: 40, clientY: 40 });
      fireEvent.mouseMove(row, { clientX: 41, clientY: 40 });
      await act(() => vi.advanceTimersByTimeAsync(1000));
    };

    it("closes a hover-opened preview when a scroll starts", async () => {
      const row = renderThread();
      await hoverOpen(row);
      expect(preview()).not.toBeNull();

      fireEvent.wheel(scroller());
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(preview()).toBeNull();
    });

    it("rejects hover opens until the list settles and the pointer moves", async () => {
      const row = renderThread();
      fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
      fireEvent.scroll(scroller());
      fireEvent.pointerOver(row, { pointerType: "mouse" });
      fireEvent.mouseEnter(row, { clientX: 40, clientY: 40 });
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(preview()).toBeNull();

      fireEvent.mouseLeave(row);
      fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
      await hoverOpen(row);
      expect(preview()).toBeNull();

      fireEvent.mouseLeave(row);
      await act(() => vi.advanceTimersByTimeAsync(PREVIEW_SCROLL_SETTLE_MS));
      fireEvent.pointerMove(window, { clientX: 40, clientY: 52 });
      await hoverOpen(row);
      expect(preview()).not.toBeNull();
    });

    it("moves an open preview to the next row after that row's hover commits, never showing the old row's details", async () => {
      const first = createMockThread({ id: "t1", workspace_id: "ws-1", title: "First", provider: "claude", mode: "worktree", last_activity_at: new Date().toISOString() });
      const second = createMockThread({ id: "t2", workspace_id: "ws-1", title: "Second", provider: "claude", mode: "worktree", last_activity_at: new Date().toISOString() });
      useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [first, second], activeWorkspaceId: "ws-1", activeThreadId: null });
      render(<Harness />);
      const row = (title: string) => screen.getByRole("button", { name: new RegExp(`^Provider, Claude ${title}`) });
      await hoverOpen(row("First"));
      expect(preview()).not.toBeNull();

      let duringEnter: { first: boolean; second: boolean } | undefined;
      act(() => {
        fireEvent.mouseLeave(row("First"));
        fireEvent.pointerOver(row("Second"), { pointerType: "mouse" });
        fireEvent.mouseEnter(row("Second"), { clientX: 40, clientY: 60 });
        duringEnter = { first: preview() !== null, second: screen.queryByTestId("thread-preview-t2") !== null };
      });
      expect(duringEnter).toEqual({ first: false, second: false });
      expect(screen.queryByTestId("thread-preview-t2")).not.toBeNull();
    });

    it("keeps an open preview on screen while its thread updates", async () => {
      const thread = createMockThread({ id: "t1", workspace_id: "ws-1", title: "Before", provider: "claude", mode: "worktree", last_activity_at: new Date().toISOString() });
      useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [thread], activeWorkspaceId: "ws-1", activeThreadId: null });
      render(<Harness />);
      await hoverOpen(screen.getByRole("button", { name: /^Provider, Claude Before/ }));
      expect(preview()).not.toBeNull();

      const removed: Node[] = [];
      const observer = new MutationObserver((records) => records.forEach((record) => removed.push(...record.removedNodes)));
      observer.observe(document.body, { childList: true, subtree: true });
      await act(async () => {
        useWorkspaceStore.setState({ threads: [{ ...thread, title: "After" }] });
        await vi.advanceTimersByTimeAsync(50);
      });
      observer.takeRecords().forEach((record) => removed.push(...record.removedNodes));
      observer.disconnect();

      expect(removed.some((node) => node instanceof Element && node.matches("[data-testid='thread-preview-t1']"))).toBe(false);
      expect(within(preview() ?? document.body).getByText("After")).toBeTruthy();
    });

    it("still opens a preview on keyboard focus during a scroll", async () => {
      const row = renderThread();
      fireEvent.scroll(scroller());
      act(() => row.focus());
      fireEvent.keyDown(row, { key: "Tab" });
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(preview()).not.toBeNull();
    });
  });
});
