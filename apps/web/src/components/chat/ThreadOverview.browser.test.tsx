import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/transport", async (importOriginal) =>
  (await import("./__tests__/thread-overview-mocks")).mockTransportModule(
    await importOriginal<typeof import("@/transport")>(),
  ),
);

vi.mock("@/hooks/useBranchPr", () => ({
  useBranchPr: vi.fn().mockReturnValue(null),
}));

vi.mock("@/hooks/useHasCommitsAhead", () => ({
  useHasCommitsAhead: vi.fn().mockReturnValue(null),
}));

vi.mock("@/features/projects/state/workspaceStore", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockWorkspaceStoreModule(),
);

vi.mock("@/stores/diffStore", async (importOriginal) =>
  (await import("./__tests__/thread-overview-mocks")).mockDiffStoreModule(
    await importOriginal<typeof import("@/stores/diffStore")>(),
  ),
);

vi.mock("@/stores/threadStore", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockThreadStoreModule(),
);

vi.mock("@/features/subagents", async (importOriginal) =>
  (await import("./__tests__/thread-overview-mocks")).mockSubagentsModule(
    await importOriginal<typeof import("@/features/subagents")>(),
  ),
);

vi.mock("@/components/ui/dialog", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockDialogModule(),
);

vi.mock("./CreatePrDialog", async () =>
  (await import("./__tests__/thread-overview-mocks")).mockCreatePrDialogModule(),
);

import {
  browserAutomationLifecycleKey,
  browserAutomationTargetKey,
  useBrowserAutomationStore,
} from "@/features/preview";
import type { BrowserSessionLifecycleTab } from "@/features/preview";
import { previewTabsScopeKey, usePreviewTabsStore } from "@/features/preview/state/previewTabsStore";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getThreadOverviewBrowserTabs } from "@/features/thread-overview/entries/browser";
import { branchlessThread, resetThreadOverviewState } from "./__tests__/thread-overview-harness";
import { ThreadOverview } from "./ThreadOverview";

describe("ThreadOverview Browser rows", () => {
  beforeEach(() => {
    resetThreadOverviewState();
  });

  it("renders one Browser row for the thread and reveals the exact tab without navigation", async () => {
    const lifecycleTab = {
      workspaceId: "ws-1",
      threadId: "thread-1",
      tabId: "agent-tab",
      providerSessionId: "session-1",
      providerInstanceId: "instance-1",
      provenance: "agent-created",
      ownership: "owned",
      target: {
        desktopInstanceId: "desktop-1",
        windowId: 1,
        connectionGeneration: 1,
        threadId: "thread-1",
        tabId: "agent-tab",
        targetGeneration: 1,
        active: true,
        focused: true,
        lastUsedAt: 1,
        controller: { tabId: "agent-tab", controller: "agent", controlEpoch: 1 },
      },
    } satisfies BrowserSessionLifecycleTab;
    const claimedTab = {
      ...lifecycleTab,
      tabId: "claimed-tab",
      provenance: "claimed-user" as const,
      ownership: "claimed" as const,
      target: {
        ...lifecycleTab.target,
        tabId: "claimed-tab",
        active: false,
        focused: false,
        controller: { tabId: "claimed-tab", controller: "none", controlEpoch: 1 },
      },
    } satisfies BrowserSessionLifecycleTab;
    useBrowserAutomationStore.setState({
      registered: true,
      status: "registered",
      liveTargets: new Map([
        [browserAutomationTargetKey("ws-1", "thread-1", "agent-tab"), { workspaceId: "ws-1", threadId: "thread-1", tabId: "agent-tab", revision: 1, lastUsedAt: 1 }],
        [browserAutomationTargetKey("ws-1", "thread-1", "claimed-tab"), { workspaceId: "ws-1", threadId: "thread-1", tabId: "claimed-tab", revision: 1, lastUsedAt: 1 }],
        [browserAutomationTargetKey("ws-1", "thread-1", "ordinary-tab"), { workspaceId: "ws-1", threadId: "thread-1", tabId: "ordinary-tab", revision: 1, lastUsedAt: 1 }],
      ]),
      lifecycleTabs: new Map<string, BrowserSessionLifecycleTab>([
        [browserAutomationLifecycleKey("ws-1", "thread-1", "agent-tab"), lifecycleTab],
        [browserAutomationLifecycleKey("ws-1", "thread-1", "claimed-tab"), claimedTab],
      ]),
      controllers: new Map([
        [browserAutomationTargetKey("ws-1", "thread-1", "agent-tab"), { tabId: "agent-tab", controller: "agent", controlEpoch: 1 }],
      ]),
      actingTargets: new Set([browserAutomationTargetKey("ws-1", "thread-1", "agent-tab")]),
    });
    usePreviewTabsStore.setState({
      tabSetByScope: {
        [previewTabsScopeKey("ws-1", "thread-1")]: {
          threadId: "thread-1",
          activeTabId: "agent-tab",
          tabs: [
            { id: "agent-tab", threadId: "thread-1", title: "Agent page", url: "https://example.test/very/long/path/suffix", faviconUrl: null, warm: true, active: true },
            { id: "claimed-tab", threadId: "thread-1", title: "Claimed page", url: "https://claimed.test", faviconUrl: "https://claimed.test/favicon.ico", warm: true, active: false },
            { id: "ordinary-tab", threadId: "thread-1", title: "Ordinary page", url: "https://ordinary.test", faviconUrl: null, warm: true, active: false },
          ],
        },
      },
      liveChromeByScope: {},
      persistentTabIdsByScope: {},
    });
    const thread = branchlessThread();
    const rows = getThreadOverviewBrowserTabs({
      workspaceId: thread.workspace_id,
      threadId: thread.id,
      tabSet: usePreviewTabsStore.getState().tabSetByScope[
        previewTabsScopeKey(thread.workspace_id, thread.id)
      ] ?? null,
      lifecycleTabs: useBrowserAutomationStore.getState().lifecycleTabs,
      liveTargets: useBrowserAutomationStore.getState().liveTargets,
      controllers: useBrowserAutomationStore.getState().controllers,
      actingTargets: useBrowserAutomationStore.getState().actingTargets,
    });
    expect(rows.map((row) => row.tab.id)).toEqual(["agent-tab", "claimed-tab", "ordinary-tab"]);

    const showRightPanel = vi.spyOn(useDiffStore.getState(), "showRightPanel");
    const setRightPanelTab = vi.spyOn(useDiffStore.getState(), "setRightPanelTab");
    const activatePage = vi.spyOn(usePreviewTabsStore.getState(), "activatePage");
    const navigate = (useWorkspaceStore as unknown as { setState: ReturnType<typeof vi.fn> }).setState;
    navigate.mockClear();
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    const row = screen.getByRole("button", { name: "Browser, Working on the page, Agent page" });
    const user = userEvent.setup();
    expect(row).toHaveAttribute("type", "button");
    expect(screen.getAllByTestId("thread-overview-browser")).toHaveLength(1);
    act(() => {
      useBrowserAutomationStore.getState().setControllerForTarget("ws-1", "thread-1", "agent-tab", {
        tabId: "agent-tab",
        controller: "human",
        controlEpoch: 2,
      });
    });
    const pausedRow = screen.getByRole("button", { name: "Browser, paused, Agent page" });
    expect(screen.getByRole("button", { name: "Hand back" })).toBeInTheDocument();

    pausedRow.focus();
    await user.keyboard("{Enter}");
    expect(showRightPanel).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(setRightPanelTab).toHaveBeenCalledWith("ws-1", "thread-1", "preview");
    expect(activatePage).toHaveBeenCalledWith("ws-1", "thread-1", "agent-tab");
    expect(navigate).not.toHaveBeenCalled();

    act(() => useBrowserAutomationStore.getState().detachTarget("ws-1", "thread-1", "agent-tab"));
    expect(screen.queryByRole("button", { name: /Agent page/ })).not.toBeInTheDocument();
    const openRow = screen.getByRole("button", { name: "Browser, Claimed page, claimed.test, 1 more pages" });
    expect(openRow.querySelector('img[src="https://claimed.test/favicon.ico"]')).toBeInTheDocument();

    act(() => useBrowserAutomationStore.getState().setLifecycleTabs([claimedTab]));
    expect(screen.queryByRole("button", { name: /Agent page/ })).not.toBeInTheDocument();

    act(() => useBrowserAutomationStore.setState({ registered: false, status: "unavailable" }));
    expect(screen.queryByTestId("thread-overview-browser")).not.toBeInTheDocument();
  });

  it("shows a pending agent Browser page before target attachment finishes", () => {
    useBrowserAutomationStore.setState({
      registered: true,
      status: "registered",
      pendingAgentOpens: new Map([
        [
          "pending-open",
          {
            workspaceId: "ws-1",
            threadId: "thread-1",
            tabId: "agent-tab",
            url: "https://example.test/search",
            startedAt: 1,
          },
        ],
      ]),
    });
    usePreviewTabsStore.setState({
      tabSetByScope: {
        [previewTabsScopeKey("ws-1", "thread-1")]: {
          threadId: "thread-1",
          activeTabId: "agent-tab",
          tabs: [{
            id: "agent-tab",
            threadId: "thread-1",
            title: null,
            url: null,
            faviconUrl: null,
            warm: true,
            active: true,
          }],
        },
      },
      liveChromeByScope: {},
      persistentTabIdsByScope: {},
    });

    render(<ThreadOverview thread={branchlessThread()} threadPaneWidth={1400} />);

    expect(screen.getByRole("button", { name: "Browser, Working on the page, example.test" })).toBeInTheDocument();
  });

  it("filters empty and detached tabs while retaining released live tabs as user rows", () => {
    const releasedLifecycle = {
      workspaceId: "ws-1",
      threadId: "thread-1",
      tabId: "released-tab",
      providerSessionId: "session-1",
      providerInstanceId: "instance-1",
      provenance: "claimed-user" as const,
      ownership: "released" as const,
      target: {
        desktopInstanceId: "desktop-1",
        windowId: 1,
        connectionGeneration: 1,
        threadId: "thread-1",
        tabId: "released-tab",
        targetGeneration: 1,
        active: true,
        focused: true,
        lastUsedAt: 1,
        controller: { tabId: "released-tab", controller: "agent" as const, controlEpoch: 1 },
      },
    } satisfies BrowserSessionLifecycleTab;
    const tabSet = {
      threadId: "thread-1",
      activeTabId: "released-tab",
      tabs: [
        { id: "released-tab", threadId: "thread-1", title: "Released page", url: "https://released.test", faviconUrl: null, warm: true, active: true },
        { id: "empty-tab", threadId: "thread-1", title: "Empty", url: "", faviconUrl: null, warm: true, active: false },
        { id: "blank-tab", threadId: "thread-1", title: "Blank", url: "about:blank", faviconUrl: null, warm: true, active: false },
        { id: "error-tab", threadId: "thread-1", title: "Error", url: "chrome-error://chromewebdata/", faviconUrl: null, warm: true, active: false },
        { id: "wrong-thread-tab", threadId: "thread-2", title: "Wrong thread", url: "https://wrong-thread.test", faviconUrl: null, warm: true, active: false },
        { id: "wrong-workspace-tab", threadId: "thread-1", title: "Wrong workspace", url: "https://wrong-workspace.test", faviconUrl: null, warm: true, active: false },
        { id: "detached-tab", threadId: "thread-1", title: "Detached", url: "https://detached.test", faviconUrl: null, warm: true, active: false },
      ],
    };
    const liveTargets = new Map([
      [browserAutomationTargetKey("ws-1", "thread-1", "released-tab"), { workspaceId: "ws-1", threadId: "thread-1", tabId: "released-tab", revision: 1, lastUsedAt: 1 }],
      [browserAutomationTargetKey("ws-1", "thread-1", "empty-tab"), { workspaceId: "ws-1", threadId: "thread-1", tabId: "empty-tab", revision: 1, lastUsedAt: 1 }],
      [browserAutomationTargetKey("ws-1", "thread-1", "blank-tab"), { workspaceId: "ws-1", threadId: "thread-1", tabId: "blank-tab", revision: 1, lastUsedAt: 1 }],
      [browserAutomationTargetKey("ws-1", "thread-1", "error-tab"), { workspaceId: "ws-1", threadId: "thread-1", tabId: "error-tab", revision: 1, lastUsedAt: 1 }],
      [browserAutomationTargetKey("ws-1", "thread-2", "wrong-thread-tab"), { workspaceId: "ws-1", threadId: "thread-2", tabId: "wrong-thread-tab", revision: 1, lastUsedAt: 1 }],
      [browserAutomationTargetKey("ws-2", "thread-1", "wrong-workspace-tab"), { workspaceId: "ws-2", threadId: "thread-1", tabId: "wrong-workspace-tab", revision: 1, lastUsedAt: 1 }],
    ]);
    const rows = getThreadOverviewBrowserTabs({
      workspaceId: "ws-1",
      threadId: "thread-1",
      tabSet,
      lifecycleTabs: new Map([["released", releasedLifecycle]]),
      liveTargets,
      controllers: new Map([
        [browserAutomationTargetKey("ws-1", "thread-1", "released-tab"), { tabId: "released-tab", controller: "agent" as const, controlEpoch: 2 }],
      ]),
      actingTargets: new Set(),
    });

    expect(rows.map((row) => row.tab.id)).toEqual(["released-tab"]);
    expect(rows[0]?.lifecycle?.ownership).toBe("released");
    expect(rows[0]?.controller).toBeUndefined();
  });
});
