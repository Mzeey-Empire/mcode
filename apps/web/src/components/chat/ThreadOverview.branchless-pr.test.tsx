import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  GitRef,
  WorkspaceEnvironmentActionRun,
  WorkspaceEnvironmentAutomaticSetupSnapshot,
} from "@mcode/contracts";
import type { Thread } from "@/transport";
import { useOverviewStore } from "@/stores/overviewStore";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import {
  browserAutomationLifecycleKey,
  browserAutomationTargetKey,
  useBrowserAutomationStore,
} from "@/features/preview";
import { previewTabsScopeKey, usePreviewTabsStore } from "@/features/preview/state/previewTabsStore";
import type { BrowserSessionLifecycleTab } from "@/features/preview";
import { createRightPanelState, useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { setLayoutMeasurements } from "@/lib/composer-layout";
import { invalidateBranchTargets } from "@/features/conversation/composer/execution/targets/useBranchTargets";

const {
  mockCreateBranch,
  mockGetAutomaticSetup,
  mockGetRightPanelVisible,
  mockGetReviewComparison,
  mockGetReviewState,
  mockGetWorkspaceSetupAttempt,
  mockListRefs,
  mockListWorkspaceActionRuns,
  mockOpenSubagentsPanel,
  mockReadWorkspaceEnvironment,
  mockSaveWorkspaceEnvironment,
  mockStartWorkspaceAction,
  mockStartWorkspaceSetup,
  mockThreadRecords,
  mockWorkspaceState,
} = vi.hoisted(() => ({
  mockCreateBranch: vi.fn(),
  mockGetAutomaticSetup: vi.fn(),
  mockGetRightPanelVisible: vi.fn(),
  mockGetReviewComparison: vi.fn(),
  mockGetReviewState: vi.fn(),
  mockGetWorkspaceSetupAttempt: vi.fn(),
  mockListRefs: vi.fn(),
  mockListWorkspaceActionRuns: vi.fn(),
  mockOpenSubagentsPanel: vi.fn(),
  mockReadWorkspaceEnvironment: vi.fn(),
  mockSaveWorkspaceEnvironment: vi.fn(),
  mockStartWorkspaceAction: vi.fn(),
  mockStartWorkspaceSetup: vi.fn(),
  mockThreadRecords: new Map<string, ThreadRecord>(),
  mockWorkspaceState: {
    workspaces: [{ id: "ws-1", path: "/repo" }],
    threads: [] as Thread[],
    prUrlsByThreadId: {},
    checksById: {},
    worktreesLoadedForWorkspace: null as string | null,
  },
}));

vi.mock("@/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport")>();
  return {
    ...actual,
    getTransport: () => ({
      createBranch: mockCreateBranch,
      listSnapshots: vi.fn().mockResolvedValue([]),
      getReviewComparison: mockGetReviewComparison,
      getReviewState: mockGetReviewState,
      listRefs: mockListRefs,
      getBranchComparison: vi.fn().mockResolvedValue(null),
      getRemoteUrl: vi.fn().mockResolvedValue({ label: "repo", webUrl: null }),
      getAutomaticSetup: mockGetAutomaticSetup,
      getWorkspaceSetupAttempt: mockGetWorkspaceSetupAttempt,
      readWorkspaceEnvironment: mockReadWorkspaceEnvironment,
      saveWorkspaceEnvironment: mockSaveWorkspaceEnvironment,
      listWorkspaceActionRuns: mockListWorkspaceActionRuns,
      startWorkspaceAction: mockStartWorkspaceAction,
      startWorkspaceSetup: mockStartWorkspaceSetup,
    }),
  };
});

vi.mock("@/hooks/useBranchPr", () => ({
  useBranchPr: vi.fn().mockReturnValue(null),
}));

vi.mock("@/hooks/useHasCommitsAhead", () => ({
  useHasCommitsAhead: vi.fn().mockReturnValue(null),
}));

vi.mock("@/stores/composerDraftStore", () => ({
  useComposerDraftStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({ setPendingPrefill: vi.fn() }),
  ),
}));

vi.mock("@/features/projects/state/workspaceStore", () => {
  const store = Object.assign(
    vi.fn((selector: (state: unknown) => unknown) => selector(mockWorkspaceState)),
    {
      setState: vi.fn((updater: unknown) => {
        const patch =
          typeof updater === "function"
            ? (updater as (state: typeof mockWorkspaceState) => Partial<typeof mockWorkspaceState>)(
                mockWorkspaceState,
              )
            : updater;
        Object.assign(mockWorkspaceState, patch);
      }),
      getState: vi.fn(() => mockWorkspaceState),
    },
  );
  return { useWorkspaceStore: store };
});

vi.mock("@/stores/diffStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/diffStore")>();
  const mockState = {
    snapshotsByThread: {},
    diffRevisionByScope: {},
    getRightPanelVisible: mockGetRightPanelVisible,
    getRightPanel: vi.fn().mockReturnValue({ width: 380 }),
    setSnapshots: vi.fn(),
  };
  const selector = vi.fn((select: (state: typeof mockState) => unknown) => select(mockState));
  Object.assign(selector, actual.useDiffStore);
  return {
    ...actual,
    useDiffStore: selector,
  };
});

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({ records: mockThreadRecords, fetchProviderUsage: vi.fn() }),
  ),
}));

vi.mock("@/features/subagents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/subagents")>()),
  openSubagentsRoster: mockOpenSubagentsPanel,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("./CreatePrDialog", () => ({
  CreatePrDialog: ({
    open,
    branch,
    preferredBaseBranch,
  }: {
    open: boolean;
    branch: string;
    preferredBaseBranch?: string | null;
  }) =>
    open ? (
      <div data-testid="create-pr-dialog">
        <span data-testid="create-pr-branch">{branch}</span>
        <span data-testid="create-pr-base">{preferredBaseBranch}</span>
      </div>
    ) : null,
}));

import { getThreadOverviewBrowserTabs } from "@/features/thread-overview/entries/browser";
import { ThreadOverview } from "./ThreadOverview";
import { canStartBranchlessCreatePr } from "@/features/thread-overview/branch-creation";
import { ProjectEnvironmentPanel } from "@/features/projects/environment";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    workspace_id: "ws-1",
    title: "Branchless",
    status: "active",
    mode: "worktree",
    worktree_path: "/repo/.worktrees/branchless",
    branch: "main",
    checkout_state: "branchless",
    base_branch: "main",
    worktree_managed: true,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    sdk_session_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    model: null,
    provider: "claude",
    deleted_at: null,
    user_completed_at: null,
    scheduled_deletion_at: null,
    cleanup_state: null,
    cleanup_reason: null,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    orchestration_mode: null,
    permission_mode: null,
    context_window_mode: null,
    thinking: null,
    codex_fast_mode: null,
    devin_mode: null,
    default_open_in_app: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    last_compact_summary: null,
    has_file_changes: false,
    ...overrides,
  };
}

function gitRef(shortName: string, overrides: Partial<GitRef> = {}): GitRef {
  return {
    kind: "ref",
    fullName: `refs/heads/${shortName}`,
    shortName,
    branchName: shortName,
    remote: null,
    twin: null,
    isCurrent: false,
    isDefault: false,
    worktree: null,
    headSha: "a".repeat(40),
    committedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

function refsPage(items: GitRef[]) {
  return { ok: true, items, total: items.length, nextCursor: null };
}

function runningActionRun(): WorkspaceEnvironmentActionRun {
  return {
    threadId: "thread-1",
    workspaceId: "ws-1",
    actionId: "success",
    runId: "run-1",
    revision: 0,
    terminalSessionId: "terminal-1",
    trigger: "manual",
    actionName: "Success",
    status: "running",
    snapshot: {
      platform: "windows",
      script: "bun run success",
      checkoutPath: "C:\\repo",
      terminal: { executable: "powershell.exe", arguments: ["-Command", "bun run success"] },
      environmentNames: ["PATH"],
    },
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: "2026-08-22T12:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    transcript: "",
    transcriptTruncated: false,
  };
}

describe("ThreadOverview branchless Create PR", () => {
  beforeEach(() => {
    const thread = makeThread();
    mockWorkspaceState.threads = [thread];
    mockWorkspaceState.prUrlsByThreadId = {};
    mockWorkspaceState.checksById = {};
    mockWorkspaceState.worktreesLoadedForWorkspace = "ws-1";
    mockCreateBranch.mockReset().mockResolvedValue({ branch: "feat/issue-801" });
    mockGetAutomaticSetup.mockReset();
    mockGetRightPanelVisible.mockReset().mockReturnValue(false);
    mockGetReviewComparison.mockReset().mockResolvedValue({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } });
    mockGetReviewState.mockReset().mockResolvedValue({ isGitRepo: false });
    mockGetWorkspaceSetupAttempt.mockReset().mockResolvedValue(null);
    invalidateBranchTargets("ws-1");
    mockListRefs.mockReset().mockResolvedValue(refsPage([
      gitRef("main", { isCurrent: true, isDefault: true }),
      gitRef("feature/other"),
      gitRef("origin/other", { fullName: "refs/remotes/origin/other", branchName: "other", remote: "origin" }),
    ]));
    mockListWorkspaceActionRuns.mockReset().mockResolvedValue([]);
    mockReadWorkspaceEnvironment.mockReset().mockResolvedValue({
      document: {
        version: "0.0.1",
        setup: { default: "bun run setup" },
        actions: [{ id: "success", name: "Success", command: { default: "bun run success" } }],
      },
    });
    mockSaveWorkspaceEnvironment.mockReset();
    mockStartWorkspaceAction.mockReset().mockResolvedValue(runningActionRun());
    mockStartWorkspaceSetup.mockReset();
    mockOpenSubagentsPanel.mockReset();
    mockThreadRecords.clear();
    useBrowserAutomationStore.setState({
      liveTargets: new Map(),
      lifecycleTabs: new Map(),
      controllers: new Map(),
    });
    usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {}, persistentTabIdsByScope: {} });
    useOverviewStore.setState({ closedSubjects: new Set(), overlaySubject: null, requestedSubject: null });
    useDiffStore.setState({ rightPanelByThread: {}, rightPanelFallbackByWorkspace: {} });
    useProjectActionStore.setState({ runsByThread: {} });
    setLayoutMeasurements(1200, 1200);
  });

  it("docks the card open beside a canvas with room, and closes it from the button", async () => {
    const user = userEvent.setup();
    render(<ThreadOverview thread={makeThread()} threadPaneWidth={1400} />);

    expect(screen.getByTestId("header-overview-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("thread-overview-card")).toHaveAttribute("data-presentation", "docked");

    await user.click(screen.getByTestId("header-overview-toggle"));
    expect(screen.getByTestId("header-overview-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument();
  });

  it("loads untracked changes from the branchless checkout comparison", async () => {
    mockGetReviewComparison.mockResolvedValue({ status: "ready", comparison: {
      files: [{ path: "notes.md", previousPath: null, changeType: "added", binary: false, additions: 4, deletions: 0, untracked: true }],
      additions: 4, deletions: 0,
    } });
    render(<ThreadOverview thread={makeThread()} threadPaneWidth={1400} />);
    expect(await screen.findByTestId("thread-overview-change-summary")).toHaveAttribute("aria-label", "4 additions, 0 deletions");
    expect(mockGetReviewComparison).toHaveBeenCalledWith({
      workspaceId: "ws-1", threadId: "thread-1", view: "uncommitted",
    });
    expect(mockGetReviewState).not.toHaveBeenCalled();
  });

  it("says the Changes row is unavailable when its comparison fails", async () => {
    mockGetReviewComparison.mockResolvedValue({
      status: "failed", failure: { kind: "git-error", summary: "Git reported an error", detail: "fatal" },
    });
    render(<ThreadOverview thread={makeThread()} threadPaneWidth={1400} />);
    expect(await screen.findByTestId("thread-overview-change-failed")).toHaveTextContent("Unavailable");
    expect(screen.queryByTestId("thread-overview-change-loading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-overview-change-summary")).not.toBeInTheDocument();
  });

  it("keeps branch choices when the uncommitted comparison fails", async () => {
    mockGetReviewComparison.mockRejectedValue(new Error("Comparison unavailable"));
    const user = userEvent.setup();
    render(<ThreadOverview thread={makeThread({ checkout_state: "named" })} threadPaneWidth={1400} />);
    await user.click(screen.getByTestId("workspace-menu-branch"));
    expect(await screen.findByRole("button", { name: "feature/other" })).toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-current-branch")).toHaveTextContent("main");
    expect(screen.queryByText("Branches unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText(/Uncommitted:/)).not.toBeInTheDocument();
  });

  it("lists the checkout's local branches and searches them on the server", async () => {
    const user = userEvent.setup();
    render(<ThreadOverview thread={makeThread({ checkout_state: "named" })} threadPaneWidth={1400} />);
    await user.click(screen.getByTestId("workspace-menu-branch"));

    expect(await screen.findByRole("button", { name: "feature/other" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "origin/other" })).not.toBeInTheDocument();
    expect(mockListRefs).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", threadId: "thread-1", purpose: "new-thread" }),
    );

    mockListRefs.mockResolvedValue(refsPage([gitRef("feature/other")]));
    await user.type(screen.getByLabelText("Search branches"), "feat");

    await waitFor(() => expect(mockListRefs).toHaveBeenCalledWith(expect.objectContaining({ query: "feat" })));
    const list = screen.getByTestId("thread-overview-branch-list");
    await waitFor(() => expect(within(list).queryByRole("button", { name: "main" })).not.toBeInTheDocument());
    expect(within(list).getByRole("button", { name: "feature/other" })).toBeInTheDocument();
  });

  it("keeps the checkout's branch and says the list is unavailable when listing fails", async () => {
    mockListRefs.mockResolvedValue({ ok: false, error: { code: "git_failed", message: "Could not list targets" } });
    const user = userEvent.setup();
    render(<ThreadOverview thread={makeThread({ checkout_state: "named" })} threadPaneWidth={1400} />);
    await user.click(screen.getByTestId("workspace-menu-branch"));

    expect(await screen.findByText("Branches unavailable")).toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-current-branch")).toHaveTextContent("main");
  });

  it("uses the state probe's detached comparison when the worktree is clean", async () => {
    mockGetReviewState.mockResolvedValue({
      isGitRepo: true, head: "abc123", branch: null,
      uncommitted: { staged: 0, unstaged: 0, untracked: 0 },
      commitsAhead: { count: 1, base: "main" }, branchDefault: { base: "main", compare: "HEAD" },
    });
    mockGetReviewComparison
      .mockResolvedValueOnce({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } })
      .mockResolvedValue({ status: "ready", comparison: { files: [{ path: "existing.md", previousPath: null, changeType: "modified", binary: false, additions: 3, deletions: 1, untracked: false }], additions: 3, deletions: 1 } });
    render(<ThreadOverview thread={makeThread()} threadPaneWidth={1400} />);
    expect(await screen.findByTestId("thread-overview-change-summary")).toHaveAttribute("aria-label", "3 additions, 1 deletions");
    expect(mockGetReviewState).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(mockGetReviewComparison).toHaveBeenLastCalledWith({
      workspaceId: "ws-1", threadId: "thread-1", view: "branch", base: "main", target: "HEAD",
    });
  });

  it("docks only from the minimum canvas width", () => {
    const overview = render(<ThreadOverview thread={makeThread()} threadPaneWidth={896} />);
    expect(screen.getByTestId("thread-overview-card")).toHaveAttribute("data-presentation", "docked");

    overview.rerender(<ThreadOverview thread={makeThread()} threadPaneWidth={895} />);
    expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("header-overview-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("gives way to the right panel and docks again when it closes", () => {
    const thread = makeThread();
    const overview = render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    mockGetRightPanelVisible.mockReturnValue(true);
    overview.rerender(<ThreadOverview thread={thread} threadPaneWidth={1000} />);
    expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("header-overview-toggle")).toHaveAttribute("aria-pressed", "false");

    mockGetRightPanelVisible.mockReturnValue(false);
    overview.rerender(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    expect(screen.getByTestId("thread-overview-card")).toHaveAttribute("data-presentation", "docked");
  });

  it("keeps the user's close after the right panel opens and closes", async () => {
    const user = userEvent.setup();
    const thread = makeThread();
    const overview = render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    await user.click(screen.getByTestId("header-overview-toggle"));

    mockGetRightPanelVisible.mockReturnValue(true);
    overview.rerender(<ThreadOverview thread={thread} threadPaneWidth={1000} />);
    mockGetRightPanelVisible.mockReturnValue(false);
    overview.rerender(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    expect(screen.queryByTestId("thread-overview-card")).not.toBeInTheDocument();
  });

  it("shows a requested Overview as an overlay where the card cannot dock", async () => {
    useOverviewStore.getState().requestOpen("thread-1");
    render(<ThreadOverview thread={makeThread()} threadPaneWidth={800} />);

    expect(await screen.findByTestId("thread-overview-card")).toHaveAttribute("data-presentation", "overlay");
    expect(useOverviewStore.getState().requestedSubject).toBeNull();
  });

  it("launches an idle Action in the background, then focuses its retained terminal", async () => {
    const user = userEvent.setup();
    useDiffStore.setState({
      rightPanelByThread: {
        "thread-1": createRightPanelState({
          visible: true,
          width: 380,
          tabInstances: [{ id: "singleton:preview", type: "preview" }],
          activeTabId: "singleton:preview",
        }),
      },
    });

    render(<ThreadOverview thread={makeThread({ mode: "direct" })} threadPaneWidth={1400} />);

    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    const action = await screen.findByTestId("project-action-success");
    await user.click(action);

    await waitFor(() => expect(mockStartWorkspaceAction).toHaveBeenCalledWith("thread-1", "success"));
    await waitFor(() => expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
      visible: true,
      activeTabId: "singleton:preview",
      tabInstances: expect.arrayContaining([{ id: "action-terminal:success", type: "action-terminal" }]),
    }));

    await user.click(action);

    await waitFor(() => expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
      visible: true,
      activeTabId: "action-terminal:success",
      width: 600,
    }));
  });

  it("refreshes the mounted Action menu after Project settings save", async () => {
    const user = userEvent.setup();
    let persisted = {
      document: {
        version: "0.0.1" as const,
        actions: [{ id: "success", name: "Success", command: { default: "bun run success" } }],
      },
      revision: "revision-1",
      status: "present" as const,
    };
    mockReadWorkspaceEnvironment.mockImplementation(async () => persisted);
    mockSaveWorkspaceEnvironment.mockImplementation(async (
      _workspaceId: string,
      document: typeof persisted.document,
    ) => {
      persisted = { document, revision: "revision-2", status: "present" };
      return persisted;
    });

    render(<><ThreadOverview thread={makeThread({ mode: "direct" })} threadPaneWidth={1400} /><ProjectEnvironmentPanel workspaceId="ws-1" /></>);

    await screen.findByLabelText("Action name for Success");
    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    expect(await screen.findByRole("menuitem", { name: /Success/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const actionName = screen.getByLabelText("Action name for Success");
    await user.clear(actionName);
    await user.type(actionName, "Renamed Action");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockSaveWorkspaceEnvironment).toHaveBeenCalledOnce());
    await waitFor(() => expect(mockReadWorkspaceEnvironment).toHaveBeenCalledTimes(3));

    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    expect(await screen.findByRole("menuitem", { name: /Renamed Action/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Success/ })).not.toBeInTheDocument();
  });

  it("renders navigated live Browser rows and reveals the exact tab without navigation", async () => {
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
    const thread = makeThread();
    const rows = getThreadOverviewBrowserTabs({
      workspaceId: thread.workspace_id,
      threadId: thread.id,
      tabSet: usePreviewTabsStore.getState().tabSetByScope[
        previewTabsScopeKey(thread.workspace_id, thread.id)
      ] ?? null,
      lifecycleTabs: useBrowserAutomationStore.getState().lifecycleTabs,
      liveTargets: useBrowserAutomationStore.getState().liveTargets,
      controllers: useBrowserAutomationStore.getState().controllers,
    });
    expect(rows.map((row) => row.tab.id)).toEqual(["agent-tab", "claimed-tab", "ordinary-tab"]);

    const showRightPanel = vi.spyOn(useDiffStore.getState(), "showRightPanel");
    const setRightPanelTab = vi.spyOn(useDiffStore.getState(), "setRightPanelTab");
    const activatePage = vi.spyOn(usePreviewTabsStore.getState(), "activatePage");
    const navigate = (useWorkspaceStore as unknown as { setState: ReturnType<typeof vi.fn> }).setState;
    navigate.mockClear();
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    const agentRow = screen.getByRole("button", { name: /Browser, Agent page/ });
    const user = userEvent.setup();
    expect(agentRow).toHaveAttribute("type", "button");
    expect(agentRow).toHaveAccessibleName(expect.stringContaining("agent controls"));
    expect(agentRow.querySelector('[data-testid="thread-overview-browser-agent-cursor"]')).toBeInTheDocument();
    act(() => {
      useBrowserAutomationStore.getState().setControllerForTarget("ws-1", "thread-1", "agent-tab", {
        tabId: "agent-tab",
        controller: "human",
        controlEpoch: 2,
      });
    });
    expect(agentRow.querySelector('[data-testid="thread-overview-browser-agent-cursor"]')).not.toBeInTheDocument();
    const claimedRow = screen.getByRole("button", { name: /Browser, Claimed page/ });
    expect(claimedRow).toBeInTheDocument();
    expect(claimedRow.querySelector('[data-testid="thread-overview-browser-agent-cursor"]')).not.toBeInTheDocument();
    expect(claimedRow.querySelector('img[src="https://claimed.test/favicon.ico"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Browser, Ordinary page/ })).toBeInTheDocument();
    expect(screen.getByTestId("thread-overview-browser-address-agent-tab")).toHaveClass("text-fade");

    agentRow.focus();
    await user.keyboard("{Enter}");
    expect(showRightPanel).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(setRightPanelTab).toHaveBeenCalledWith("ws-1", "thread-1", "preview");
    expect(activatePage).toHaveBeenCalledWith("ws-1", "thread-1", "agent-tab");
    expect(navigate).not.toHaveBeenCalled();

    act(() => useBrowserAutomationStore.getState().detachTarget("ws-1", "thread-1", "agent-tab"));
    expect(screen.queryByRole("button", { name: /Browser, Agent page/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Browser, Claimed page/ })).toBeInTheDocument();

    act(() => useBrowserAutomationStore.getState().setLifecycleTabs([claimedTab]));
    expect(screen.queryByRole("button", { name: /Browser, Agent page/ })).not.toBeInTheDocument();

    act(() => useBrowserAutomationStore.setState({ registered: false, status: "unavailable" }));
    expect(screen.queryByTestId("thread-overview-browser")).not.toBeInTheDocument();
  });

  it.each([
    ["a Direct Thread", { mode: "direct" }],
    ["an unmanaged Existing worktree", { mode: "worktree", worktree_managed: false }],
  ] as const)("shows and starts configured manual Setup from Project Actions for %s", async (_label, thread) => {
    const user = userEvent.setup();
    render(<ThreadOverview thread={makeThread(thread)} threadPaneWidth={1400} />);

    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Run Setup" }));

    await waitFor(() => expect(mockStartWorkspaceSetup).toHaveBeenCalledWith("thread-1"));
  });

  it("hides Run Setup for an eligible Thread without a saved Setup command", async () => {
    const user = userEvent.setup();
    mockReadWorkspaceEnvironment.mockResolvedValue({
      document: {
        version: "0.0.1",
        actions: [{ id: "success", name: "Success", command: { default: "bun run success" } }],
      },
    });
    render(<ThreadOverview thread={makeThread({ mode: "direct" })} threadPaneWidth={1400} />);

    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    await screen.findByRole("menuitem", { name: /Success/ });
    expect(screen.queryByRole("menuitem", { name: "Run Setup" })).not.toBeInTheDocument();
  });

  it("keeps Project Actions but hides configured Run Setup for a managed New worktree", async () => {
    const user = userEvent.setup();
    render(<ThreadOverview thread={makeThread({ mode: "worktree", worktree_managed: true })} threadPaneWidth={1400} />);

    await user.click(screen.getByRole("button", { name: "Project Actions" }));
    expect(screen.queryByRole("menuitem", { name: "Run Setup" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Project settings" })).toBeInTheDocument();
  });

  it("keeps failed automatic Setup out of Thread Overview", async () => {
    const failedSetup: WorkspaceEnvironmentAutomaticSetupSnapshot = {
      gate: "blocked",
      attempt: null,
      queuedTurns: [{
        id: "submission-1",
        messageId: "message-1",
        state: "queued",
        createdAt: "2026-08-22T12:00:00.000Z",
        dispatchedAt: null,
      }],
    };
    mockGetAutomaticSetup.mockResolvedValue(failedSetup);

    render(<ThreadOverview thread={makeThread({ mode: "worktree", worktree_managed: true })} threadPaneWidth={1400} />);

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mockGetAutomaticSetup).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Automatic Setup/i })).not.toBeInTheDocument();
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

    render(<ThreadOverview thread={makeThread()} threadPaneWidth={1400} />);

    const row = screen.getByRole("button", { name: /Browser, example\.test/ });
    expect(row).toHaveAccessibleName(expect.stringContaining("agent controls"));
    expect(screen.getByTestId("thread-overview-browser-agent-cursor")).toBeInTheDocument();
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
    });

    expect(rows.map((row) => row.tab.id)).toEqual(["released-tab"]);
    expect(rows[0]?.lifecycle?.ownership).toBe("released");
    expect(rows[0]?.controller).toBeUndefined();
  });

  it("classifies only branchless worktrees as branch-name Create PR candidates", () => {
    expect(canStartBranchlessCreatePr(makeThread())).toBe(true);
    expect(canStartBranchlessCreatePr(makeThread({ checkout_state: "named" }))).toBe(false);
    expect(canStartBranchlessCreatePr(makeThread({ mode: "direct" }))).toBe(false);
  });

  it("shows a loaded sub-agent summary only when present and opens its panel", () => {
    const thread = makeThread();
    const first = render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);
    expect(screen.queryByTestId("thread-overview-subagents")).not.toBeInTheDocument();
    first.unmount();

    mockThreadRecords.set(thread.id, {
      ...createEmptyThreadRecord(),
      toolCalls: [{
        id: "agent-1",
        toolName: "Agent",
        toolInput: { agentName: "Explorer" },
        output: null,
        isError: false,
        isComplete: false,
      }],
      narrativeByMessage: {},
    });
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    const summary = screen.getByTestId("thread-overview-subagents");
    expect(summary).toHaveAccessibleName("Subagents, 1 active, 0 done");
    expect(summary).toHaveTextContent("1 active, 0 done");
    expect(summary).not.toHaveTextContent("total");
    expect(summary.querySelectorAll('[data-testid="provider-disc"]')).toHaveLength(1);
    expect(screen.queryByTestId("thread-overview-subagents-running")).not.toBeInTheDocument();
    expect(screen.getByText("Subagents").compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(summary.querySelector('[data-provider-icon="claude"]')).toBeInTheDocument();
    fireEvent.click(summary);
    expect(mockOpenSubagentsPanel).toHaveBeenCalledOnce();
  });

  it("renders the sub-agent summary in Activity, above the Usage summary", () => {
    const thread = makeThread();
    mockThreadRecords.set(thread.id, {
      ...createEmptyThreadRecord(),
      toolCalls: [{
        id: "agent-1",
        toolName: "Agent",
        toolInput: { agentName: "Explorer" },
        output: null,
        isError: false,
        isComplete: false,
      }],
      narrativeByMessage: {},
      usageByProvider: {
        claude: {
          providerId: "claude",
          quotaCategories: [],
          usageStatus: "ready-empty",
        },
      },
    });

    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    const usage = screen.getByTestId("thread-overview-usage");
    const subagents = screen.getByTestId("thread-overview-subagents");
    expect(usage.compareDocumentPosition(subagents) & Node.DOCUMENT_POSITION_PRECEDING).not.toBe(0);
  });

  it("bounds the disc stack to three, lets the text carry the total, and omits the zero active count", () => {
    const thread = makeThread();
    mockThreadRecords.set(thread.id, {
      ...createEmptyThreadRecord(),
      toolCalls: Array.from({ length: 8 }, (_, index) => ({
        id: `agent-${index}`,
        toolName: "Agent",
        toolInput: { agentName: `Worker ${index}` },
        output: "Done",
        isError: false,
        isComplete: true,
      })),
      narrativeByMessage: {},
    });

    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    const summary = screen.getByTestId("thread-overview-subagents");
    expect(summary).toHaveAccessibleName("Subagents, 0 active, 8 done");
    expect(summary).toHaveTextContent("8 done");
    expect(summary).not.toHaveTextContent("active");
    expect(summary.querySelectorAll('[data-testid="provider-disc"]')).toHaveLength(3);
  });

  it("counts repeated Codex paths as one logical subagent and keeps pathless calls separate", () => {
    const thread = makeThread();
    const explorerDispatches = Array.from({ length: 4 }, (_, index) => ({
      id: `explorer-${index}`,
      toolName: "Agent",
      toolInput: {
        codexCollabKind: "spawnAgent",
        agentName: "explorer",
        agentPath: "/root/explorer",
      },
      output: "Done",
      isError: false,
      isComplete: true,
      lastActivityAt: index,
    }));
    mockThreadRecords.set(thread.id, {
      ...createEmptyThreadRecord(),
      toolCalls: [
        ...explorerDispatches,
        {
          id: "legacy",
          toolName: "Agent",
          toolInput: { agentName: "Explorer" },
          output: "Done",
          isError: false,
          isComplete: true,
          lastActivityAt: 10,
        },
      ],
      narrativeByMessage: {},
    });

    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    const summary = screen.getByTestId("thread-overview-subagents");
    expect(summary).toHaveAccessibleName("Subagents, 0 active, 2 done");
    expect(summary).toHaveTextContent("2 done");
    expect(summary.querySelectorAll('[data-testid="provider-disc"]')).toHaveLength(2);
  });

  it("creates a named branch from the branchless worktree row", async () => {
    const user = userEvent.setup();
    const thread = makeThread({ branch: "release", base_branch: "release" });
    mockWorkspaceState.threads = [thread];
    render(<ThreadOverview thread={thread} threadPaneWidth={1400} />);

    await user.click(screen.getByTestId("thread-overview-local"));
    expect(await screen.findByText("HEAD")).toBeInTheDocument();
    await user.click(screen.getByTestId("thread-overview-local"));
    expect(screen.queryByTestId("workspace-menu-branch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-menu-create-pr")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-menu-commit")).toBeDisabled();

    fireEvent.click(screen.getByTestId("thread-overview-create-branch"));
    expect(screen.getByRole("heading", { name: "Work here" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "feat/issue 801" },
    });
    expect(screen.getByLabelText("Branch name")).toHaveValue("feat/issue-801");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockCreateBranch).toHaveBeenCalledWith("ws-1", "feat/issue-801", "thread-1");
    });

    expect(mockWorkspaceState.threads[0]).toMatchObject({
      id: "thread-1",
      branch: "feat/issue-801",
      checkout_state: "named",
      base_branch: "release",
    });
    expect(mockWorkspaceState.worktreesLoadedForWorkspace).toBeNull();
    expect(screen.queryByTestId("create-pr-dialog")).not.toBeInTheDocument();
  });

  it("clears stale PR metadata and caches when creating a named branch", async () => {
    mockWorkspaceState.threads = [
      makeThread({
        pr_number: 42,
        pr_status: "OPEN",
        base_branch: "release",
      }),
    ];
    mockWorkspaceState.prUrlsByThreadId = {
      "thread-1": "https://example.test/pr/42",
      other: "https://example.test/pr/7",
    };
    mockWorkspaceState.checksById = {
      "thread-1": { aggregate: "passing", runs: [], fetchedAt: 1 },
      other: { aggregate: "no_checks", runs: [], fetchedAt: 2 },
    };
    render(<ThreadOverview thread={mockWorkspaceState.threads[0]} threadPaneWidth={1400} />);

    fireEvent.click(screen.getByTestId("thread-overview-create-branch"));
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "feat/issue 801" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockWorkspaceState.threads[0]).toMatchObject({
        branch: "feat/issue-801",
        checkout_state: "named",
        base_branch: "release",
        pr_number: null,
        pr_status: null,
      });
    });
    expect(mockWorkspaceState.prUrlsByThreadId).toEqual({
      other: "https://example.test/pr/7",
    });
    expect(mockWorkspaceState.checksById).toEqual({
      other: { aggregate: "no_checks", runs: [], fetchedAt: 2 },
    });
  });

  it("keeps the branch creation dialog open when branch creation fails", async () => {
    mockCreateBranch.mockRejectedValueOnce(new Error("branch exists"));
    render(<ThreadOverview thread={makeThread()} threadPaneWidth={1400} />);

    fireEvent.click(screen.getByTestId("thread-overview-create-branch"));
    fireEvent.change(screen.getByLabelText("Branch name"), {
      target: { value: "feat/issue-801" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("branch exists");
    expect(screen.queryByTestId("create-pr-dialog")).not.toBeInTheDocument();
  });
});
