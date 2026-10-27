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
    // The open PR outranks merged and closed, so the chip wears the open state.
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
});
