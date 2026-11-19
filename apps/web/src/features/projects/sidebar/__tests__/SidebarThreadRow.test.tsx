import { createMockThread, createMockThreadAttention, createMockThreadPullRequest, createMockWorkspace } from "@mcode/contracts/testing";
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
import { SIDEBAR_STATUS_WORD_WIDTH } from "../sidebar-label-tooltip";
import { FakeVirtualViewport } from "./fake-virtual-viewport";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { useThreadStore } from "@/stores/threadStore";
import { useComposerDraftStore, type ComposerDraft } from "@/stores/composerDraftStore";
import { useThreadDraftStore, type ThreadDraft } from "@/stores/threadDraftStore";
import { useSidebarWidthStore } from "@/components/sidebar/sidebarWidthStore";
import { INTERACTION_MODES, ORCHESTRATION_MODES, PERMISSION_MODES } from "@mcode/contracts/models/enums";
import { statusGlyph } from "@/features/thread-attention/__tests__/status-glyph";

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
  return screen.getByRole("button", { name: /^(Draft )?Row title/ });
}

function finished(threadId: string): ThreadAttention {
  return createMockThreadAttention({
    threadId,
    lastTurn: { outcome: "completed", endedAt: "2026-10-27T11:00:00.000Z", sequence: 3, changedFileCount: null },
  });
}

// Width is module state that persists across tests; each test starts at the app's default.
const INITIAL_SIDEBAR_WIDTH = useSidebarWidthStore.getState().width;

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
    useSidebarWidthStore.setState({ width: INITIAL_SIDEBAR_WIDTH });
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  it("keeps the status icon and drops its label while the row actions show", () => {
    useSidebarWidthStore.setState({ width: SIDEBAR_STATUS_WORD_WIDTH });
    act(() => threadAttentionStore.getState().apply(finished("t1")));
    const row = renderThread();
    const status = () => screen.getByTestId("thread-status");
    const complete = screen.getByRole("button", { name: "Close Row title" });
    expect(within(status()).getByText("Finished")).toBeVisible();
    expect(complete).not.toBeVisible();

    fireEvent.mouseEnter(row);
    expect(within(status()).queryByText("Finished")).toBeNull();
    expect(within(status()).getByRole("img", { name: "Finished" })).toBeVisible();
    expect(complete).toBeVisible();
    expect(status().compareDocumentPosition(complete) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.mouseLeave(row);
    expect(within(status()).getByText("Finished")).toBeVisible();
    expect(complete).not.toBeVisible();
  });

  it.each(["projects", "threads"] as const)("shows a narrow %s row's Close as its icon, named Close", async (view) => {
    useSidebarWidthStore.setState({ width: 220 });
    useSidebarUiStore.setState({ view });
    useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [createMockThread({ id: "t1", workspace_id: "ws-1", title: "Row title" })], activeWorkspaceId: "ws-1", activeThreadId: null });
    render(<Harness />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: view === "threads" ? /^Alpha / : /^Row title/ }));
    const close = screen.getByRole("button", { name: "Close Row title" });
    expect(close).toBeVisible();
    expect(close).not.toHaveTextContent("Close");
    fireEvent.pointerOver(close, { pointerType: "mouse" });
    fireEvent.mouseEnter(close, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(close, { clientX: 11, clientY: 10 });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText("Close")).toBeTruthy();
  });

  it("keeps the word on Close at the default width", () => {
    const row = renderThread();
    fireEvent.mouseEnter(row);
    expect(screen.getByRole("button", { name: "Close Row title" })).toHaveTextContent("Close");
  });

  it("keeps the row's hover look while its options menu is open", async () => {
    const row = renderThread();
    vi.useRealTimers();
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole("button", { name: "Thread options for Row title" }));
    await screen.findByRole("menu");
    fireEvent.mouseLeave(row);
    expect(row).toHaveAttribute("data-menu-open");

    fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(row).not.toHaveAttribute("data-menu-open");
    // The menu needs real timers to open and close; the shared teardown expects fake ones.
    vi.useFakeTimers();
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

    it("hides the time while the row actions show", () => {
      const row = renderFlat();
      fireEvent.mouseEnter(row);
      expect(screen.getByTestId("thread-status")).toHaveTextContent(/^$/);
      expect(screen.getByRole("button", { name: "Close Row title" })).toBeVisible();
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

    it.each<[string, (attention: ThreadAttention) => ThreadAttention, boolean, string]>([
      ["Approval required", (a) => ({ ...a, waiting: { kind: "approval", since: a.lastTurn!.endedAt } }), false, "shield-alert"],
      ["Answers required", (a) => ({ ...a, waiting: { kind: "questions", since: a.lastTurn!.endedAt } }), false, "message-circle-question-mark"],
      ["Plan ready", (a) => ({ ...a, waiting: { kind: "plan", since: a.lastTurn!.endedAt } }), false, "list-checks"],
      ["Interrupted", (a) => ({ ...a, lastTurn: { ...a.lastTurn!, outcome: "interrupted" } }), false, "circle-pause"],
      ["Failed", (a) => ({ ...a, lastTurn: { ...a.lastTurn!, outcome: "errored" } }), false, "circle-alert"],
      ["Finished", (a) => a, false, "circle-check"],
      ["Running", (a) => ({ ...a, lastTurn: null }), true, "spinner"],
    ])("shows %s as its icon beside its label", (label, shape, running, icon) => {
      act(() => threadAttentionStore.getState().apply(shape(finished("t1"))));
      if (running) useThreadStore.setState({ runningThreadIds: new Set(["t1"]) });
      renderFlat();
      const status = screen.getByTestId("thread-status");
      const mark = within(status).getByRole("img", { name: label });
      expect(statusGlyph(mark)).toBe(icon);
      expect(within(status).getByText(label)).toBeInTheDocument();
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
      expect(screen.getByTestId("thread-status")).toHaveTextContent(/^$/);
      expect(within(screen.getByTestId("thread-status")).getByRole("img", { name: "Finished" })).toBeVisible();
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

  it("shows the top-ranked PR's icon and number, then +2 for the rest of three PRs", () => {
    renderThread({
      pull_requests: [
        createMockThreadPullRequest({ number: 10, state: "merged", url: PR_URL(10) }),
        createMockThreadPullRequest({ number: 11, state: "open", url: PR_URL(11) }),
        createMockThreadPullRequest({ number: 12, state: "closed", url: PR_URL(12) }),
      ],
    });
    const chip = screen.getByRole("button", { name: "3 pull requests" });
    expect(chip).toHaveTextContent(/^11\s*\+2$/);
    expect(chip.querySelector("svg")).toHaveClass("text-success");
  });

  it("shows one PR's number with no count", () => {
    renderThread({ pull_requests: [createMockThreadPullRequest({ number: 42, state: "open", url: PR_URL(42) })] });
    expect(screen.getByRole("button", { name: "PR #42, open" })).toHaveTextContent(/^42$/);
  });

  it("shows an unresolved PR's number with no state colour", () => {
    renderThread({ pull_requests: [createMockThreadPullRequest({ number: 7, state: "unresolved", url: null })] });
    const chip = screen.getByRole("button", { name: "PR #7, unresolved" });
    expect(chip).toHaveTextContent(/^7$/);
    expect(chip.querySelector("svg")?.getAttribute("class")).not.toMatch(/text-(success|pr-merged|error|muted)/);
  });

  describe("PR list", () => {
    const TWO_PRS = [
      createMockThreadPullRequest({ number: 10, state: "merged", url: PR_URL(10), title: "Merged change" }),
      createMockThreadPullRequest({ number: 11, state: "open", url: PR_URL(11), title: "Open change" }),
    ];
    const prList = () => screen.queryByRole("menu");
    const openList = () => {
      const list = prList();
      if (!list) throw new Error("PR list is not open");
      return list;
    };
    const hover = async (element: HTMLElement) => {
      fireEvent.pointerEnter(element, { pointerType: "mouse" });
      fireEvent.mouseEnter(element, { clientX: 200, clientY: 40 });
      fireEvent.mouseMove(element, { clientX: 201, clientY: 40 });
      await act(() => vi.advanceTimersByTimeAsync(1000));
    };

    it("lists every PR as a link when the pointer rests on the chip, without selecting the row", async () => {
      const setActiveThread = vi.fn();
      useWorkspaceStore.setState({ setActiveThread });
      renderThread({ pull_requests: TWO_PRS });
      expect(prList()).toBeNull();

      await hover(screen.getByRole("button", { name: "2 pull requests" }));

      const items = within(openList()).getAllByRole("menuitem");
      expect(items.map((item) => item.textContent)).toEqual(["#11Open change", "#10Merged change"]);
      expect(items.map((item) => item.getAttribute("href"))).toEqual([PR_URL(11), PR_URL(10)]);
      expect(setActiveThread).not.toHaveBeenCalled();
    });

    it("opens the card of the row the pointer rests on once the list closes", async () => {
      const now = new Date().toISOString();
      const first = createMockThread({ id: "t1", workspace_id: "ws-1", title: "First", provider: "claude", mode: "worktree", last_activity_at: now, pull_requests: TWO_PRS });
      const second = createMockThread({ id: "t2", workspace_id: "ws-1", title: "Second", provider: "claude", mode: "worktree", last_activity_at: now });
      useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [first, second], activeWorkspaceId: "ws-1", activeThreadId: null });
      render(<Harness />);
      const chip = screen.getByRole("button", { name: "2 pull requests" });
      await hover(chip);
      expect(prList()).not.toBeNull();

      const firstRow = screen.getByRole("button", { name: /^First/ });
      const secondRow = screen.getByRole("button", { name: /^Second/ });
      fireEvent.mouseLeave(chip, { clientX: 40, clientY: 60 });
      fireEvent.mouseLeave(firstRow, { clientX: 40, clientY: 60 });
      fireEvent.pointerOver(secondRow, { pointerType: "mouse" });
      fireEvent.mouseEnter(secondRow, { clientX: 40, clientY: 60 });
      fireEvent.mouseMove(secondRow, { clientX: 41, clientY: 60 });
      await act(() => vi.advanceTimersByTimeAsync(2000));

      expect(prList()).toBeNull();
      expect(screen.queryByTestId("thread-preview-t2")).not.toBeNull();

      fireEvent.mouseLeave(secondRow, { clientX: 40, clientY: 300 });
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(screen.queryByTestId("thread-preview-t2")).toBeNull();
    });

    it("opens the list from the keyboard and returns focus to the chip on Escape", async () => {
      renderThread({ pull_requests: TWO_PRS });
      const chip = screen.getByRole("button", { name: "2 pull requests" });
      expect(chip).toHaveAttribute("aria-haspopup", "menu");
      act(() => chip.focus());
      fireEvent.click(chip);
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(prList()).not.toBeNull();

      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(prList()).toBeNull();
      expect(chip).toHaveFocus();
    });

    it("reaches the chip from the row with Right Arrow, opens on Enter at the first PR, and returns on Escape", async () => {
      const row = renderThread({ pull_requests: TWO_PRS });
      const chip = screen.getByRole("button", { name: "2 pull requests" });
      act(() => row.focus());

      fireEvent.keyDown(row, { key: "ArrowRight" });
      expect(chip).toHaveFocus();

      fireEvent.keyDown(chip, { key: "Enter" });
      fireEvent.click(chip, { detail: 0 });
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(within(openList()).getAllByRole("menuitem")[0]).toHaveFocus();

      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(prList()).toBeNull();
      expect(chip).toHaveFocus();
    });

    it("opens a PR in the system browser on click and in the in-app browser on Ctrl+click", async () => {
      const setActiveThread = vi.fn();
      useWorkspaceStore.setState({ setActiveThread });
      renderThread({ pull_requests: [createMockThreadPullRequest({ number: 42, state: "open", url: PR_URL(42), title: "Only change" })] });
      const chip = screen.getByRole("button", { name: "PR #42, open" });
      await hover(chip);
      const link = within(openList()).getByRole("menuitem", { name: "#42Only change" });

      fireEvent.click(link);
      expect(openExternalUrl).toHaveBeenCalledWith(PR_URL(42));
      expect(resolveNavigation).not.toHaveBeenCalled();

      openExternalUrl.mockClear();
      await hover(chip);
      fireEvent.click(within(openList()).getByRole("menuitem", { name: "#42Only change" }), { ctrlKey: true });
      act(() => vi.runOnlyPendingTimers());
      expect(resolveNavigation).toHaveBeenCalledWith(PR_URL(42), expect.anything());
      expect(openExternalUrl).not.toHaveBeenCalled();
      expect(setActiveThread).not.toHaveBeenCalled();
    });

    describe("with one PR", () => {
      const ONE_PR = [createMockThreadPullRequest({ number: 42, state: "open", url: PR_URL(42), title: "Only change" })];
      const press = async (chip: HTMLElement, init: { ctrlKey?: boolean } = {}) => {
        fireEvent.pointerDown(chip, { pointerType: "mouse", button: 0 });
        fireEvent.mouseDown(chip, { button: 0, ...init });
        fireEvent.mouseUp(chip, { button: 0, ...init });
        fireEvent.click(chip, { button: 0, ...init });
        await act(() => vi.advanceTimersByTimeAsync(500));
      };

      it("opens the PR on click without showing the list or selecting the row", async () => {
        const setActiveThread = vi.fn();
        useWorkspaceStore.setState({ setActiveThread });
        renderThread({ pull_requests: ONE_PR });

        await press(screen.getByRole("button", { name: "PR #42, open" }));

        expect(openExternalUrl).toHaveBeenCalledWith(PR_URL(42));
        expect(prList()).toBeNull();
        expect(setActiveThread).not.toHaveBeenCalled();
      });

      it("still lists the PR on hover, and a click then opens it and closes the list", async () => {
        renderThread({ pull_requests: ONE_PR });
        const chip = screen.getByRole("button", { name: "PR #42, open" });
        await hover(chip);
        expect(within(openList()).getByRole("menuitem", { name: "#42Only change" })).toBeTruthy();

        await press(chip);

        expect(openExternalUrl).toHaveBeenCalledWith(PR_URL(42));
        expect(prList()).toBeNull();
      });

      it("keeps the list shut after a click that beats the hover delay, until the pointer leaves and returns", async () => {
        renderThread({ pull_requests: ONE_PR });
        const chip = screen.getByRole("button", { name: "PR #42, open" });
        fireEvent.pointerEnter(chip, { pointerType: "mouse" });
        fireEvent.mouseEnter(chip, { clientX: 200, clientY: 40 });
        fireEvent.mouseMove(chip, { clientX: 201, clientY: 40 });

        await press(chip);
        await act(() => vi.advanceTimersByTimeAsync(1000));
        expect(openExternalUrl).toHaveBeenCalledWith(PR_URL(42));
        expect(prList()).toBeNull();

        fireEvent.mouseLeave(chip, { clientX: 40, clientY: 300 });
        await act(() => vi.advanceTimersByTimeAsync(1000));
        await hover(chip);
        expect(prList()).not.toBeNull();
      });

      it("opens the PR from the keyboard instead of the list", async () => {
        renderThread({ pull_requests: ONE_PR });
        const chip = screen.getByRole("button", { name: "PR #42, open" });
        act(() => chip.focus());

        fireEvent.keyDown(chip, { key: "Enter" });
        fireEvent.click(chip, { detail: 0 });
        await act(() => vi.advanceTimersByTimeAsync(500));

        expect(openExternalUrl).toHaveBeenCalledWith(PR_URL(42));
        expect(prList()).toBeNull();
      });

      it("opens the PR in the in-app browser on Ctrl+click", async () => {
        renderThread({ pull_requests: ONE_PR });

        await press(screen.getByRole("button", { name: "PR #42, open" }), { ctrlKey: true });

        expect(resolveNavigation).toHaveBeenCalledWith(PR_URL(42), expect.anything());
        expect(openExternalUrl).not.toHaveBeenCalled();
        expect(prList()).toBeNull();
      });

      it("shows the list on click when the PR has no link to open", async () => {
        renderThread({ pull_requests: [createMockThreadPullRequest({ number: 7, state: "unresolved", url: null })] });

        await press(screen.getByRole("button", { name: "PR #7, unresolved" }));

        expect(prList()).not.toBeNull();
      });
    });

    it("shows the list on click when several PRs are linked", async () => {
      renderThread({ pull_requests: TWO_PRS });
      const chip = screen.getByRole("button", { name: "2 pull requests" });
      fireEvent.pointerDown(chip, { pointerType: "mouse", button: 0 });
      fireEvent.mouseDown(chip, { button: 0 });
      fireEvent.mouseUp(chip, { button: 0 });
      fireEvent.click(chip, { button: 0 });
      await act(() => vi.advanceTimersByTimeAsync(500));

      expect(within(openList()).getAllByRole("menuitem")).toHaveLength(2);
      expect(openExternalUrl).not.toHaveBeenCalled();
    });
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

      const secondRow = screen.getByRole("button", { name: /^Second/ });
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
      const row = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });
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
      await hoverOpen(screen.getByRole("button", { name: /^Before/ }));
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

  describe("drafts", () => {
    const composer = (overrides: Partial<ComposerDraft> = {}): ComposerDraft => ({ input: "", attachments: [], modelId: "m", provider: "claude", reasoning: "high", ...overrides });
    const ATTACHMENT = { id: "a1", name: "shot.png", mimeType: "image/png", sizeBytes: 10, previewUrl: "blob:x", filePath: "C:/tmp/shot.png" };

    function newThreadDraft(id: string, input: string): ThreadDraft {
      return {
        id,
        workspaceId: "ws-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        draft: composer({ input }),
        selection: { interactionMode: INTERACTION_MODES.PLAN, permissionMode: PERMISSION_MODES.FULL, orchestrationMode: ORCHESTRATION_MODES.STANDARD, approvalReviewMode: "manual", thinking: null },
        target: { mode: "direct", branch: "main", branchSource: "branch", branchRemote: null, startFromOrigin: false, selectedWorktree: null },
      };
    }

    function listOrder(): string[] {
      return [...screen.getByTestId("thread-list").querySelectorAll("[data-testid='draft-item'], [data-testid='thread-item'], [role='separator']")]
        .map((node) => node.getAttribute("data-draft-id") ?? node.getAttribute("data-thread-id") ?? "separator");
    }

    afterEach(() => {
      useComposerDraftStore.setState({ drafts: {} });
      useThreadDraftStore.setState({ drafts: {} });
      useSidebarWidthStore.setState({ width: 304 });
      act(() => threadAttentionStore.getState().apply({ ...finished("t1"), lastTurn: null }));
    });

    it("tags a thread whose composer holds text or only an attachment, and not an empty one", () => {
      useComposerDraftStore.setState({ drafts: { t1: composer({ input: "half typed" }) } });
      const row = renderThread();
      expect(within(row).getByText("Draft")).toBeTruthy();

      act(() => useComposerDraftStore.setState({ drafts: { t1: composer({ attachments: [ATTACHMENT] }) } }));
      expect(within(row).getByText("Draft")).toBeTruthy();

      act(() => useComposerDraftStore.setState({ drafts: { t1: composer() } }));
      expect(within(row).queryByText("Draft")).toBeNull();
    });

    it("leaves the selected thread untagged while the user types, and tags it once they leave", () => {
      useComposerDraftStore.setState({ drafts: { t1: composer({ input: "half typed" }) } });
      const row = renderThread();
      act(() => useWorkspaceStore.setState({ activeThreadId: "t1" }));
      expect(within(row).queryByText("Draft")).toBeNull();

      act(() => useWorkspaceStore.setState({ activeThreadId: null }));
      expect(within(row).getByText("Draft")).toBeTruthy();
    });

    it("keeps the status label beside the Draft tag", () => {
      useSidebarWidthStore.setState({ width: SIDEBAR_STATUS_WORD_WIDTH });
      act(() => threadAttentionStore.getState().apply(finished("t1")));
      useComposerDraftStore.setState({ drafts: { t1: composer({ input: "half typed" }) } });
      const row = renderThread();
      expect(within(row).getByText("Draft")).toBeTruthy();
      expect(within(screen.getByTestId("thread-status")).getByText("Finished")).toBeTruthy();
    });

    it("lists new-thread drafts first in the Threads view, then a separator, then threads", () => {
      useSidebarUiStore.setState({ view: "threads" });
      useThreadDraftStore.setState({ drafts: { d1: newThreadDraft("d1", "Typed idea\nmore") } });
      useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [createMockThread({ id: "t1", workspace_id: "ws-1" })], activeWorkspaceId: "ws-1", activeThreadId: null });
      render(<Harness />);
      expect(listOrder()).toEqual(["d1", "separator", "t1"]);
      const draft = screen.getByTestId("draft-item");
      expect(within(draft).getByText("Typed idea")).toBeTruthy();
      expect(within(draft).getByText("Draft")).toBeTruthy();
      expect(within(draft).getByText("now")).toBeTruthy();
      expect(within(draft).getByLabelText("Provider, Claude")).toBeTruthy();
    });

    it("lists a new-thread draft first in its project without a separator", () => {
      useThreadDraftStore.setState({ drafts: { d1: newThreadDraft("d1", "Typed idea") } });
      renderThread();
      expect(listOrder()).toEqual(["d1", "t1"]);
      expect(within(screen.getByTestId("draft-item")).getByRole("button", { name: "Delete draft" })).toBeTruthy();
    });

    it("names a narrow grouped row's status by its icon and keeps Draft as the tag's name", async () => {
      useSidebarWidthStore.setState({ width: 220 });
      act(() => threadAttentionStore.getState().apply(finished("t1")));
      useComposerDraftStore.setState({ drafts: { t1: composer({ input: "half typed" }) } });
      renderThread();
      const status = screen.getByTestId("thread-status");
      expect(within(status).queryByText("Finished")).toBeNull();
      expect(statusGlyph(within(status).getByRole("img", { name: "Finished" }))).toBe("circle-check");

      const tag = screen.getByTestId("draft-tag");
      expect(tag).toHaveTextContent("Draft");
      fireEvent.pointerOver(tag, { pointerType: "mouse" });
      fireEvent.mouseEnter(tag, { clientX: 10, clientY: 10 });
      fireEvent.mouseMove(tag, { clientX: 11, clientY: 10 });
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(screen.getAllByText("Draft").length).toBeGreaterThan(1);
    });

    it("names a narrow Threads row's status by its icon, with no clipped label", async () => {
      useSidebarWidthStore.setState({ width: 220 });
      useSidebarUiStore.setState({ view: "threads" });
      act(() => threadAttentionStore.getState().apply({ ...finished("t1"), waiting: { kind: "approval", since: "2026-10-27T11:00:00.000Z" } }));
      useWorkspaceStore.setState({ workspaces: [WORKSPACE], threads: [createMockThread({ id: "t1", workspace_id: "ws-1", title: "Row title", last_activity_at: new Date().toISOString() })], activeWorkspaceId: "ws-1", activeThreadId: null });
      render(<Harness />);
      const status = screen.getByTestId("thread-status");
      expect(within(status).queryByText("Approval required")).toBeNull();
      const mark = within(status).getByRole("img", { name: "Approval required" }).parentElement!;
      fireEvent.pointerOver(mark, { pointerType: "mouse" });
      fireEvent.mouseEnter(mark, { clientX: 10, clientY: 10 });
      fireEvent.mouseMove(mark, { clientX: 11, clientY: 10 });
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(screen.getByText("Approval required")).toBeTruthy();
    });

    it("shows a grouped row's status as its named icon below the status word width, and its word at it", () => {
      useSidebarWidthStore.setState({ width: SIDEBAR_STATUS_WORD_WIDTH - 1 });
      act(() => threadAttentionStore.getState().apply(finished("t1")));
      renderThread();
      const status = screen.getByTestId("thread-status");
      expect(within(status).queryByText("Finished")).toBeNull();
      expect(within(status).getByRole("img", { name: "Finished" })).toBeVisible();

      act(() => useSidebarWidthStore.setState({ width: SIDEBAR_STATUS_WORD_WIDTH }));
      expect(within(screen.getByTestId("thread-status")).getByText("Finished")).toBeTruthy();
    });

    it("keeps a quiet grouped row's time as text below the status word width", () => {
      useSidebarWidthStore.setState({ width: SIDEBAR_STATUS_WORD_WIDTH - 1 });
      renderThread({ last_activity_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() });
      expect(within(screen.getByTestId("thread-status")).getByText("5h")).toBeTruthy();
    });
  });

  describe("hover card", () => {
    const openCard = async (row: HTMLElement) => {
      act(() => row.focus());
      fireEvent.keyDown(row, { key: "Tab" });
      await act(() => vi.advanceTimersByTimeAsync(1000));
      const card = screen.queryByTestId("thread-preview-t1");
      if (!card) throw new Error("no card");
      return card;
    };

    it("names every PR on its own line and shows no status", async () => {
      const row = renderThread({
        model: "claude-opus-4-6",
        pull_requests: [
          createMockThreadPullRequest({ number: 10, state: "merged", url: PR_URL(10), title: "Merged change" }),
          createMockThreadPullRequest({ number: 11, state: "open", url: PR_URL(11), title: "Open change" }),
        ],
      });
      act(() => threadAttentionStore.getState().apply(finished("t1")));
      expect(within(row).getByRole("img", { name: "Finished" })).toBeTruthy();
      const card = await openCard(row);
      const lines = within(card).getAllByRole("link");
      expect(lines.map((line) => line.textContent)).toEqual(["#11Open change", "#10Merged change"]);
      expect(within(card).getByLabelText(/^Model, /)).toBeTruthy();
      expect(card).not.toHaveTextContent(/Finished|Running|Updated/);
    });

    it("is the row's description while it shows", async () => {
      const row = renderThread();
      expect(row).not.toHaveAttribute("aria-describedby");
      const card = await openCard(row);
      const describedBy = row.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy ?? "")).toContainElement(card);
    });

    it("puts a closed thread's close and delete dates on one line", async () => {
      useSidebarUiStore.setState({ scope: "completed" });
      const card = await openCard(renderThread({ user_completed_at: "2026-10-27T11:00:00.000Z", scheduled_deletion_at: "2026-11-03T11:00:00.000Z" }));
      expect(within(card).getByLabelText(/^Closed .+ · deletes .+/)).toBeTruthy();
      expect(card).not.toHaveTextContent(/Deletes/);
    });

    it("omits the model line when the thread has no model", async () => {
      const card = await openCard(renderThread({ model: null }));
      expect(within(card).queryByLabelText(/^Model, /)).toBeNull();
    });
  });
});
