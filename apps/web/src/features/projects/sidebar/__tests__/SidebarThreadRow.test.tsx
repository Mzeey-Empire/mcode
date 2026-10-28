import { createMockThread, createMockThreadPullRequest, createMockWorkspace } from "@mcode/contracts/testing";
import type { ThreadAttention } from "@mcode/contracts/models/thread-attention";
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
import { useSidebarUiStore } from "../sidebar-ui-store";
import { useProjectTreeMenus } from "../../ProjectTree";
import { SidebarList } from "../SidebarList";
import { useSidebarModel } from "../use-sidebar-model";
import { PREVIEW_SCROLL_SETTLE_MS } from "../preview-scroll-guard";
import { FakeVirtualViewport } from "./fake-virtual-viewport";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";

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
  const thread = createMockThread({ id: "t1", workspace_id: "ws-1", title: "Row title", provider: "claude", mode: "worktree", ...overrides });
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
    const complete = screen.getByRole("button", { name: "Complete Row title" });
    expect(label).toBeVisible();
    expect(complete).not.toBeVisible();

    fireEvent.mouseEnter(row);
    expect(label).not.toBeVisible();
    expect(complete).toBeVisible();

    fireEvent.mouseLeave(row);
    expect(label).toBeVisible();
    expect(complete).not.toBeVisible();
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
