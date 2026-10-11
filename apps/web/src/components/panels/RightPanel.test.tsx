import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  activatePreviewPage,
  closePreviewPage,
  openPreviewPage,
  terminalKill,
  previewPanelRender,
  previewTabSet,
  previewTabsBridge,
} = vi.hoisted(() => ({
  activatePreviewPage: vi.fn(),
  closePreviewPage: vi.fn(),
  openPreviewPage: vi.fn(),
  terminalKill: vi.fn(),
  previewPanelRender: vi.fn(),
  previewTabSet: { current: null as {
    threadId: string;
    activeTabId: string | null;
    tabs: Array<{
      id: string;
      threadId: string;
      title: string | null;
      url: string | null;
      faviconUrl: string | null;
      warm: boolean;
      active: boolean;
    }>;
  } | null },
  previewTabsBridge: {
    list: vi.fn(),
    onUpdated: vi.fn(),
    updatedListener: { current: null as ((payload: unknown) => void) | null },
  },
}));

vi.mock("./ActivityRail", () => ({
  ACTIVITY_RAIL_FLOATING_OVERLAP_PX: 112,
  ActivityRail: ({
    tabInstances,
    activeTabId,
    onClose,
    onSelect,
    onExpandedChange,
    captionAction,
  }: {
    tabInstances: Array<{ id: string; type: string }>;
    activeTabId: string | null;
    onClose?: (instanceId: string) => void;
    onSelect?: (instanceId: string) => void;
    onExpandedChange?: (expanded: boolean) => void;
    captionAction?: React.ReactNode;
  }) => (
    <div
      data-testid="activity-rail"
      data-open-tabs={tabInstances.map((instance) => instance.type).join(",")}
      data-active-tab-id={activeTabId}
    >
      <div data-testid="activity-rail-caption-strip">{captionAction}</div>
      <button type="button" data-testid="expand-activity-rail" onClick={() => onExpandedChange?.(true)} />
      {tabInstances.map((instance) => (
        <span key={instance.id}>
          <button type="button" data-testid={`select-${instance.id}`} onClick={() => onSelect?.(instance.id)} />
          <button type="button" data-testid={`close-${instance.id}`} onClick={() => onClose?.(instance.id)} />
        </span>
      ))}
    </div>
  ),
}));
vi.mock("./PanelEmptyState", () => ({
  PanelEmptyState: () => <div data-testid="panel-empty-state" />,
}));
vi.mock("./ResizableRightPanel", () => ({
  ResizableRightPanel: ({
    children,
    inert,
    testId,
    ...props
  }: {
    children: React.ReactNode;
    inert?: boolean;
    testId?: string;
    "aria-hidden"?: boolean;
    "data-right-panel-root"?: string;
    className?: string;
  }) => (
    <div
      data-testid={testId}
      className={props.className}
      aria-hidden={props["aria-hidden"]}
      data-right-panel-root={props["data-right-panel-root"]}
      inert={inert ? true : undefined}
    >
      {children}
    </div>
  ),
}));
vi.mock("@/features/subagents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/subagents")>()),
  SubagentsPanel: () => <div />,
}));
vi.mock("./CoordinationPanel", () => ({
  CoordinationPanel: ({ workspaceId, threadId }: { workspaceId: string; threadId: string }) => (
    <div data-testid="coordination-panel-integration">{workspaceId}:{threadId}</div>
  ),
}));
vi.mock("./plan", async () => {
  const { PanelHeaderSlot } = await import("./shell/PanelHeader");
  return {
    PlanPanel: () => (
      <PanelHeaderSlot slot="leading">
        <span data-testid="plan-header" />
      </PanelHeaderSlot>
    ),
  };
});
vi.mock("@/components/diff", async () => {
  const { PanelHeaderSlot } = await import("./shell/PanelHeader");
  return {
    DiffPanel: () => (
      <PanelHeaderSlot slot="row2">
        <span data-testid="review-controls" />
      </PanelHeaderSlot>
    ),
  };
});
vi.mock("@/features/preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/preview")>()),
  PreviewPanel: (props: Record<string, unknown>) => {
    previewPanelRender(props);
    return <div data-testid="preview-panel" data-covered-right={props.coveredRight ?? 0} />;
  },
}));
vi.mock("@/features/terminal/surfaces/TerminalPoolSlotContext", () => ({
  TerminalPoolSlot: () => <div data-testid="terminal-pool-slot" />,
}));
vi.mock("@/features/preview/state/previewTabsStore", () => ({
  usePreviewDisplayTabSet: () => previewTabSet.current,
  usePreviewTabsStore: {
    getState: () => ({
      activatePage: activatePreviewPage,
      closePage: closePreviewPage,
      openPage: openPreviewPage,
      setTabSet: (_scopeId: string, tabSet: typeof previewTabSet.current) => {
        previewTabSet.current = tabSet;
      },
    }),
  },
}));
vi.mock("@/lib/ensure-terminal", () => ({ createTerminalForScope: vi.fn() }));
vi.mock("@/lib/right-panel-layout", () => ({ toggleRightPanelAdaptive: vi.fn() }));
vi.mock("@/transport", () => ({ getTransport: () => ({ terminalKill, getWorkspaceActionRun: vi.fn() }) }));

import { reconcileWarmPreviewScopes, RightPanel } from "./RightPanel";
import { TERMINAL_CAP_REASON } from "./TerminalTool";
import { TERMINAL_MAX_PER_SCOPE } from "@mcode/contracts";
import { createRightPanelState, useDiffStore } from "@/stores/diffStore";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { setLayoutMeasurements } from "@/lib/composer-layout";
import { toggleRightPanelAdaptive } from "@/lib/right-panel-layout";
import { createTerminalForScope } from "@/lib/ensure-terminal";
import { useToastStore } from "@/stores/toastStore";
import {
  browserAutomationScopeKey,
  browserSurfacePresentationCoordinator,
  useBrowserAutomationStore,
} from "@/features/preview";

describe("RightPanel", () => {
  beforeEach(() => {
    previewTabSet.current = null;
    activatePreviewPage.mockReset();
    closePreviewPage.mockReset();
    openPreviewPage.mockReset();
    terminalKill.mockReset();
    vi.mocked(createTerminalForScope).mockClear();
    previewPanelRender.mockReset();
    previewTabsBridge.list.mockReset();
    previewTabsBridge.list.mockResolvedValue({ ok: true, data: null });
    previewTabsBridge.updatedListener.current = null;
    previewTabsBridge.onUpdated.mockReset();
    previewTabsBridge.onUpdated.mockImplementation((listener: (payload: unknown) => void) => {
      previewTabsBridge.updatedListener.current = listener;
      return vi.fn();
    });
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        preview: {
          tabs: {
            list: previewTabsBridge.list,
            onUpdated: previewTabsBridge.onUpdated,
          },
        },
      },
    });
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1", activeThreadId: null });
    useTerminalStore.setState({ terminals: {}, terminalPanelByThread: {}, ptyToThread: {}, hasHydrated: false });
    useBrowserAutomationStore.setState({
      activeRequests: new Map(),
      lifecycleTabs: new Map(),
      liveTargets: new Map(),
      pendingAgentOpens: new Map(),
      hostedScopeIds: new Set(),
    });
    useDiffStore.setState({
      rightPanelByThread: {},
      rightPanelFallbackByWorkspace: {},
      snapshotsByThread: {},
    });
    useProjectActionStore.setState({ runsByThread: {} });
    useUiStore.setState({ rightPanelMaximized: false });
    setLayoutMeasurements(1200, 1200);
  });

  afterEach(() => cleanup());

  it("renders an empty workspace terminal scope without an external-store snapshot warning", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<RightPanel />);

    expect(screen.getByTestId("right-panel")).toBeInTheDocument();
    expect(error.mock.calls.flat().join(" ")).not.toContain(
      "The result of getSnapshot should be cached",
    );
    error.mockRestore();
  });

  const buildRun = (overrides: Partial<WorkspaceEnvironmentActionRun>): WorkspaceEnvironmentActionRun => ({
    threadId: "thread-1",
    workspaceId: "workspace-1",
    actionId: "build",
    runId: "run-1",
    revision: 1,
    terminalSessionId: "pty-action",
    trigger: "manual",
    actionName: "Build",
    status: "completed",
    snapshot: { platform: "windows", script: "bun run build", checkoutPath: "C:\\repo", terminal: null, environmentNames: [] },
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: "2026-08-22T12:00:00.000Z",
    finishedAt: "2026-08-22T12:00:01.000Z",
    exitCode: 0,
    transcript: "done",
    transcriptTruncated: false,
    ...overrides,
  });
  const actionRecord = { id: "pty-action", threadId: "thread-1", label: "build", kind: "action" as const, actionId: "build" };
  const threadTerminalPanel = (overrides: Partial<Parameters<typeof createRightPanelState>[0]> = {}) =>
    createRightPanelState({
      visible: true,
      width: 520,
      tabInstances: [{ id: "singleton:terminal", type: "terminal" }],
      activeTabId: "singleton:terminal",
      ...overrides,
    });
  const terminalStrip = () => screen.getByRole("group", { name: "Terminals" });
  const tabLabels = (strip: HTMLElement) =>
    within(strip)
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("aria-pressed"))
      .map((button) => button.textContent);

  it("lists two shells and an action run as one Terminal entry with three row-1 tabs", () => {
    useWorkspaceStore.setState({ activeThreadId: "thread-1" });
    useProjectActionStore.getState().applyRun(buildRun({}));
    useDiffStore.setState({ rightPanelByThread: { "thread-1": threadTerminalPanel() } });
    useTerminalStore.setState({
      terminals: {
        "thread-1": [
          { id: "pty-1", threadId: "thread-1", label: "zsh" },
          { id: "pty-2", threadId: "thread-1", label: "zsh" },
          actionRecord,
        ],
      },
    });

    render(<RightPanel />);

    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-open-tabs", "terminal");
    expect(within(screen.getByTestId("panel-header-leading")).getByRole("group", { name: "Terminals" })).toBe(terminalStrip());
    expect(tabLabels(terminalStrip())).toEqual(["zsh (1)", "zsh (2)", "Build"]);
  });

  it("shows an action record's transcript and closing its tab stops it like any terminal", async () => {
    terminalKill.mockResolvedValue(undefined);
    useWorkspaceStore.setState({ activeThreadId: "thread-1" });
    useProjectActionStore.getState().applyRun(buildRun({}));
    useDiffStore.setState({ rightPanelByThread: { "thread-1": threadTerminalPanel() } });
    useTerminalStore.setState({ terminals: { "thread-1": [actionRecord] }, ptyToThread: { "pty-action": "thread-1" } });

    render(<RightPanel />);

    expect(screen.getByTestId("action-terminal:build")).toHaveTextContent("done");
    fireEvent.click(within(terminalStrip()).getByRole("button", { name: "Close Build" }));

    expect(terminalKill).toHaveBeenCalledWith("pty-action");
    await waitFor(() =>
      expect(useDiffStore.getState().getRightPanel("workspace-1", "thread-1").tabInstances).toEqual([]),
    );
    expect(useTerminalStore.getState().terminals["thread-1"] ?? []).toEqual([]);
    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build?.status).toBe("completed");
  });

  it.each([
    {
      name: "a hidden default panel",
      panel: { visible: false, activeTabId: null },
      activeTabId: null,
    },
    {
      name: "a visible panel with another active tab",
      panel: {
        tabInstances: [
          { id: "singleton:preview", type: "preview" as const },
          { id: "singleton:terminal", type: "terminal" as const },
        ],
        activeTabId: "singleton:preview",
      },
      activeTabId: "singleton:preview",
    },
  ])("keeps $name on its current surface until the Terminal tool is selected", ({ panel, activeTabId }) => {
    useWorkspaceStore.setState({ activeThreadId: "thread-1" });
    useProjectActionStore.getState().applyRun(buildRun({
      revision: 0,
      status: "running",
      finishedAt: null,
      exitCode: null,
      transcript: "running output",
    }));
    useDiffStore.setState({ rightPanelByThread: { "thread-1": threadTerminalPanel(panel) } });
    useTerminalStore.setState({ terminals: { "thread-1": [actionRecord] } });

    render(<RightPanel />);

    const activityRail = screen.getByTestId("activity-rail");
    if (activeTabId === null) {
      expect(activityRail).not.toHaveAttribute("data-active-tab-id");
    } else {
      expect(activityRail).toHaveAttribute("data-active-tab-id", activeTabId);
    }
    expect(screen.queryByTestId("action-terminal:build")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("select-singleton:terminal"));

    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-active-tab-id", "singleton:terminal");
    expect(screen.getByTestId("action-terminal:build")).toHaveTextContent("running output");
  });

  it("disables the round + at the record cap and explains why, counting action records", () => {
    const records = Array.from({ length: TERMINAL_MAX_PER_SCOPE - 1 }, (_, index) => ({
      id: `pty-${index}`,
      threadId: "thread-1",
      label: `Shell ${index}`,
    }));
    useWorkspaceStore.setState({ activeThreadId: "thread-1" });
    useDiffStore.setState({ rightPanelByThread: { "thread-1": threadTerminalPanel() } });
    useTerminalStore.setState({
      terminals: { "thread-1": [...records, actionRecord] },
      ptyToThread: Object.fromEntries([...records, actionRecord].map((record) => [record.id, "thread-1"])),
    });

    render(<RightPanel />);

    const add = within(terminalStrip().parentElement!).getByRole("button", { name: "New terminal" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).toHaveAccessibleDescription(TERMINAL_CAP_REASON);
    fireEvent.click(add);
    expect(createTerminalForScope).not.toHaveBeenCalled();
    expect(TERMINAL_CAP_REASON).toBe(`${TERMINAL_MAX_PER_SCOPE} terminals are open. Close one to open another.`);

    act(() => useTerminalStore.getState().removeTerminal("pty-0"));

    expect(add).not.toHaveAttribute("aria-disabled", "true");
    expect(add).not.toHaveAccessibleDescription(TERMINAL_CAP_REASON);
    fireEvent.click(add);
    expect(createTerminalForScope).toHaveBeenCalledWith("thread-1");
  });

  it("closes the Terminal tool when its last tab closes", async () => {
    terminalKill.mockResolvedValue(undefined);
    useWorkspaceStore.setState({ activeThreadId: "thread-1" });
    useDiffStore.setState({ rightPanelByThread: { "thread-1": threadTerminalPanel() } });
    useTerminalStore.setState({
      terminals: { "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "zsh" }] },
      ptyToThread: { "pty-1": "thread-1" },
    });

    render(<RightPanel />);
    fireEvent.click(within(terminalStrip()).getByRole("button", { name: "Close zsh" }));

    await waitFor(() => expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-open-tabs", ""));
    expect(terminalKill).toHaveBeenCalledWith("pty-1");
  });

  it("hides the Terminal tool from the rail without stopping its records", () => {
    useWorkspaceStore.setState({ activeThreadId: "thread-1" });
    useDiffStore.setState({ rightPanelByThread: { "thread-1": threadTerminalPanel() } });
    useTerminalStore.setState({ terminals: { "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "zsh" }] } });

    render(<RightPanel />);
    fireEvent.click(screen.getByTestId("close-singleton:terminal"));

    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-open-tabs", "");
    expect(terminalKill).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().terminals["thread-1"]).toHaveLength(1);
  });

  it("opens the Terminal tool in the background for a new record and closes it with the last one", () => {
    useWorkspaceStore.setState({ activeThreadId: "thread-1" });
    useDiffStore.setState({
      rightPanelByThread: {
        "thread-1": createRightPanelState({ visible: false, width: 400, openTabs: ["changes"], activeTab: "changes" }),
      },
    });
    useTerminalStore.setState({ hasHydrated: true });
    render(<RightPanel />);

    act(() => useTerminalStore.getState().addTerminal("thread-1", "pty-1", "zsh"));

    expect(useDiffStore.getState().getRightPanel("workspace-1", "thread-1")).toMatchObject({
      visible: false,
      width: 400,
      openTabs: ["changes", "terminal"],
      activeTab: "changes",
    });

    act(() => useTerminalStore.getState().removeTerminal("pty-1"));

    expect(useDiffStore.getState().getRightPanel("workspace-1", "thread-1").openTabs).toEqual(["changes"]);
  });

  it("lists three Browser pages as one Browser entry with three row-1 tabs", () => {
    const page = (id: string, title: string) => ({
      id,
      threadId: "workspace-1",
      title,
      url: "https://example.test",
      faviconUrl: null,
      warm: true,
      active: id === "page-2",
    });
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "page-2",
      tabs: [page("page-1", "One"), page("page-2", "Two"), page("page-3", "Three")],
    };
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({ visible: true, width: 400, openTabs: ["preview"], activeTab: "preview" }),
      },
    });

    render(<RightPanel />);
    const strip = screen.getByRole("group", { name: "Browser pages" });

    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-open-tabs", "preview");
    expect(tabLabels(strip)).toEqual(["One", "Two", "Three"]);
    expect(within(strip).getByRole("button", { name: "Two" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(strip).getByRole("button", { name: "Three" }));
    expect(activatePreviewPage).toHaveBeenCalledWith("workspace-1", "workspace-1", "page-3");
    fireEvent.click(screen.getByRole("button", { name: "New page" }));
    expect(openPreviewPage).toHaveBeenCalledWith("workspace-1", "workspace-1");
  });

  it("projects workspace panel state without Terminal instances when switching to an untouched thread", () => {
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 520,
          tabInstances: [
            { id: "singleton:changes", type: "changes" },
            { id: "singleton:terminal", type: "terminal" },
            { id: "singleton:preview", type: "preview" },
          ],
          activeTabId: "singleton:changes",
        }),
      },
    });
    useTerminalStore.setState({
      terminals: {
        "workspace-1": [
          { id: "workspace-pty-1", threadId: "workspace-1", label: "Build shell" },
          { id: "workspace-pty-2", threadId: "workspace-1", label: "Test shell" },
        ],
      },
    });

    const { rerender } = render(<RightPanel />);

    expect(screen.getByTestId("activity-rail")).toHaveAttribute(
      "data-open-tabs",
      "changes,terminal,preview",
    );

    act(() => useWorkspaceStore.setState({ activeThreadId: "thread-untouched" }));
    rerender(<RightPanel />);

    expect(screen.getByTestId("activity-rail")).toHaveAttribute(
      "data-open-tabs",
      "changes,preview",
    );
    expect(screen.getByTestId("activity-rail")).toHaveAttribute(
      "data-active-tab-id",
      "singleton:changes",
    );
  });

  it("preserves warm-scope identity when reconciliation changes nothing", () => {
    const scopes = [{ scopeId: "workspace-1", workspaceId: "workspace-1", lastUsedAt: 1 }];

    expect(reconcileWarmPreviewScopes(scopes, scopes[0]!, new Set())).toBe(scopes);
  });

  it("keeps equal scope ids from different workspaces as distinct warm surfaces", () => {
    const first = { scopeId: "shared-scope", workspaceId: "workspace-a", lastUsedAt: 1 };
    const second = { scopeId: "shared-scope", workspaceId: "workspace-b", lastUsedAt: 2 };

    expect(reconcileWarmPreviewScopes([first], second, new Set())).toEqual([second, first]);
  });

  it("puts the panel controls in row 1", () => {
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({ visible: true, width: 400 }),
      },
    });
    render(<RightPanel />);
    const row1 = screen.getByTestId("panel-header-row-1");

    expect(row1).toHaveClass("window-drag");
    expect(screen.getByTestId("panel-header-row-2")).toBeEmptyDOMElement();

    fireEvent.click(within(row1).getByRole("button", { name: "Expand" }));
    expect(useUiStore.getState().rightPanelMaximized).toBe(true);
    expect(within(row1).getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it.each([
    ["Windows caption buttons cover the rail's top strip", "win32", "panel-header-row-1"],
    ["Linux caption buttons cover the rail's top strip", "linux", "panel-header-row-1"],
    ["macOS leaves the rail's top strip free", "darwin", "activity-rail-caption-strip"],
    ["the browser build has no caption buttons", undefined, "activity-rail-caption-strip"],
  ])("places Close panel where %s", (_case, platform, hostTestId) => {
    const bridge = window.desktopBridge;
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { ...bridge, window: platform ? { platform } : undefined },
    });
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({ visible: true, width: 400 }),
      },
    });
    render(<RightPanel />);

    const toggles = screen.getAllByRole("button", { name: "Close panel" });
    expect(toggles).toHaveLength(1);
    expect(screen.getByTestId(hostTestId)).toContainElement(toggles[0]!);

    fireEvent.click(toggles[0]!);
    expect(toggleRightPanelAdaptive).toHaveBeenCalledWith("workspace-1", null);
  });

  it("gives the header rows only to the active tool", () => {
    useWorkspaceStore.setState({ activeThreadId: "thread-1" });
    const panel = (activeTabId: string) => ({
      rightPanelByThread: {
        "thread-1": createRightPanelState({
          visible: true,
          width: 400,
          tabInstances: [
            { id: "singleton:changes", type: "changes" as const },
            { id: "singleton:tasks", type: "tasks" as const },
          ],
          activeTabId,
        }),
      },
    });
    useDiffStore.setState(panel("singleton:changes"));
    render(<RightPanel />);
    const leading = screen.getByTestId("panel-header-leading");
    const row2 = screen.getByTestId("panel-header-row-2");

    expect(within(row2).getByTestId("review-controls")).toBeInTheDocument();
    expect(within(leading).queryByTestId("plan-header")).not.toBeInTheDocument();

    act(() => useDiffStore.setState(panel("singleton:tasks")));

    expect(within(leading).getByTestId("plan-header")).toBeInTheDocument();
    expect(row2).toBeEmptyDOMElement();
  });

  it("keeps a terminal tab open and shows a toast when stopping it fails", async () => {
    terminalKill.mockRejectedValue(new Error("pty is gone"));
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          tabInstances: [{ id: "singleton:terminal", type: "terminal" }],
          activeTabId: "singleton:terminal",
        }),
      },
    });
    useTerminalStore.setState({
      terminals: { "workspace-1": [{ id: "pty-1", threadId: "workspace-1", label: "Shell" }] },
    });
    useToastStore.setState({ toasts: [] });
    render(<RightPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Close Shell" }));

    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]).toMatchObject({
        kind: "failed",
        title: "Couldn't close terminal",
        meta: "pty is gone",
      }),
    );
    expect(terminalKill).toHaveBeenCalledWith("pty-1");
    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-open-tabs", "terminal");
  });

  it("releases focus before making the right panel inert", () => {
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({ visible: true, width: 400 }),
      },
    });
    render(<RightPanel />);
    const toggle = screen.getByRole("button", { name: "Close panel" });
    toggle.focus();
    expect(toggle).toHaveFocus();

    act(() => useDiffStore.getState().hideRightPanel("workspace-1"));

    expect(toggle).not.toHaveFocus();
    expect(screen.getByTestId("right-panel")).toHaveAttribute("inert");
    expect(screen.getByTestId("right-panel")).not.toHaveAttribute("aria-hidden");
  });

  it("does not create a stacking context while visible", () => {
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({ visible: true, width: 400 }),
      },
    });

    render(<RightPanel />);

    // Any translate, including translate-x-0, traps Design overlays below the
    // body-level Browser surface host that paints the hosted page.
    expect(screen.getByTestId("right-panel").className).not.toMatch(/(^|\s)-?translate-/);
  });

  it("renders coordination content for an open active thread tab", () => {
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1", activeThreadId: "thread-1" });
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: ["coordination"],
          activeTab: "coordination",
        }),
      },
    });

    render(<RightPanel />);

    expect(screen.getByTestId("coordination-panel-integration")).toHaveTextContent("workspace-1:thread-1");
  });

  it("keeps an idle existing Browser page behind the default panel screen", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Background page",
        url: "https://example.test",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };

    render(<RightPanel />);
    expect(useDiffStore.getState().getRightPanelVisible("workspace-1")).toBe(false);
    expect(useDiffStore.getState().getRightPanel("workspace-1").openTabs).toEqual([]);

    act(() => useDiffStore.getState().showRightPanel("workspace-1"));

    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-open-tabs", "");
    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
    expect(useDiffStore.getState().getRightPanel("workspace-1")).toMatchObject({
      visible: true,
      openTabs: [],
    });
    expect(activatePreviewPage).not.toHaveBeenCalled();
  });

  it("restores an explicitly retained Browser tab when the hidden panel had no active instance", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Background page",
        url: "https://example.test",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: false,
          width: 400,
          tabInstances: [{ id: "singleton:preview", type: "preview" }],
          activeTabId: null,
        }),
      },
    });
    render(<RightPanel />);
    act(() => useDiffStore.getState().showRightPanel("workspace-1"));

    expect(screen.queryByTestId("panel-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    expect(useDiffStore.getState().getRightPanel("workspace-1")).toMatchObject({
      visible: true,
      openTabs: ["preview"],
      activeTab: "preview",
    });
    expect(activatePreviewPage).not.toHaveBeenCalled();
  });

  it("reveals an agent-created page while its Browser bootstrap is pending", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "default-browser-tab",
      tabs: [
        {
          id: "default-browser-tab",
          threadId: "workspace-1",
          title: "New page",
          url: null,
          faviconUrl: null,
          warm: true,
          active: true,
        },
        {
          id: "agent-browser-tab",
          threadId: "workspace-1",
          title: "Agent page",
          url: "https://example.test",
          faviconUrl: null,
          warm: true,
          active: false,
        },
      ],
    };
    useBrowserAutomationStore.setState({
      pendingAgentOpens: new Map([
        [
          "pending-browser-open",
          {
            workspaceId: "workspace-1",
            threadId: "workspace-1",
            tabId: "agent-browser-tab",
            url: "https://example.test",
            startedAt: 2,
          },
        ],
      ]),
    });

    render(<RightPanel />);
    act(() => useDiffStore.getState().showRightPanel("workspace-1"));

    expect(screen.queryByTestId("panel-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-open-tabs", "preview");
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    expect(activatePreviewPage).toHaveBeenCalledWith(
      "workspace-1",
      "workspace-1",
      "agent-browser-tab",
    );
    const agentTab = screen.getByRole("group", { name: "Browser pages" }).querySelector<HTMLElement>('[data-panel-tab="agent-browser-tab"]');
    expect(agentTab).not.toBeNull();
    expect(within(agentTab!).getByTestId("browser-agent-control-indicator")).toHaveClass("text-primary");
  });

  it("switches an already-open panel to an agent-created Browser page", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "existing-browser-tab",
      tabs: [
        {
          id: "existing-browser-tab",
          threadId: "workspace-1",
          title: "Existing page",
          url: "https://existing.example.test",
          faviconUrl: null,
          warm: true,
          active: true,
        },
        {
          id: "agent-browser-tab",
          threadId: "workspace-1",
          title: "Agent page",
          url: "https://example.test",
          faviconUrl: null,
          warm: true,
          active: false,
        },
      ],
    };
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: ["tasks"],
          activeTab: "tasks",
        }),
      },
    });
    useBrowserAutomationStore.setState({
      pendingAgentOpens: new Map([
        [
          "pending-browser-open",
          {
            workspaceId: "workspace-1",
            threadId: "workspace-1",
            tabId: "agent-browser-tab",
            url: "https://example.test",
            startedAt: 2,
          },
        ],
      ]),
    });

    const { rerender } = render(<RightPanel />);

    expect(screen.getByTestId("activity-rail")).toHaveAttribute(
      "data-open-tabs",
      "tasks,preview",
    );
    expect(screen.getByTestId("activity-rail")).toHaveAttribute(
      "data-active-tab-id",
      "singleton:preview",
    );
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    expect(useDiffStore.getState().getRightPanel("workspace-1")).toMatchObject({
      openTabs: ["tasks", "preview"],
      activeTab: "preview",
    });
    expect(activatePreviewPage).toHaveBeenCalledWith(
      "workspace-1",
      "workspace-1",
      "agent-browser-tab",
    );

    rerender(<RightPanel />);

    expect(activatePreviewPage).toHaveBeenCalledTimes(1);
  });

  it("does not re-open Browser while the final page close callback is synchronous", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Closing page",
        url: "https://example.test",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: ["preview"],
          activeTab: "preview",
        }),
      },
    });
    closePreviewPage.mockImplementation((
      _workspaceId: string,
      _scopeId: string,
      _tabId: string,
      options: { onLastClose?: () => void },
    ) => {
      previewTabSet.current = null;
      options.onLastClose?.();
    });

    render(<RightPanel />);
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Closing page" }));

    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
    expect(useDiffStore.getState().getRightPanel("workspace-1").openTabs).toEqual([]);
    expect(activatePreviewPage).not.toHaveBeenCalled();
  });

  it("covers the visible Browser edge without changing its layout geometry", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Visible page",
        url: "https://example.test",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: ["preview"],
          activeTab: "preview",
        }),
      },
    });

    render(<RightPanel />);
    expect(screen.getByTestId("preview-panel")).toHaveAttribute(
      "data-covered-right",
      "0",
    );

    fireEvent.click(screen.getByTestId("expand-activity-rail"));

    expect(browserSurfacePresentationCoordinator.getActivityRailOverlap()).toBe(112);
  });

  it("publishes the covered edge on the automation Browser dock", async () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Visible page",
        url: "https://example.test",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: ["preview"],
          activeTab: "preview",
        }),
      },
    });
    useBrowserAutomationStore.setState({
      hostedScopeIds: new Set([browserAutomationScopeKey("workspace-1", "workspace-1")]),
    });

    render(<RightPanel />);
    await waitFor(() => expect(screen.queryByTestId("automation-preview-dock")).not.toBeNull());
    const dock = screen.getByTestId("automation-preview-dock");
    expect(dock).not.toBeNull();
    expect(browserSurfacePresentationCoordinator.getActivityRailOverlap()).toBe(0);

    fireEvent.click(screen.getByTestId("expand-activity-rail"));

    await waitFor(() => expect(browserSurfacePresentationCoordinator.getActivityRailOverlap()).toBe(112));
  });

  it("does not render the active Browser surface for another scope's request", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Visible page",
        url: "https://example.test",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: ["preview"],
          activeTab: "preview",
        }),
      },
    });
    render(<RightPanel />);
    const renderCount = previewPanelRender.mock.calls.length;

    act(() => useBrowserAutomationStore.setState({
      activeRequests: new Map([
        [
          "other-scope-request",
          {
            dispatch: {
              request: { workspaceId: "workspace-1" },
              target: { threadId: "other-scope", tabId: "other-tab" },
            },
            startedAt: 2,
          } as never,
        ],
      ]),
    }));

    expect(previewPanelRender).toHaveBeenCalledTimes(renderCount);
  });

  it("keeps a closed Browser scope warm while its active request settles", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Busy page",
        url: "https://example.test",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: ["preview"],
          activeTab: "preview",
        }),
      },
    });
    useBrowserAutomationStore.setState({
      activeRequests: new Map([
        [
          "active-browser-request",
          {
            dispatch: {
              request: { workspaceId: "workspace-1" },
              target: { threadId: "workspace-1", tabId: "browser-tab-1" },
            },
            startedAt: 2,
          } as never,
        ],
      ]),
    });
    closePreviewPage.mockImplementation((
      _workspaceId: string,
      _scopeId: string,
      _tabId: string,
      options: { onLastClose?: () => void },
    ) => {
      previewTabSet.current = null;
      options.onLastClose?.();
    });

    render(<RightPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Close Busy page" }));

    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    expect(screen.getByTestId("preview-panel").parentElement).toHaveClass("hidden");

    act(() => useBrowserAutomationStore.setState({ activeRequests: new Map() }));

    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
  });

  it("keeps an ordinary host-published Browser page behind the default screen", () => {
    const { rerender } = render(<RightPanel />);

    act(() => useDiffStore.getState().showRightPanel("workspace-1"));
    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();

    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Background page",
        url: "https://example.test",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };
    rerender(<RightPanel />);

    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
    expect(useDiffStore.getState().getRightPanel("workspace-1")).toMatchObject({
      visible: true,
      openTabs: [],
    });
    expect(activatePreviewPage).not.toHaveBeenCalled();
  });

  it("does not reveal an ordinary Electron-created Browser page from a host update", async () => {
    const { rerender } = render(<RightPanel />);

    act(() => useDiffStore.getState().showRightPanel("workspace-1"));
    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();

    await waitFor(() => expect(previewTabsBridge.updatedListener.current).toBeTypeOf("function"));
    act(() => {
      previewTabsBridge.updatedListener.current?.({
        threadId: "workspace-1",
        activeTabId: "browser-tab-1",
        tabs: [{
          id: "browser-tab-1",
          threadId: "workspace-1",
          title: "Agent page",
          url: "https://example.test",
          faviconUrl: null,
          warm: true,
          active: true,
        }],
      });
    });
    rerender(<RightPanel />);

    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
    expect(activatePreviewPage).not.toHaveBeenCalled();
  });

  it("keeps an already-visible default screen after ordinary Electron publication", async () => {
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: [],
        }),
      },
    });
    const { rerender } = render(<RightPanel />);
    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();

    await waitFor(() => expect(previewTabsBridge.updatedListener.current).toBeTypeOf("function"));
    act(() => {
      previewTabsBridge.updatedListener.current?.({
        threadId: "workspace-1",
        activeTabId: "browser-tab-1",
        tabs: [{
          id: "browser-tab-1",
          threadId: "workspace-1",
          title: "Agent page",
          url: "https://example.test",
          faviconUrl: null,
          warm: true,
          active: true,
        }],
      });
    });
    rerender(<RightPanel />);

    expect(screen.getByTestId("panel-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
    expect(activatePreviewPage).not.toHaveBeenCalled();
  });

  it("does not let a background Browser page alter an existing active panel tab", () => {
    previewTabSet.current = {
      threadId: "workspace-1",
      activeTabId: "browser-tab-1",
      tabs: [{
        id: "browser-tab-1",
        threadId: "workspace-1",
        title: "Background page",
        url: "https://example.test",
        faviconUrl: null,
        warm: true,
        active: true,
      }],
    };
    useDiffStore.setState({
      rightPanelFallbackByWorkspace: {
        "workspace-1": createRightPanelState({
          visible: true,
          width: 400,
          openTabs: ["changes"],
          activeTab: "changes",
        }),
      },
    });

    render(<RightPanel />);

    expect(screen.queryByTestId("panel-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("activity-rail")).toHaveAttribute("data-open-tabs", "changes");
    expect(useDiffStore.getState().getRightPanel("workspace-1").activeTab).toBe("changes");
    expect(activatePreviewPage).not.toHaveBeenCalled();
  });
});
