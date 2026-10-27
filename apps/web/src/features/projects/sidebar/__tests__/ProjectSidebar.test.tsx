import { createMockThreadPullRequest, createMockThread } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { StrictMode } from "react";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ThreadAttention, ThreadWaitingKind } from "@mcode/contracts/models/thread-attention";
import type { ThreadStartup } from "@mcode/contracts/thread-startup";
import type { TurnOutcome } from "@mcode/contracts/models/turn-outcome";
import type { Thread } from "@/transport/types";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { pushEmitter } from "@/transport/ws-transport";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";

const sortableMockState = vi.hoisted(() => ({
  transform: null as {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
  } | null,
  isDragging: false,
}));

vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    useSortable: (
      options: Parameters<typeof actual.useSortable>[0],
    ) => {
      const sortable = actual.useSortable(options);
      if (!sortableMockState.transform) return sortable;
      return {
        ...sortable,
        transform: sortableMockState.transform,
        isDragging: sortableMockState.isDragging,
      };
    },
  };
});

// The flattened row model is not exported, so we exercise tree behaviour
// through the exported ProjectTree. Stores and the virtual viewport are mocked
// so the list renders items in the jsdom environment.

vi.mock("../../state/workspaceStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/workspaceStore")>();
  // The store state object must be built once: ProjectTree memoizes its row
  // list on slice references, so a fresh literal per selector call would loop
  // the render -> setRows -> publish cycle forever.
  const state = {
    workspaces: [],
    activeWorkspaceId: null,
    activeThreadId: null,
    threads: [],
    loadWorkspaces: vi.fn(),
    hydrateThreads: vi.fn(),
    setActiveWorkspace: vi.fn(),
    renameWorkspace: vi.fn(),
    setActiveThread: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    deleteThread: vi.fn(),
    completeThread: vi.fn(),
    reopenThread: vi.fn(),
    beginNewThread: vi.fn(),
    updateThreadTitle: vi.fn(),
    loadWorktrees: vi.fn(),
    worktrees: [],
    worktreesLoadedForWorkspace: null,
    checksById: {},
    error: null,
    reorderWorkspace: vi.fn(),
  };
  return {
    useWorkspaceStore: Object.assign(
      vi.fn((selector: (s: unknown) => unknown) => selector(state)),
      actual.useWorkspaceStore,
      { getState: () => state },
    ),
  };
});

vi.mock("@/features/conversation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/conversation")>()),
  schedulePrefetch: vi.fn(),
  cancelPrefetch: vi.fn(),
  prefetchOnPointerDown: vi.fn(),
}));

// Mutable holder so individual tests can inject running-thread state into the mocked thread store without re-registering
// the mock.
const threadStoreOverrides: {
  runningThreadIds?: Set<string>;
  pendingStopCounts?: Record<string, number>;
  runtimeByThread?: Record<string, { runtimePhase: string; turnExecutionId: string | null }>;
} = {};

// The real store exposes a stable Set reference; the mock state is rebuilt per
// selector call, so share one empty set to keep selector output referentially
// stable (ProjectTree memoizes its row list on it).
const EMPTY_RUNNING_THREAD_IDS = new Set<string>();

function buildMockThreadStoreState() {
  const records = new Map<
    string,
    {
      runtimePhase?: string;
      turnExecutionId?: string | null;
    }
  >();
  for (const id of Object.keys(threadStoreOverrides.runtimeByThread ?? {})) {
    const runtime = threadStoreOverrides.runtimeByThread?.[id];
    records.set(id, {
      ...createEmptyThreadRecord(),
      ...runtime,
    });
  }
  return {
    records,
    runningThreadIds:
      threadStoreOverrides.runningThreadIds ?? EMPTY_RUNNING_THREAD_IDS,
    pendingStopCounts: threadStoreOverrides.pendingStopCounts ?? {},
    currentThreadId: null,
  };
}

vi.mock("@/stores/threadStore", async (importActual) => {
  const actual = await importActual<typeof import("@/stores/threadStore")>();
  return {
    // Keep pure helpers (isThreadExecuting, getThreadRecord, ...) real; only the
    // reactive store hook is mocked.
    ...actual,
    useThreadStore: Object.assign(
      vi.fn((selector: (s: unknown) => unknown) => selector(buildMockThreadStoreState())),
      actual.useThreadStore,
    ),
  };
});

const startupTransport = {
  listThreadStartups: vi.mocked(mockTransport.listThreadStartups),
  getThreadStartup: vi.mocked(mockTransport.getThreadStartup),
};

vi.mock("@/transport", () => ({
  getTransport: () => mockTransport,
}));

beforeEach(() => {
  useCompletionStore.setState({ entries: new Map(), hoveredThreadId: null, undoLineThreadId: null });
  vi.mocked(mockTransport.listThreadStartups).mockReset();
  vi.mocked(mockTransport.getThreadStartup).mockReset();
});

function setupStartup(threadId: string, setup: ThreadStartup["steps"][number]["state"], block?: ThreadStartup["block"]): ThreadStartup {
  return {
    startupId: `startup-${threadId}`,
    workspaceId: "ws-1",
    threadId,
    kind: "managed-worktree",
    state: setup === "running" ? "running" : "blocked",
    phase: "setup",
    steps: [
      { phase: "thread", state: "completed" },
      { phase: "worktree", state: "completed" },
      { phase: "setup", state: setup },
      { phase: "agent", state: "pending" },
    ],
    transcript: [],
    cancellation: "none",
    revision: setup === "running" ? 1 : 2,
    createdAt: "",
    updatedAt: "",
    ...(block ? { block } : {}),
  };
}

const SETUP_FAILED_BLOCK = { code: "SETUP_FAILED", message: "Setup failed", actions: ["retry", "continue"] } satisfies ThreadStartup["block"];

// jsdom has no layout, so the viewport is the shared pass-through fake.
vi.mock("@/components/ui/virtual-viewport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/virtual-viewport")>()),
  VirtualViewport: (await import("./fake-virtual-viewport")).FakeVirtualViewport,
}));

afterEach(() => {
  sortableMockState.transform = null;
  sortableMockState.isDragging = false;
});

// Import after mocks are registered.
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useSidebarUiStore } from "../sidebar-ui-store";
import { useCompletionStore } from "../completion-store";
import { useUiStore } from "@/stores/uiStore";
import { prefetchOnPointerDown } from "@/features/conversation";
import { ProjectSidebar } from "../ProjectSidebar";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
import { useConnectionStore } from "@/stores/connectionStore";
import { FakeVirtualViewport } from "./fake-virtual-viewport";

const publishedRowIdHistory = FakeVirtualViewport.published;

/** Build a minimal Thread fixture. */
type TestWorkspaceThread = Thread & { clientPreparing?: boolean };

function makeThread(
  overrides: Partial<TestWorkspaceThread> = {},
): TestWorkspaceThread {
  return createMockThread({
    id: "thread-1",
    workspace_id: "ws-1",
    title: "My Thread",
    status: "paused",
    mode: "direct",
    worktree_path: null,
    branch: "main",
    checkout_state: "named",
    base_branch: null,
    worktree_managed: false,
    
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    model: null,
    provider: "claude",
    user_completed_at: null,
    scheduled_deletion_at: null,
    cleanup_state: null,
    cleanup_reason: null,
    delegation_coordinator_thread_id: null,
    ...overrides,
  });
}

function selectCompletedScope(): void {
  fireEvent.click(screen.getByRole("radio", { name: /^Completed/ }));
}

function rowIndent(row: HTMLElement | undefined): string | undefined {
  return row?.querySelector<HTMLElement>("[style*='padding-left']")?.style.paddingLeft;
}

const WORKSPACE = {
  id: "ws-1",
  name: "Test Project",
  path: "/test",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

/** Wire up store mocks so ProjectTree renders a workspace with one thread. */
interface ProjectTreeStoreMockOptions {
  readonly thread?: Thread | null;
  readonly threads?: Thread[];
  readonly workspaces?: typeof WORKSPACE[];
  readonly setActiveThread?: ReturnType<typeof vi.fn>;
  readonly setActiveWorkspace?: ReturnType<typeof vi.fn>;
  readonly beginNewThread?: ReturnType<typeof vi.fn>;
  readonly updateThreadTitle?: ReturnType<typeof vi.fn>;
  readonly reopenThread?: ReturnType<typeof vi.fn>;
  readonly retryThreadCleanup?: ReturnType<typeof vi.fn>;
}

function setupStoreMocks(options: ProjectTreeStoreMockOptions = {}) {
  const state = createProjectTreeStoreMock(options);
  (
    useWorkspaceStore as unknown as {
      mockImplementation: (
        fn: (selector: (s: unknown) => unknown) => unknown,
      ) => void;
    }
  ).mockImplementation((selector) => selector(state));
  // handleDeleteWorkspace reads state imperatively via useWorkspaceStore.getState().
  Object.assign(useWorkspaceStore, { getState: () => state });
  return state;
}

function createProjectTreeStoreMock(options: ProjectTreeStoreMockOptions) {
  const data = projectTreeMockData(options);
  const actions = projectTreeMockActions(options);
  return {
    ...data,
    activeWorkspaceId: "ws-1",
    activeThreadId: null,
    pendingStartupByThreadId: {},
    loadWorkspaces: vi.fn(),
    hydrateThreads: vi.fn(),
    renameWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    deleteThread: vi.fn(),
    ...actions,
    loadWorktrees: vi.fn(),
    worktrees: [],
    worktreesLoadedForWorkspace: null,
    checksById: {},
    error: null,
  };
}

function projectTreeMockData(options: ProjectTreeStoreMockOptions) {
  const thread = options.thread === undefined ? makeThread() : options.thread;
  return {
    workspaces: options.workspaces ?? [WORKSPACE],
    threads: options.threads ?? (thread ? [thread] : []),
  };
}

function projectTreeMockActions(options: ProjectTreeStoreMockOptions) {
  return {
    setActiveThread: options.setActiveThread ?? vi.fn(),
    setActiveWorkspace: options.setActiveWorkspace ?? vi.fn(),
    beginNewThread: options.beginNewThread ?? vi.fn(),
    updateThreadTitle: options.updateThreadTitle ?? vi.fn(),
    reopenThread: options.reopenThread ?? vi.fn().mockResolvedValue(undefined),
    retryThreadCleanup: options.retryThreadCleanup ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe("ProjectSidebar thread interactions", () => {
  beforeEach(() => {
    // Pre-expand the workspace so the thread list is visible immediately.
    useSidebarUiStore.setState({ expandedProjects: new Set(["ws-1"]) });
    useSidebarUiStore.setState({ scope: "active" });
    publishedRowIdHistory.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("starts a new thread from the project row without expanding it", () => {
    useSidebarUiStore.setState({ expandedProjects: new Set([]) });
    const beginNewThread = vi.fn();
    const state = setupStoreMocks({ beginNewThread });
    useUiStore.setState({ primarySurface: "pullRequests" });

    render(<ProjectSidebar />);
    fireEvent.click(
      screen.getByRole("button", { name: "New thread in Test Project" }),
    );

    expect(beginNewThread).toHaveBeenCalledWith("ws-1");
    expect(useUiStore.getState().primarySurface).toBe("chat");
    expect(state.hydrateThreads).not.toHaveBeenCalled();
  });

  it("expands a project from its folder without opening a new composer", () => {
    useSidebarUiStore.setState({ expandedProjects: new Set([]) });
    const beginNewThread = vi.fn();
    const state = setupStoreMocks({ beginNewThread });

    render(<ProjectSidebar />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open project Test Project" }),
    );

    expect(beginNewThread).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Toggle threads for Test Project" })).toHaveAttribute("aria-expanded", "true");
    expect(state.hydrateThreads).not.toHaveBeenCalled();
  });

  it("keeps thread disclosure separate from project selection", () => {
    useSidebarUiStore.setState({ expandedProjects: new Set([]) });
    const beginNewThread = vi.fn();
    const state = setupStoreMocks({ beginNewThread });

    render(<ProjectSidebar />);
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle threads for Test Project" }),
    );

    expect(beginNewThread).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Toggle threads for Test Project" })).toHaveAttribute("aria-expanded", "true");
    expect(state.hydrateThreads).not.toHaveBeenCalled();
  });

  it("keys rows per thread and keeps unchanged rows stable as a placeholder is replaced", () => {
    const oldThreads = [
      makeThread({ id: "old-thread-1", title: "Old thread 1" }),
      makeThread({ id: "old-thread-2", title: "Old thread 2" }),
    ];
    const state = setupStoreMocks({ threads: oldThreads });
    const view = render(<ProjectSidebar />);
    expect(publishedRowIdHistory.at(-1)).toEqual(["project:ws-1", "thread:old-thread-1", "thread:old-thread-2", "end-spacer"]);
    const stableThread = view.container.querySelector(
      '[data-thread-id="old-thread-1"]',
    );
    publishedRowIdHistory.length = 0;

    state.threads = [
      makeThread({
        id: "placeholder-thread",
        title: "New thread",
        clientPreparing: true,
      }),
      ...oldThreads,
    ];
    act(() => view.rerender(<ProjectSidebar />));
    expect(publishedRowIdHistory.at(-1)).toContain("thread:placeholder-thread");
    expect(
      view.container.querySelector('[data-thread-id="placeholder-thread"]'),
    ).not.toBeNull();
    publishedRowIdHistory.length = 0;

    state.threads = [
      makeThread({ id: "server-thread", title: "New thread" }),
      ...oldThreads,
    ];
    act(() => view.rerender(<ProjectSidebar />));
    expect(publishedRowIdHistory.at(-1)).toContain("thread:server-thread");
    expect(publishedRowIdHistory.at(-1)).not.toContain("thread:placeholder-thread");
    expect(
      view.container.querySelector('[data-thread-id="server-thread"]'),
    ).not.toBeNull();
    expect(view.container.querySelector('[data-thread-id="old-thread-1"]')).toBe(
      stableThread,
    );
  });

  it("switches to completed threads and reopens one by keyboard", async () => {
    const reopenThread = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({
      thread: makeThread({
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
      }),
      reopenThread,
    });
    render(<ProjectSidebar />);
    const completedScope = screen.getByRole("radio", { name: /^Completed/ });
    expect(completedScope).toHaveAttribute("aria-checked", "false");
    completedScope.focus();
    expect(completedScope).toHaveFocus();
    fireEvent.click(completedScope);

    const action = screen.getByRole("button", { name: "Reopen My Thread" });
    action.focus();
    expect(action).toHaveFocus();
    fireEvent.click(action);

    expect(reopenThread).toHaveBeenCalledWith("thread-1");
  });

  it("shows one lifecycle set at a time and keeps the global scope across remounts", () => {
    const activeThread = makeThread({ id: "thread-active", title: "Active work" });
    const completedThread = makeThread({
      id: "thread-completed",
      title: "Completed work",
      user_completed_at: "2026-08-12T08:00:00.000Z",
    });
    setupStoreMocks({ threads: [activeThread, completedThread] });

    const firstRender = render(<ProjectSidebar />);
    expect(screen.getByRole("button", { name: /^Provider, Claude Active work/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Provider, Claude Completed work/i })).toBeNull();
    expect(
      screen.getByRole("group", { name: "Test Project project, 1 active thread, 1 completed thread" }),
    ).toBeVisible();

    selectCompletedScope();
    expect(screen.queryByRole("button", { name: /^Provider, Claude Active work/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^Provider, Claude Completed work/i })).toBeVisible();

    firstRender.unmount();
    render(<ProjectSidebar />);
    expect(screen.getByRole("button", { name: /^Provider, Claude Completed work/i })).toBeVisible();
  });

  it("applies the scope to every project at once", () => {
    const secondWorkspace = { ...WORKSPACE, id: "ws-2", name: "Second Project", path: "/second" };
    useSidebarUiStore.setState({ expandedProjects: new Set(["ws-1", "ws-2"]) });
    setupStoreMocks({
      workspaces: [WORKSPACE, secondWorkspace],
      threads: [
        makeThread({ id: "first-completed", title: "First completed", user_completed_at: "2026-08-12T08:00:00.000Z" }),
        makeThread({ id: "second-active", workspace_id: "ws-2", title: "Second active" }),
      ],
    });

    render(<ProjectSidebar />);
    expect(screen.getByRole("button", { name: /^Provider, Claude Second active/i })).toBeVisible();
    selectCompletedScope();

    expect(screen.getByRole("button", { name: /^Provider, Claude First completed/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Provider, Claude Second active/i })).toBeNull();
    expect(screen.queryByTestId("project-row-ws-2")).toBeNull();
  });

  it("hides the scope bar while no thread is completed", () => {
    setupStoreMocks({ threads: [makeThread({ id: "thread-active", title: "Active work" })] });
    render(<ProjectSidebar />);

    expect(screen.queryByTestId("sidebar-scope-bar")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Thread scope" })).toBeNull();
  });

  it("shows the scope bar with the completed count once a thread is completed", () => {
    setupStoreMocks({ threads: [makeThread({ id: "thread-active", title: "Active work" })] });
    const view = render(<ProjectSidebar />);
    setupStoreMocks({
      threads: [
        makeThread({ id: "thread-active", title: "Active work" }),
        makeThread({ id: "thread-done", title: "Done work", user_completed_at: "2026-08-12T08:00:00.000Z" }),
      ],
    });
    view.rerender(<ProjectSidebar />);

    const bar = screen.getByRole("radiogroup", { name: "Thread scope" });
    expect(within(bar).getByRole("radio", { name: "Active" })).toHaveAttribute("aria-checked", "true");
    expect(within(bar).getByRole("radio", { name: /^Completed/ })).toHaveTextContent("Completed1");
  });

  it("falls back to Active when the last completed thread is deleted", () => {
    const activeThread = makeThread({ id: "thread-active", title: "Active work" });
    setupStoreMocks({
      threads: [activeThread, makeThread({ id: "thread-done", title: "Done work", user_completed_at: "2026-08-12T08:00:00.000Z" })],
    });
    const view = render(<ProjectSidebar />);
    selectCompletedScope();
    expect(screen.queryByRole("button", { name: /^Provider, Claude Active work/i })).toBeNull();

    setupStoreMocks({ threads: [activeThread] });
    view.rerender(<ProjectSidebar />);

    expect(screen.queryByTestId("sidebar-scope-bar")).toBeNull();
    expect(screen.getByRole("button", { name: /^Provider, Claude Active work/i })).toBeVisible();
    expect(useSidebarUiStore.getState().scope).toBe("active");
  });

  it("labels a thread that switched provider with every provider, current first", () => {
    setupStoreMocks({
      threads: [
        makeThread({ id: "switched", title: "Switched", provider: "codex", providers_used: ["claude", "codex"] }),
        makeThread({ id: "single", title: "Single", provider: "claude", providers_used: ["claude"] }),
        makeThread({ id: "never", title: "Never", provider: "claude", providers_used: null }),
      ],
    });
    render(<ProjectSidebar />);
    expect(screen.getByRole("button", { name: /^Providers, Codex, Claude Switched/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Provider, Claude Single/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Provider, Claude Never/ })).toBeVisible();
    expect(screen.getAllByTestId("provider-icon-stack")).toHaveLength(1);
  });

  it("offers Reopen on a completed row and shows its hover details", async () => {
    vi.useRealTimers();
    setupStoreMocks({
      thread: makeThread({
        title: "Completed work",
        mode: "worktree",
        worktree_path: "C:/test-worktree",
        pull_requests: [createMockThreadPullRequest({ number: 42, state: "open" })],
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
      }),
    });

    render(<ProjectSidebar />);
    selectCompletedScope();

    expect(screen.getByRole("button", { name: "Reopen Completed work" })).toBeInTheDocument();
    screen.getByRole("button", { name: /^Provider, Claude Completed work/i }).focus();
    const preview = await screen.findByTestId("thread-preview-thread-1");
    expect(preview).toHaveTextContent("Completed");
    const exactDeadline = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date("2026-08-15T08:00:00.000Z"));
    expect(preview).toHaveTextContent(`Deletes ${exactDeadline}`);
    vi.useFakeTimers();
  });

  it("states when automatic deletion is disabled", async () => {
    vi.useRealTimers();
    setupStoreMocks({
      thread: makeThread({
        title: "Kept work",
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: null,
      }),
    });

    render(<ProjectSidebar />);
    selectCompletedScope();
    screen.getByRole("button", { name: /^Provider, Claude Kept work/i }).focus();

    expect(await screen.findByTestId("thread-preview-thread-1")).toHaveTextContent(
      "Automatic deletion disabled",
    );
    vi.useFakeTimers();
  });

  it("shows a bounded cleanup block reason in the completed hover details", async () => {
    vi.useRealTimers();
    setupStoreMocks({
      thread: makeThread({
        title: "Dirty work",
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
        cleanup_state: "blocked",
        cleanup_reason: "The worktree has uncommitted changes.",
      }),
    });

    render(<ProjectSidebar />);
    selectCompletedScope();
    screen.getByRole("button", { name: /^Provider, Claude Dirty work/i }).focus();

    const preview = await screen.findByTestId("thread-preview-thread-1");
    expect(preview).toHaveTextContent(
      "Cleanup blocked: The worktree has uncommitted changes.",
    );
    expect(preview).not.toHaveTextContent("Deletes");
    vi.useFakeTimers();
  });

  it("shows retry cleanup and reopen controls for a blocked completed thread", async () => {
    vi.useRealTimers();
    const retryThreadCleanup = vi.fn().mockResolvedValue(undefined);
    const reopenThread = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({
      thread: makeThread({
        title: "Blocked work",
        user_completed_at: "2026-08-12T08:00:00.000Z",
        cleanup_state: "blocked",
        cleanup_reason: "The worktree has uncommitted changes.",
      }),
      retryThreadCleanup,
      reopenThread,
    });

    render(<ProjectSidebar />);
    selectCompletedScope();

    expect(
      screen.getByRole("button", { name: "Retry cleanup for Blocked work" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reopen Blocked work" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup for Blocked work" }));
    await Promise.resolve();
    expect(retryThreadCleanup).toHaveBeenCalledWith("thread-1");

    fireEvent.click(screen.getByRole("button", { name: "Reopen Blocked work" }));
    await Promise.resolve();
    expect(reopenThread).toHaveBeenCalledWith("thread-1");
    vi.useFakeTimers();
  });

  it("shows a manual retry failure inline while the thread remains blocked", async () => {
    vi.useRealTimers();
    try {
      const retryThreadCleanup = vi.fn().mockRejectedValue(new Error("still blocked"));
      setupStoreMocks({
        thread: makeThread({
          title: "Blocked work",
          user_completed_at: "2026-08-12T08:00:00.000Z",
          cleanup_state: "blocked",
          cleanup_reason: "The worktree has uncommitted changes.",
        }),
        retryThreadCleanup,
      });

      render(<ProjectSidebar />);
      selectCompletedScope();
      fireEvent.click(screen.getByRole("button", { name: "Retry cleanup for Blocked work" }));

      expect(await screen.findByText("Cleanup retry failed: Error: still blocked")).toBeInTheDocument();
    } finally {
      vi.useFakeTimers();
    }
  });

  it("keeps expanded threads mounted when a project drag starts", () => {
    useSidebarUiStore.setState({ expandedProjects: new Set(["ws-1"]) });
    setupStoreMocks();

    render(<ProjectSidebar />);
    expect(screen.getByRole("button", { name: /^Provider, Claude My Thread/i })).toBeVisible();
    const projectRow = screen.getByTestId("project-row-ws-1");
    projectRow.focus();
    // KeyboardSensor activates on event.code, not key.
    fireEvent.keyDown(projectRow, { code: "Space" });
    expect(document.body).toHaveStyle({ cursor: "grabbing" });

    // The DragOverlay clones the whole project group outside the viewport, so
    // queries that must hit the real row scope to the tree.
    const tree = within(screen.getByTestId("project-tree-viewport"));
    expect(tree.getByRole("button", { name: /^Provider, Claude My Thread/i })).toBeVisible();
    expect(
      tree.getByRole("button", { name: "Toggle threads for Test Project" }),
    ).toHaveAttribute("aria-expanded", "true");

    // The sensor's drop listener attaches in a macrotask after activation.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    fireEvent.keyDown(document, { code: "Space" });
    expect(document.body).not.toHaveStyle({ cursor: "grabbing" });
  });

  it("applies only translation while a project is dragged", () => {
    sortableMockState.transform = { x: 12, y: 34, scaleX: 1.5, scaleY: 0.5 };
    sortableMockState.isDragging = true;

    setupStoreMocks();
    render(<ProjectSidebar />);

    const shell = screen.getByTestId("project-row-ws-1").parentElement;
    expect(shell).not.toBeNull();
    expect(shell).toHaveStyle({ transform: "translate3d(12px, 34px, 0)" });
  });

  it("restores the project viewport across repeated disclosure cycles", () => {
    useSidebarUiStore.setState({ expandedProjects: new Set([]) });
    setupStoreMocks();
    render(<ProjectSidebar />);

    const viewport = document.querySelector<HTMLElement>(
      '[data-testid="project-tree-viewport"]',
    );
    expect(viewport).not.toBeNull();
    viewport!.scrollTop = 240;

    const disclosure = () =>
      screen.getByRole("button", { name: "Toggle threads for Test Project" });

    fireEvent.click(disclosure());
    expect(viewport).toHaveProperty("scrollTop", 240);

    fireEvent.click(disclosure());
    expect(viewport).toHaveProperty("scrollTop", 240);

    fireEvent.click(disclosure());
    expect(viewport).toHaveProperty("scrollTop", 240);
  });

  it("keeps the thread count trailing and swaps it for an overlaid action group", () => {
    setupStoreMocks();

    render(<ProjectSidebar />);

    const projectRow = screen.getByTestId("project-row-ws-1");
    const threadCount = within(projectRow).getByTestId(
      "project-thread-count-ws-1",
    );
    const actions = within(projectRow).getByTestId("project-row-actions-ws-1");

    expect(threadCount).toHaveTextContent("1");
    expect(threadCount.nextElementSibling).toBe(actions);
    expect(actions).toContainElement(
      screen.getByRole("button", { name: "Toggle threads for Test Project" }),
    );
    expect(actions).toContainElement(
      screen.getByRole("button", { name: "Project options for Test Project" }),
    );
    expect(actions).toContainElement(
      screen.getByRole("button", { name: "New thread in Test Project" }),
    );
  });

  it("exposes the full project name from the focused project control", () => {
    const projectName =
      "A project name that stays available when the sidebar is narrow";
    setupStoreMocks({
      workspaces: [{ ...WORKSPACE, name: projectName }],
    });

    render(<ProjectSidebar />);

    const projectButton = screen.getByRole("button", {
      name: `Open project ${projectName}`,
    });
    act(() => {
      projectButton.focus();
      vi.advanceTimersByTime(1_000);
    });

    expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
      projectName,
    );
  });

  it("shows the Add project tooltip on the header control", () => {
    setupStoreMocks();

    render(<ProjectSidebar />);

    const addButton = screen.getByRole("button", { name: "Add project" });
    act(() => {
      addButton.focus();
      vi.advanceTimersByTime(1_000);
    });

    expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(
      "Add project",
    );
  });

  it("shows the drop well instead of the old empty text when there are no projects", () => {
    setupStoreMocks({ workspaces: [] });

    render(<ProjectSidebar />);

    expect(screen.getByTestId("project-drop-well")).toHaveTextContent("No projects");
    expect(screen.getByText("Use + to add a project.")).toBeInTheDocument();
    expect(screen.queryByText("No projects yet")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add project" })).toBeInTheDocument();
  });

  it("leads the row with the provider and title, and ends the title line with the status", () => {
    setupStoreMocks();

    render(<ProjectSidebar />);

    const row = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });
    const status = within(row).getByTestId("thread-status");
    const title = within(row).getByTestId("thread-title");

    expect(title.previousElementSibling).toBe(screen.getByLabelText("Provider, Claude"));
    expect(title.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status).toBeEmptyDOMElement();
  });

  it("offers Explorer and rename actions from the project menu", () => {
    setupStoreMocks();

    render(<ProjectSidebar />);
    fireEvent.click(
      screen.getByRole("button", { name: "Project options for Test Project" }),
    );

    expect(
      screen.getByText("Open in Explorer", { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Rename project", { exact: true }),
    ).toBeInTheDocument();
  });

  it("labels an expanded project with no threads", () => {
    setupStoreMocks({ thread: null });

    render(<ProjectSidebar />);

    expect(screen.getByText("No active threads", { exact: true })).toBeVisible();
  });

  it("keeps a Delegated thread at the root even when its Coordinator is listed", () => {
    const coordinator = makeThread({ id: "coordinator", title: "Coordinator" });
    const delegated = makeThread({
      id: "delegated",
      title: "Delegated",
      delegation_coordinator_thread_id: "coordinator",
    });
    setupStoreMocks({ threads: [coordinator, delegated] });

    render(<ProjectSidebar />);

    const rows = screen.getAllByTestId("thread-item");
    expect(rows.map(rowIndent)).toEqual(["4px", "4px"]);
  });

  it("caps the thread list at six rows and toggles the overflow", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({ id: `thread-${index + 1}`, title: `Thread ${index + 1}` }),
    );
    setupStoreMocks({ threads });

    render(<ProjectSidebar />);

    expect(screen.getAllByTestId("thread-item")).toHaveLength(6);
    const showMore = screen.getByRole("button", { name: "Show more (2)" });
    fireEvent.click(showMore);

    expect(screen.getAllByTestId("thread-item")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));

    expect(screen.getAllByTestId("thread-item")).toHaveLength(6);
  });

  it("single click navigates immediately with no delay", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectSidebar />);

    const threadButton = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });
    fireEvent.click(threadButton);

    // Navigation must fire on the first click — no debounce.
    expect(setActiveThread).toHaveBeenCalledWith("thread-1");
    expect(setActiveThread).toHaveBeenCalledTimes(1);
  });

  it("prefetches on pointerdown before click navigation", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectSidebar />);

    const threadButton = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });
    fireEvent.pointerDown(threadButton);
    expect(prefetchOnPointerDown).toHaveBeenCalledWith("thread-1");

    fireEvent.click(threadButton);
    expect(setActiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("double click enters edit mode after first-click navigation", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectSidebar />);

    const threadButton = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });

    // First click navigates immediately.
    fireEvent.click(threadButton);
    expect(setActiveThread).toHaveBeenCalledTimes(1);

    // Second click within the 250ms window enters rename mode.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.click(threadButton);

    // Navigation count stays at 1 — the second click must NOT trigger another navigate.
    expect(setActiveThread).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("prefills a double-click rename with the current thread title", () => {
    setupStoreMocks();

    render(<ProjectSidebar />);

    const threadRow = screen.getByRole("button", {
      name: /^Provider, Claude My Thread/i,
    });
    fireEvent.click(threadRow);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.click(threadRow);

    expect(screen.getByRole("textbox")).toHaveValue("My Thread");
  });

  it("commits a changed double-click rename with Enter", async () => {
    const updateThreadTitle = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({ updateThreadTitle });

    render(<ProjectSidebar />);

    const threadRow = screen.getByRole("button", {
      name: /^Provider, Claude My Thread/i,
    });
    fireEvent.click(threadRow);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.click(threadRow);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Renamed thread" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });

    expect(updateThreadTitle).toHaveBeenCalledWith("thread-1", "Renamed thread");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("cancels a double-click rename with Escape", async () => {
    const updateThreadTitle = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({ updateThreadTitle });

    render(<ProjectSidebar />);

    const threadRow = screen.getByRole("button", {
      name: /^Provider, Claude My Thread/i,
    });
    fireEvent.click(threadRow);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.click(threadRow);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Unsaved thread title" } });
    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(updateThreadTitle).not.toHaveBeenCalled();
    expect(screen.getByTestId("thread-title")).toHaveTextContent("My Thread");
  });

  it("cancels a double-click rename when the user clicks outside the input", async () => {
    const updateThreadTitle = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({ updateThreadTitle });

    render(<ProjectSidebar />);

    const threadRow = screen.getByRole("button", {
      name: /^Provider, Claude My Thread/i,
    });
    fireEvent.click(threadRow);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.click(threadRow);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Unsaved thread title" } });
    input.focus();
    await act(async () => {
      fireEvent.pointerDown(threadRow);
      fireEvent.blur(input, { relatedTarget: threadRow });
      fireEvent.pointerUp(threadRow);
      fireEvent.click(threadRow);
      await Promise.resolve();
    });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(updateThreadTitle).not.toHaveBeenCalled();
    expect(screen.getByTestId("thread-title")).toHaveTextContent("My Thread");
  });

  it("two clicks beyond the double-click window navigate twice (no rename)", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectSidebar />);

    const threadButton = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });

    fireEvent.click(threadButton);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.click(threadButton);

    expect(setActiveThread).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("clicking while editing does not navigate or re-enter edit", () => {
    const setActiveThread = vi.fn();
    const updateThreadTitle = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({ setActiveThread, updateThreadTitle });

    render(<ProjectSidebar />);

    const threadButton = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });

    // Double-click to enter edit mode (first click navigates, second triggers rename).
    fireEvent.click(threadButton);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.click(threadButton);

    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(setActiveThread).toHaveBeenCalledTimes(1);

    // Click the outer row button again while editing.
    fireEvent.click(threadButton);

    // No additional navigation.
    expect(setActiveThread).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("pressing Enter on the thread row navigates immediately", () => {
    const setActiveThread = vi.fn();
    setupStoreMocks({ setActiveThread });

    render(<ProjectSidebar />);

    const threadButton = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });

    // Focus and press Enter on the thread row.
    threadButton.focus();
    fireEvent.keyDown(threadButton, { key: "Enter" });

    // Navigation must fire immediately (no timer advance needed).
    expect(setActiveThread).toHaveBeenCalledWith("thread-1");
    expect(setActiveThread).toHaveBeenCalledTimes(1);
  });

  it("expands hydrated threads under StrictMode without fetching the index", () => {
    useSidebarUiStore.setState({ expandedProjects: new Set([]) });
    const state = setupStoreMocks();

    render(
      <StrictMode>
        <ProjectSidebar />
      </StrictMode>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle threads for Test Project" }),
    );

    expect(screen.getByRole("button", { name: "Toggle threads for Test Project" })).toHaveAttribute("aria-expanded", "true");
    expect(state.hydrateThreads).not.toHaveBeenCalled();
  });

  it("puts the sortable affordance on the focusable project row", () => {
    setupStoreMocks();
    render(<ProjectSidebar />);

    const row = screen.getByTestId("project-row-ws-1");
    expect(row).toHaveAttribute("role", "group");
    expect(row).toHaveAttribute("tabindex", "0");
    expect(row).toHaveAttribute("aria-roledescription", "sortable");
    expect(row.getAttribute("aria-describedby")).toMatch(/^DndDescribedBy-/);
    // The positioning wrapper must not be a second tab stop.
    expect(row.parentElement).not.toHaveAttribute("tabindex", "0");
  });

  it("keeps a cleanup retry error across collapse and expand", async () => {
    vi.useRealTimers();
    try {
      const retryThreadCleanup = vi
        .fn()
        .mockRejectedValue(new Error("still blocked"));
      setupStoreMocks({
        thread: makeThread({
          title: "Blocked work",
          user_completed_at: "2026-08-12T08:00:00.000Z",
          cleanup_state: "blocked",
          cleanup_reason: "The worktree has uncommitted changes.",
        }),
        retryThreadCleanup,
      });

      render(<ProjectSidebar />);
      selectCompletedScope();
      fireEvent.click(
        screen.getByRole("button", { name: "Retry cleanup for Blocked work" }),
      );
      expect(
        await screen.findByText("Cleanup retry failed: Error: still blocked"),
      ).toBeInTheDocument();

      const projectRow = screen.getByTestId("project-row-ws-1");
      fireEvent.click(projectRow);
      fireEvent.click(projectRow);

      expect(
        screen.getByText("Cleanup retry failed: Error: still blocked"),
      ).toBeInTheDocument();
    } finally {
      vi.useFakeTimers();
    }
  });

  it("cancels an in-progress rename when the thread row unmounts", () => {
    const updateThreadTitle = vi.fn().mockResolvedValue(undefined);
    setupStoreMocks({ updateThreadTitle });
    render(<ProjectSidebar />);

    const threadRow = screen.getByRole("button", {
      name: /^Provider, Claude My Thread/i,
    });
    fireEvent.click(threadRow);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.click(threadRow);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Unsaved draft" },
    });

    // Collapse unmounts the row; the draft must be cancelled, not stashed.
    const projectRow = screen.getByTestId("project-row-ws-1");
    fireEvent.click(projectRow);
    fireEvent.click(projectRow);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(updateThreadTitle).not.toHaveBeenCalled();
    expect(screen.getByTestId("thread-title")).toHaveTextContent("My Thread");
  });

  it("swallows the click that fires when a drag ends", () => {
    setupStoreMocks();
    render(<ProjectSidebar />);
    const projectRow = screen.getByTestId("project-row-ws-1");
    // The drop-animation overlay clone lingers, so queries scope to the tree.
    const threadRow = () =>
      within(screen.getByTestId("project-tree-viewport")).queryByRole(
        "button",
        { name: /^Provider, Claude My Thread/i },
      );

    projectRow.focus();
    fireEvent.keyDown(projectRow, { code: "Space" });
    expect(document.body).toHaveStyle({ cursor: "grabbing" });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    fireEvent.keyDown(document, { code: "Space" });
    expect(document.body).not.toHaveStyle({ cursor: "grabbing" });

    // The browser fires a click under the pointer at drop; it must not toggle.
    fireEvent.click(projectRow);
    expect(threadRow()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.click(projectRow);
    expect(threadRow()).toBeNull();
  });
});

describe("ProjectSidebar action-required indicator", () => {
  let currentThread: TestWorkspaceThread;
  // Shape matches ChecksStatus just enough for sidebar CI aggregation,
  // while keeping the action-required ring tests focused on row state.
  let currentChecks: Record<string, { aggregate: string; runs: unknown[] }>;
  let currentPendingStartup: Record<string, true>;

  function installWorkspaceMock() {
    // Build the state once per install: a fresh object per selector call would
    // invalidate ProjectTree's row memo on every render and loop forever.
    // WorkspaceState is not exported; cast through any so the fixture object
    // satisfies the mock without importing the internal type.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = {
      workspaces: [
        {
          id: "ws-1",
          name: "Test",
          path: "/test",
          provider_config: {},
          created_at: "",
          updated_at: "",
        },
      ],
      activeWorkspaceId: "ws-1",
      activeThreadId: null,
      threads: [currentThread],
      checksById: currentChecks,
      loadWorkspaces: vi.fn(),
      hydrateThreads: vi.fn(),
      setActiveWorkspace: vi.fn(),
      setActiveThread: vi.fn(),
      createWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
      deleteThread: vi.fn(),
      setPendingNewThread: vi.fn(),
      updateThreadTitle: vi.fn(),
      loadWorktrees: vi.fn(),
      worktrees: [],
      worktreesLoadedForWorkspace: null,
      error: null,
      pendingStartupByThreadId: currentPendingStartup,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    vi.mocked(useWorkspaceStore).mockImplementation(((
      selector: (s: unknown) => unknown,
    ) => selector(state)) as never);
    Object.assign(useWorkspaceStore, { getState: () => state });
  }

  beforeEach(() => {
    threadAttentionStore.setState({ byThreadId: {}, visitBaselines: {}, onScreenThreadId: null });
    threadStoreOverrides.runningThreadIds = undefined;
    threadStoreOverrides.pendingStopCounts = undefined;
    threadStoreOverrides.runtimeByThread = undefined;
    startupTransport.listThreadStartups.mockReset();
    startupTransport.listThreadStartups.mockResolvedValue({ records: [] });
    currentThread = makeThread({ id: "thread-pending", status: "active" });
    currentChecks = {};
    currentPendingStartup = {};
    useThreadStartupStore.setState({ recordsByStartupId: {}, startupIdByThreadId: {}, dismissedStartupIds: new Set() });
    useConnectionStore.setState({ status: "connected" });
    installWorkspaceMock();
    // Pre-expand the workspace so its threads render.
    useSidebarUiStore.setState({ expandedProjects: new Set(["ws-1"]) });
  });

  afterEach(() => {
    // Restore the default empty-state implementation so this override does not
    // leak into other describes when test order shifts.
    vi.mocked(useWorkspaceStore).mockImplementation(((
      selector: (s: unknown) => unknown,
    ) =>
      selector({
        workspaces: [],
        activeWorkspaceId: null,
        activeThreadId: null,
        threads: [],
        loadWorkspaces: vi.fn(),
        hydrateThreads: vi.fn(),
        setActiveWorkspace: vi.fn(),
        setActiveThread: vi.fn(),
        createWorkspace: vi.fn(),
        deleteWorkspace: vi.fn(),
        deleteThread: vi.fn(),
        setPendingNewThread: vi.fn(),
        updateThreadTitle: vi.fn(),
        loadWorktrees: vi.fn(),
        worktrees: [],
        worktreesLoadedForWorkspace: null,
        error: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any);
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  function attention(threadId: string, overrides: Partial<ThreadAttention> = {}): ThreadAttention {
    return { threadId, waiting: null, lastTurn: null, seen: { sequence: null, at: null }, hasUnfinishedDelegatedTasks: false, ...overrides };
  }

  function waitingOn(kind: ThreadWaitingKind): Pick<ThreadAttention, "waiting"> {
    return { waiting: { kind, since: "2026-10-11T12:00:00.000Z" } };
  }

  function endedTurn(outcome: TurnOutcome, sequence = 7): Pick<ThreadAttention, "lastTurn"> {
    return { lastTurn: { outcome, endedAt: "2026-10-11T12:00:00.000Z", sequence, changedFileCount: null } };
  }

  function applyAttention(value: ThreadAttention): void {
    act(() => threadAttentionStore.getState().apply(value));
  }

  it("rings Approval required and names it on the third line", () => {
    applyAttention(attention("thread-pending", waitingOn("approval")));
    render(<ProjectSidebar />);

    expect(screen.getByRole("img", { name: "Approval required" })).toHaveAttribute("data-status-mark", "attention");
    expect(screen.getByText("Approval required")).toBeInTheDocument();
  });

  it("leaves the status lane empty for a thread with no attention facts", () => {
    render(<ProjectSidebar />);

    expect(screen.getByTestId("thread-status")).toBeEmptyDOMElement();
  });

  it("keeps the ring when the waiting thread is also running", () => {
    applyAttention(attention("thread-pending", waitingOn("approval")));
    threadStoreOverrides.runningThreadIds = new Set(["thread-pending"]);
    render(<ProjectSidebar />);

    expect(screen.getByRole("img", { name: "Approval required" })).toHaveAttribute("data-status-mark", "attention");
    expect(screen.queryByRole("img", { name: "Running" })).toBeNull();
  });

  it("marks a running row with its spinner and blocks completion", () => {
    threadStoreOverrides.runningThreadIds = new Set(["thread-pending"]);
    threadStoreOverrides.runtimeByThread = {
      "thread-pending": { runtimePhase: "running", turnExecutionId: "turn-1" },
    };
    render(<ProjectSidebar />);

    expect(screen.getByRole("button", { name: /^Provider, Claude My Thread/i })).toBeInTheDocument();
    expect(within(screen.getByTestId("thread-status")).getByRole("img", { name: "Running" })).toHaveAttribute("data-status-mark", "running");
    expect(screen.getByRole("button", { name: "Complete My Thread" })).toBeDisabled();
  });

  it("blocks completion while a permission is waiting", () => {
    applyAttention(attention("thread-pending", waitingOn("approval")));
    render(<ProjectSidebar />);

    expect(screen.getByRole("button", { name: "Complete My Thread" })).toBeDisabled();
  });

  it("shows a running setup as running", async () => {
    currentThread = makeThread({ id: "thread-pending", mode: "worktree", worktree_managed: true });
    startupTransport.listThreadStartups.mockResolvedValue({ records: [setupStartup("thread-pending", "running")] });
    installWorkspaceMock();

    render(<ProjectSidebar />);

    expect(await screen.findByRole("img", { name: "Running" })).toHaveAttribute("data-status-mark", "running");
  });

  it("shows Setup failed for a startup stopped on setup, loaded when the sidebar connects", async () => {
    currentThread = makeThread({ id: "thread-pending", mode: "worktree", worktree_managed: true });
    startupTransport.listThreadStartups.mockResolvedValue({ records: [setupStartup("thread-pending", "failed", SETUP_FAILED_BLOCK)] });
    installWorkspaceMock();

    render(<ProjectSidebar />);

    expect(await screen.findByRole("img", { name: "Setup failed" })).toHaveAttribute("data-status-mark", "attention");
    expect(screen.queryByRole("img", { name: "Running" })).not.toBeInTheDocument();
  });

  it("shows a row whose first turn is still starting as running", () => {
    currentPendingStartup = { "thread-pending": true };
    installWorkspaceMock();
    render(<ProjectSidebar />);

    expect(within(screen.getByTestId("thread-status")).getByRole("img", { name: "Running" })).toHaveAttribute("data-status-mark", "running");
  });

  it.each([
    ["completed", "Finished", "success"],
    ["errored", "Failed", "error"],
    ["interrupted", "Interrupted", "attention"],
  ] as const)("marks an unseen %s turn as %s", (outcome, label, markState) => {
    applyAttention(attention("thread-pending", endedTurn(outcome)));
    render(<ProjectSidebar />);

    expect(screen.getByRole("img", { name: label })).toHaveAttribute("data-status-mark", markState);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText("Errored")).not.toBeInTheDocument();
  });

  it("shows nothing for an unseen cancelled turn", () => {
    applyAttention(attention("thread-pending", endedTurn("cancelled")));
    render(<ProjectSidebar />);

    expect(screen.getByTestId("thread-status")).toBeEmptyDOMElement();
  });

  it("clears Finished when another client marks the turn seen", () => {
    applyAttention(attention("thread-pending", endedTurn("completed", 7)));
    render(<ProjectSidebar />);
    expect(screen.getByRole("img", { name: "Finished" })).toBeVisible();

    startPushListeners();
    try {
      act(() => pushEmitter.emit("thread.attention", attention("thread-pending", {
        ...endedTurn("completed", 7),
        seen: { sequence: 7, at: "2026-10-11T12:01:00.000Z" },
      })));

      expect(screen.queryByRole("img", { name: "Finished" })).not.toBeInTheDocument();
      expect(screen.getByTestId("thread-status")).toBeEmptyDOMElement();
    } finally {
      stopPushListeners();
    }
  });

  it("keeps Approval required on screen but quiets an on-screen outcome", () => {
    applyAttention(attention("thread-pending", { ...waitingOn("approval"), ...endedTurn("completed") }));
    act(() => threadAttentionStore.setState({ onScreenThreadId: "thread-pending" }));
    render(<ProjectSidebar />);
    expect(screen.getByRole("img", { name: "Approval required" })).toBeVisible();

    applyAttention(attention("thread-pending", endedTurn("completed")));

    expect(screen.getByTestId("thread-status")).toBeEmptyDOMElement();
  });

  it("shows the row's time on its branch line and the exact time in hover details", async () => {
    const updatedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    setupStoreMocks({ thread: makeThread({ id: "thread-updated", title: "Updated Thread", updated_at: updatedAt, last_activity_at: updatedAt }) });
    render(<ProjectSidebar />);

    const row = screen.getByRole("button", { name: /^Provider, Claude Updated Thread.*Local mode Branch, main 5m$/i });
    const exactTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(updatedAt));
    row.focus();
    expect(await screen.findByTestId("thread-preview-thread-updated")).toHaveTextContent(`Updated ${exactTime}`);
  });

  it("marks only the owning sidebar row when a cross-thread send approval arrives", () => {
    setupStoreMocks({ threads: [
      makeThread({ id: "thread-A", title: "Thread A" }),
      makeThread({ id: "thread-B", title: "Thread B" }),
    ] });
    render(<ProjectSidebar />);
    expect(screen.queryByRole("img", { name: "Approval required" })).not.toBeInTheDocument();
    startPushListeners();
    try {
      // The server keys a supervised thread_send wait on the sending thread, not its target.
      act(() => pushEmitter.emit("thread.attention", attention("thread-A", waitingOn("approval"))));

      const ownerRow = screen.getByRole("button", { name: /^Provider, Claude Thread A/ });
      const targetRow = screen.getByRole("button", { name: /^Provider, Claude Thread B/ });
      expect(within(ownerRow).getByRole("img", { name: "Approval required" })).toHaveAttribute("data-status-mark", "attention");
      expect(within(targetRow).getByTestId("thread-status")).toBeEmptyDOMElement();
    } finally {
      stopPushListeners();
    }
  });

  it("names the wait on the title line and keeps the PR chip on the branch line", () => {
    currentThread = makeThread({ id: "thread-pending", status: "active", mode: "worktree", pull_requests: [createMockThreadPullRequest({ number: 42, state: "open" })] });
    currentChecks = {
      "thread-pending": { aggregate: "failing", runs: [{ name: "ci", status: "completed", conclusion: "failure" }] },
    };
    installWorkspaceMock();
    applyAttention(attention("thread-pending", waitingOn("approval")));
    render(<ProjectSidebar />);

    expect(within(screen.getByTestId("thread-status")).getByRole("img", { name: "Approval required" })).toHaveAttribute("data-status-mark", "attention");
    expect(screen.getByTestId("thread-pr-indicator-thread-pending")).toHaveAccessibleName("PR #42, open");
  });

  describe("collapsed project", () => {
    beforeEach(() => {
      useSidebarUiStore.setState({ expandedProjects: new Set([]) });
    });

    it("shows the highest-priority mark among its threads", () => {
      setupStoreMocks({ threads: [
        makeThread({ id: "thread-done", title: "Done" }),
        makeThread({ id: "thread-run", title: "Run" }),
        makeThread({ id: "thread-wait", title: "Wait" }),
      ] });
      useSidebarUiStore.setState({ expandedProjects: new Set([]) });
      applyAttention(attention("thread-done", endedTurn("completed")));
      threadStoreOverrides.runningThreadIds = new Set(["thread-run"]);
      render(<ProjectSidebar />);
      const projectRow = screen.getByTestId("project-row-ws-1");
      expect(within(projectRow).getByRole("img", { name: "Running" })).toBeVisible();

      applyAttention(attention("thread-wait", waitingOn("questions")));

      expect(within(projectRow).getByRole("img", { name: "Answers required" })).toHaveAttribute("data-status-mark", "attention");
      expect(projectRow.querySelectorAll("[data-status-mark]")).toHaveLength(1);
    });

    it("keeps showing activity while Stop is pending", () => {
      threadStoreOverrides.pendingStopCounts = { "thread-pending": 1 };
      installWorkspaceMock();
      render(<ProjectSidebar />);

      expect(within(screen.getByTestId("project-row-ws-1")).getByRole("img", { name: "Running" })).toBeVisible();
    });

    it("shows activity while a thread is being created", () => {
      currentThread = { ...currentThread, clientPreparing: true };
      installWorkspaceMock();
      render(<ProjectSidebar />);

      expect(within(screen.getByTestId("project-row-ws-1")).getByRole("img", { name: "Running" })).toBeVisible();
    });

    it("rolls up a startup stopped on setup in a collapsed project", async () => {
      currentThread = makeThread({ id: "thread-pending", mode: "worktree", worktree_managed: true });
      startupTransport.listThreadStartups.mockResolvedValue({ records: [setupStartup("thread-pending", "failed", SETUP_FAILED_BLOCK)] });
      installWorkspaceMock();
      render(<ProjectSidebar />);

      expect(await within(screen.getByTestId("project-row-ws-1")).findByRole("img", { name: "Setup failed" })).toHaveAttribute("data-status-mark", "attention");
    });

    it("keeps a setup that settles after its project collapses current", async () => {
      useSidebarUiStore.setState({ expandedProjects: new Set(["ws-1"]) });
      currentThread = makeThread({ id: "thread-pending", mode: "worktree", worktree_managed: true });
      startupTransport.listThreadStartups.mockResolvedValue({ records: [setupStartup("thread-pending", "running")] });
      installWorkspaceMock();
      render(<ProjectSidebar />);
      expect(await within(screen.getByTestId("thread-status")).findByRole("img", { name: "Running" })).toBeVisible();

      fireEvent.click(screen.getByRole("button", { name: "Toggle threads for Test" }));
      act(() => useThreadStartupStore.getState().apply(setupStartup("thread-pending", "failed", SETUP_FAILED_BLOCK)));

      expect(within(screen.getByTestId("project-row-ws-1")).getByRole("img", { name: "Setup failed" })).toHaveAttribute("data-status-mark", "attention");
    });

    it("leaves the mark to the rows once expanded", () => {
      useSidebarUiStore.setState({ expandedProjects: new Set(["ws-1"]) });
      applyAttention(attention("thread-pending", waitingOn("approval")));
      render(<ProjectSidebar />);

      expect(within(screen.getByTestId("project-row-ws-1")).queryByRole("img", { name: "Approval required" })).toBeNull();
    });
  });

  it("dims only the content of a client scaffold row, not its status", () => {
    currentThread = {
      ...makeThread({ id: "thread-pending", mode: "worktree", pull_requests: [createMockThreadPullRequest({ number: 42, state: "open" })] }),
      clientPreparing: true,
    } as Thread;
    installWorkspaceMock();
    render(<ProjectSidebar />);

    const row = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });
    const dimmed = screen.getByTestId("thread-title").closest<HTMLElement>("[class*='opacity-[0.72]']");
    expect(row.className).not.toContain("opacity-[0.72]");
    expect(dimmed).not.toBeNull();
    expect(dimmed).not.toContainElement(screen.getByTestId("thread-status"));
    expect(screen.getByTestId("thread-status").closest("[class*='opacity-[0.72]']")).toBeNull();
  });
});

describe("ProjectSidebar PR-ability gating by mode", () => {
  function renderWithThread(
    thread: Thread,
    checks: Record<string, { aggregate: string; runs: unknown[] }> = {},
  ) {
    // Build the state once per install: a fresh object per selector call would
    // invalidate ProjectTree's row memo on every render and loop forever.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = {
      workspaces: [WORKSPACE],
      activeWorkspaceId: "ws-1",
      activeThreadId: null,
      threads: [thread],
      checksById: checks,
      loadWorkspaces: vi.fn(),
      hydrateThreads: vi.fn(),
      setActiveWorkspace: vi.fn(),
      setActiveThread: vi.fn(),
      createWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
      deleteThread: vi.fn(),
      setPendingNewThread: vi.fn(),
      updateThreadTitle: vi.fn(),
      loadWorktrees: vi.fn(),
      worktrees: [],
      worktreesLoadedForWorkspace: null,
      error: null,
      pendingStartupByThreadId: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    vi.mocked(useWorkspaceStore).mockImplementation(((
      selector: (s: unknown) => unknown,
    ) => selector(state)) as never);
    Object.assign(useWorkspaceStore, { getState: () => state });
    return render(<ProjectSidebar />);
  }

  beforeEach(() => {
    threadStoreOverrides.runningThreadIds = undefined;
    threadStoreOverrides.runtimeByThread = undefined;
    useSidebarUiStore.setState({ expandedProjects: new Set(["ws-1"]) });
  });

  afterEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("renders no PR icon for a direct-mode thread even when a PR is linked", () => {
    renderWithThread(
      makeThread({ mode: "direct", pull_requests: [createMockThreadPullRequest({ number: 42, state: "open" })] }),
    );
    expect(screen.queryByTitle(/PR #42/)).toBeNull();
  });

  it("shows the PR number on the branch line, under the title", () => {
    renderWithThread(
      makeThread({ mode: "worktree", pull_requests: [createMockThreadPullRequest({ number: 42, state: "open" })] }),
    );
    const indicator = screen.getByTestId("thread-pr-indicator-thread-1");
    const row = screen.getByRole("button", { name: /^Provider, Claude My Thread/i });
    const title = screen.getByTestId("thread-title");
    expect(indicator).toHaveAttribute("aria-label", "PR #42, open");
    expect(indicator).toHaveTextContent(/^42$/);
    expect(
      title.compareDocumentPosition(indicator) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(row).toContainElement(indicator);
  });

  it("renders a merged PR with the violet merge icon, and never words the CI state", () => {
    renderWithThread(
      makeThread({ mode: "worktree", pull_requests: [createMockThreadPullRequest({ number: 42, state: "merged" })] }),
      {
        "thread-1": {
          aggregate: "failing",
          runs: [{ name: "build", status: "completed", conclusion: "failure" }],
        },
      },
    );
    const indicator = screen.getByLabelText("PR #42, merged");
    expect(indicator).toHaveTextContent(/^42$/);
    expect(indicator.querySelector("svg")).toHaveClass("text-pr-merged");
  });

  it("shows only the PR number on an open PR with failing checks", () => {
    renderWithThread(
      makeThread({ mode: "worktree", pull_requests: [createMockThreadPullRequest({ number: 42, state: "open" })] }),
      {
        "thread-1": {
          aggregate: "failing",
          runs: [{ name: "build", status: "completed", conclusion: "failure" }],
        },
      },
    );
    expect(screen.getByLabelText("PR #42, open")).toHaveTextContent(/^42$/);
  });

  it("renders no status mark or PR line for a quiet non-PR row", () => {
    renderWithThread(
      makeThread({ mode: "direct", pull_requests: [], status: "paused" }),
    );
    expect(screen.getByTestId("thread-status")).toBeEmptyDOMElement();
    expect(screen.queryByTestId("thread-pr-indicator-thread-1")).toBeNull();
  });

  it("renders a worktree indicator only for worktree rows", () => {
    const { unmount } = renderWithThread(makeThread({ mode: "direct" }));
    expect(screen.queryByLabelText("Worktree mode")).toBeNull();
    unmount();

    renderWithThread(
      makeThread({
        mode: "worktree",
        checkout_state: "branchless",
        branch: "HEAD",
      }),
    );
    expect(screen.getByLabelText("Worktree mode")).toBeInTheDocument();
  });

  it("shows a read-only preview on focus with project, detached branch, and provider labels", async () => {
    renderWithThread(
      makeThread({
        id: "thread-branchless",
        title: "Branchless Thread",
        mode: "worktree",
        checkout_state: "branchless",
        branch: "HEAD",
        base_branch: "main",
        status: "paused",
        provider: "codex",
      }),
    );

    screen.getByRole("button", { name: /^Provider, Codex Branchless Thread/i }).focus();

    const preview = await screen.findByTestId(
      "thread-preview-thread-branchless",
    );
    expect(preview).toHaveTextContent("Branchless Thread");
    expect(screen.getByLabelText("Project, Test Project")).toBeInTheDocument();
    expect(within(preview).getByLabelText("Branch, detached from main")).toBeInTheDocument();
    expect(within(preview).queryByLabelText(/^Provider,/)).toBeNull();
    expect(screen.getByLabelText("Provider, Codex")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Status,/)).toBeNull();
    expect(preview).not.toHaveTextContent("Ready");
    expect(preview).not.toHaveTextContent(/ago|now|yesterday/i);
  });
});
