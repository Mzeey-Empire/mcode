import { createMockThread, createMockThreadPullRequest, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useSidebarUiStore } from "../sidebar-ui-store";
import { ProjectSidebar } from "../ProjectSidebar";

const WORKSPACE = createMockWorkspace({ id: "ws-1", name: "Alpha", path: "/alpha" });
const WITH_PR = [createMockThreadPullRequest({ number: 7, state: "open", url: "https://github.com/o/r/pull/7" })];

function seedThread(overrides: Partial<Thread>): void {
  useWorkspaceStore.setState({
    workspaces: [WORKSPACE],
    threads: [createMockThread({ id: "t1", workspace_id: "ws-1", title: "Menu thread", mode: "worktree", pull_requests: WITH_PR, ...overrides })],
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

function openThreadMenu(): HTMLElement {
  render(<ProjectSidebar />);
  fireEvent.contextMenu(screen.getByRole("button", { name: /^Provider, .* Menu thread/ }));
  return screen.getByRole("menuitemcheckbox", { name: /Complete when PRs merge/ });
}

describe("SidebarList thread menu switch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(mockTransport.updateThreadSettings).mockReset().mockResolvedValue(true);
    useSidebarUiStore.setState({ view: "projects", scope: "active", expandedProjects: new Set(["ws-1"]), showMore: new Set() });
    setGlobalCompleteOnMerge(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    useWorkspaceStore.setState({ workspaces: [], threads: [], activeThreadId: null, activeWorkspaceId: null });
  });

  it("shows the global value when the thread has no override, and the override when it has one", () => {
    seedThread({ auto_complete_on_merge: null });
    const inherited = openThreadMenu();
    expect(inherited).toHaveAttribute("aria-checked", "true");

    act(() => seedThread({ auto_complete_on_merge: false }));

    expect(screen.getByRole("menuitemcheckbox", { name: /Complete when PRs merge/ })).toHaveAttribute("aria-checked", "false");
  });

  it("toggles the override and keeps the menu open", async () => {
    seedThread({ auto_complete_on_merge: null });
    const item = openThreadMenu();

    fireEvent.click(item);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(mockTransport.updateThreadSettings).toHaveBeenCalledWith("t1", { autoCompleteOnMerge: false });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: /Complete when PRs merge/ })).toHaveAttribute("aria-checked", "false");
  });

  it("is disabled with the reason No linked PRs when the thread has none", async () => {
    seedThread({ pull_requests: [] });
    const item = openThreadMenu();
    expect(item).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(item);
    fireEvent.focus(item);
    fireEvent.mouseEnter(item);
    await act(() => vi.advanceTimersByTimeAsync(1000));

    expect(mockTransport.updateThreadSettings).not.toHaveBeenCalled();
    expect(screen.getByText("No linked PRs")).toBeInTheDocument();
  });

  it("restores the value with the reason when the save fails", async () => {
    const issues = [{ code: "unrecognized_keys", keys: ["autoCompleteOnMerge"], path: [], message: "Unrecognized key: \"autoCompleteOnMerge\"" }];
    vi.mocked(mockTransport.updateThreadSettings).mockRejectedValue(new RpcError(JSON.stringify(issues), "INVALID_PARAMS"));
    seedThread({ auto_complete_on_merge: null });
    const item = openThreadMenu();

    fireEvent.click(item);
    await act(() => vi.advanceTimersByTimeAsync(0));

    const restored = screen.getByRole("menuitemcheckbox", { name: /Complete when PRs merge/ });
    expect(restored).toHaveAttribute("aria-checked", "true");
    expect(restored).toHaveTextContent('Unrecognized key: "autoCompleteOnMerge"');
    expect(restored).not.toHaveTextContent("unrecognized_keys");
    expect(useWorkspaceStore.getState().threads[0]?.auto_complete_on_merge).toBeNull();
  });
});
