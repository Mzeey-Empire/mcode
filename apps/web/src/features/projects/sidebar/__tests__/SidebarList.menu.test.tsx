import { createMockThread, createMockThreadPullRequest, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@/transport/types";
import { RpcError } from "@/transport/ws-transport";

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

import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useSidebarUiStore } from "../sidebar-ui-store";
import { useCompletionStore } from "../completion-store";
import { ProjectSidebar } from "../ProjectSidebar";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";

const WORKSPACE = createMockWorkspace({ id: "ws-1", name: "Alpha", path: "/alpha" });
const WITH_PR = [createMockThreadPullRequest({ number: 7, state: "open", url: "https://github.com/o/r/pull/7" })];

function seedThread(overrides: Partial<Thread>): void {
  useWorkspaceStore.setState({
    workspaces: [WORKSPACE],
    threads: [createMockThread({ id: "t1", workspace_id: "ws-1", title: "Menu thread", mode: "worktree", branch: "feat/menu", checkout_state: "named", pull_requests: WITH_PR, last_activity_at: new Date().toISOString(), ...overrides })],
    activeWorkspaceId: "ws-1",
    activeThreadId: null,
    loadWorkspaces: vi.fn().mockResolvedValue(undefined),
  });
}

function setGlobalCompleteOnMerge(value: boolean): void {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, thread: { ...state.settings.thread, completion: { ...state.settings.thread.completion, completeOnPrMerge: value } } },
  }));
}

async function openThreadMenu(): Promise<HTMLElement> {
  render(<ProjectSidebar />);
  fireEvent.contextMenu(screen.getByRole("button", { name: /^Provider, .* Menu thread/ }));
  return screen.findByRole("menu");
}

async function openSubmenu(user: UserEvent, name: string): Promise<void> {
  await openThreadMenu();
  await user.click(await screen.findByRole("menuitem", { name }));
}

describe("SidebarList thread menu", () => {
  let user: UserEvent;

  beforeEach(() => {
    user = userEvent.setup();
    vi.mocked(mockTransport.updateThreadSettings).mockReset().mockResolvedValue(true);
    useSidebarUiStore.setState({ view: "projects", scope: "active", expandedProjects: new Set(["ws-1"]), showMore: new Set() });
    useThreadStore.setState({ runningThreadIds: new Set() });
    setGlobalCompleteOnMerge(true);
  });

  afterEach(() => {
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
    useThreadStore.setState({ runningThreadIds: new Set() });
    useCompletionStore.setState({ entries: new Map(), hoveredThreadId: null, undoLineThreadId: null });
    threadAttentionStore.setState({ byThreadId: {}, visitBaselines: {}, onScreenThreadId: null });
  });

  it("lists the concept's rows in order", async () => {
    seedThread({});
    const menu = await openThreadMenu();
    const names = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent);
    expect(names).toEqual(["Close thread", "Rename thread", "Auto-close behavior", "Copy", "Project settings", "Delete"]);
  });

  it.each([
    [null, "App default"],
    [true, "Close when PRs merge"],
    [false, "Keep open"],
  ] as const)("checks the matching auto-close choice for override %s", async (override, checkedName) => {
    seedThread({ auto_complete_on_merge: override });
    await openSubmenu(user, "Auto-close behavior");

    const checked = (await screen.findAllByRole("menuitemradio")).filter((item) => item.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAccessibleName(expect.stringContaining(checkedName));
  });

  it.each([
    [false, "Keep open"],
    [true, "Close when PRs merge"],
  ] as const)("shows the resolved global value %s as %s beside App default", async (global, label) => {
    setGlobalCompleteOnMerge(global);
    seedThread({ auto_complete_on_merge: null });
    await openSubmenu(user, "Auto-close behavior");

    expect(await screen.findByRole("menuitemradio", { name: /App default/ })).toHaveTextContent(label);
  });

  it.each([
    ["App default", true, null],
    ["Close when PRs merge", null, true],
    ["Keep open", null, false],
  ] as const)("saves %s as override %s -> %s", async (choice, from, saved) => {
    seedThread({ auto_complete_on_merge: from });
    await openSubmenu(user, "Auto-close behavior");

    await user.click(await screen.findByRole("menuitemradio", { name: new RegExp(`^${choice}`) }));

    expect(mockTransport.updateThreadSettings).toHaveBeenCalledWith("t1", { autoCompleteOnMerge: saved });
    expect(useWorkspaceStore.getState().threads[0]?.auto_complete_on_merge).toBe(saved);
  });

  it("offers auto-close choices when no PR is linked", async () => {
    seedThread({ pull_requests: [], auto_complete_on_merge: null });
    await openSubmenu(user, "Auto-close behavior");

    await user.click(await screen.findByRole("menuitemradio", { name: /Keep open/ }));

    expect(mockTransport.updateThreadSettings).toHaveBeenCalledWith("t1", { autoCompleteOnMerge: false });
  });

  it("restores the previous choice when the save fails", async () => {
    const issues = [{ code: "unrecognized_keys", keys: ["autoCompleteOnMerge"], path: [], message: "Unrecognized key: \"autoCompleteOnMerge\"" }];
    vi.mocked(mockTransport.updateThreadSettings).mockRejectedValue(new RpcError(JSON.stringify(issues), "INVALID_PARAMS"));
    seedThread({ auto_complete_on_merge: null });
    await openSubmenu(user, "Auto-close behavior");

    await user.click(await screen.findByRole("menuitemradio", { name: /Keep open/ }));
    await act(async () => {});

    expect(useWorkspaceStore.getState().threads[0]?.auto_complete_on_merge).toBeNull();
    expect(await screen.findByRole("menuitemradio", { name: /App default/ })).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByRole("menuitemradio", { name: /Keep open/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("alert")).toHaveTextContent('Unrecognized key: "autoCompleteOnMerge"');
  });

  it("copies the thread's real branch name", async () => {
    seedThread({ branch: "feat/menu", base_branch: "main" });
    await openSubmenu(user, "Copy");

    await user.click(await screen.findByRole("menuitem", { name: "Branch" }));

    await expect(navigator.clipboard.readText()).resolves.toBe("feat/menu");
  });

  it("disables Copy Branch when the checkout has no branch", async () => {
    seedThread({ branch: "HEAD", checkout_state: "branchless", base_branch: "main", head_sha: "abc1234" });
    await openSubmenu(user, "Copy");

    expect(await screen.findByRole("menuitem", { name: "Branch" })).toHaveAttribute("aria-disabled", "true");
  });

  it("disables Close thread while the thread is running", async () => {
    seedThread({});
    useThreadStore.setState({ runningThreadIds: new Set(["t1"]) });
    await openThreadMenu();

    expect(await screen.findByRole("menuitem", { name: "Close thread" })).toHaveAttribute("aria-disabled", "true");
  });

  it("refuses Close thread on a thread waiting for approval and names the reason", async () => {
    seedThread({});
    act(() => threadAttentionStore.getState().apply({
      threadId: "t1",
      waiting: { kind: "approval", since: "2026-10-11T12:00:00.000Z" },
      lastTurn: null,
      seen: { sequence: null, at: null },
      hasUnfinishedDelegatedTasks: false,
    }));
    await openThreadMenu();

    const close = await screen.findByRole("menuitem", { name: "Close thread" });
    expect(close).toHaveAttribute("aria-disabled", "true");
    expect(close).toHaveAccessibleDescription("Approval required");
  });

  it("closes an idle thread from Close thread", async () => {
    seedThread({});
    vi.mocked(mockTransport.completeThread).mockReset().mockReturnValue(new Promise(() => {}));
    await openThreadMenu();

    await user.click(await screen.findByRole("menuitem", { name: "Close thread" }));

    expect(mockTransport.completeThread).toHaveBeenCalledWith("t1", expect.any(Number));
  });
});
