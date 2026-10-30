import { createMockThread, createMockThreadPullRequest, createMockWorkspace } from "@mcode/contracts/testing";
// @vitest-environment jsdom
import { mockTransport } from "@/__tests__/mocks/transport";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@mcode/contracts/models/thread";

const {
  clearScope,
  clearPreviewReferences,
  releaseBrowserScope,
} = vi.hoisted(() => ({




  clearScope: vi.fn().mockResolvedValue(undefined),
  clearPreviewReferences: vi.fn(),
  releaseBrowserScope: vi.fn(),
}));

const reopenThread = vi.mocked(mockTransport.reopenThread);
const retryThreadCleanup = vi.mocked(mockTransport.retryThreadCleanup);

vi.mock("@/transport", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/transport")>();
  return {
    ...original,
    getTransport: () => mockTransport,
  };
});

beforeEach(() => {
  vi.mocked(mockTransport.completeThread).mockReset();
  vi.mocked(mockTransport.reopenThread).mockReset();
  vi.mocked(mockTransport.retryThreadCleanup).mockReset();
  vi.mocked(mockTransport.deleteThread).mockReset().mockResolvedValue(true);
});
vi.mock("@/features/preview/state/previewTabsStore", () => ({
  usePreviewTabsStore: { getState: () => ({ clearScope }) },
}));
vi.mock("@/features/preview/state/previewReferenceQueueStore", () => ({
  usePreviewReferenceQueueStore: {
    getState: () => ({ clearThread: clearPreviewReferences }),
  },
}));
vi.mock("@/features/preview/automation/browserAutomationStore", () => ({
  releaseBrowserAutomationThreadScope: releaseBrowserScope,
  releaseBrowserAutomationWorkspaceScopes: vi.fn(),
}));

import { useWorkspaceStore, type WorkspaceRpcCall } from "../workspaceStore";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { useDiffStore } from "@/stores/diffStore";
import type { Workspace } from "@/transport/types";
import { rememberComposerMode } from "@/lib/composer-mode-preference";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import * as conversationResidency from "@/features/conversation/residency/conversation-residency";
import type { ConversationResidency } from "@/features/conversation/residency/conversation-residency";

function makeWs(overrides?: Partial<Workspace>): Workspace {
  return createMockWorkspace({
    id: "ws-1",
    name: "test",
    path: "/tmp/test",
    pinned: false,
    last_opened_at: null,
    sort_order: 0,
    ...overrides,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useWorkspaceStore.setState({ workspaces: [makeWs()], activeWorkspaceId: null });
  useDiffStore.setState({
    rightPanelByThread: {},
    rightPanelFallbackByWorkspace: {},
  });
});

describe("workspaceStore pin/remove/touch", () => {
  it("applies PR pushes to a thread outside the active workspace without moving its activity clock", () => {
    const thread = createMockThread({ id: "other-thread", workspace_id: "other-workspace" });
    useWorkspaceStore.setState({ threads: [thread], activeWorkspaceId: "ws-1" });
    useWorkspaceStore.getState().applyThreadPullRequests(thread.id, [
      createMockThreadPullRequest({ number: 10, state: "merged" }),
      createMockThreadPullRequest({ number: 20, state: "open" }),
    ]);
    const updated = useWorkspaceStore.getState().threads[0];
    expect(updated.pull_requests.map((pr) => pr.number)).toEqual([10, 20]);
    expect(updated.last_activity_at).toBe(thread.last_activity_at);
  });

  it("setActiveWorkspace calls touchLastOpened RPC", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    await useWorkspaceStore.getState().setActiveWorkspace("ws-1", call as unknown as WorkspaceRpcCall);
    expect(call).toHaveBeenCalledWith("workspace.touchLastOpened", { id: "ws-1" });
  });

  it("pinWorkspace updates local state optimistically and calls RPC", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    await useWorkspaceStore.getState().pinWorkspace("ws-1", true, call as unknown as WorkspaceRpcCall);
    expect(useWorkspaceStore.getState().workspaces[0].pinned).toBe(true);
    expect(call).toHaveBeenCalledWith("workspace.pin", { id: "ws-1", pinned: true });
  });

  it("pinWorkspace reverts on RPC failure", async () => {
    const call = vi.fn().mockRejectedValue(new Error("network error"));
    try {
      await useWorkspaceStore.getState().pinWorkspace("ws-1", true, call as unknown as WorkspaceRpcCall);
    } catch { /* expected */ }
    expect(useWorkspaceStore.getState().workspaces[0].pinned).toBe(false);
  });

  it("removeRecent updates local state optimistically and calls RPC", async () => {
    useWorkspaceStore.setState({
      workspaces: [makeWs({ last_opened_at: Date.now(), pinned: true })],
    });
    const call = vi.fn().mockResolvedValue({ ok: true });
    await useWorkspaceStore.getState().removeRecent("ws-1", call as unknown as WorkspaceRpcCall);
    const ws = useWorkspaceStore.getState().workspaces[0];
    expect(ws.last_opened_at).toBeNull();
    expect(ws.pinned).toBe(false);
    expect(call).toHaveBeenCalledWith("workspace.removeRecent", { id: "ws-1" });
  });
});

describe("workspaceStore reorderWorkspace", () => {
  it("splices order locally and calls workspace.reorder with the bounded index", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        makeWs({ id: "a", name: "a", sort_order: 0 }),
        makeWs({ id: "b", name: "b", sort_order: 1 }),
        makeWs({ id: "c", name: "c", sort_order: 2 }),
      ],
    });
    const call = vi.fn().mockResolvedValue({ ok: true });
    await useWorkspaceStore.getState().reorderWorkspace("c", 0, call as unknown as WorkspaceRpcCall);
    expect(useWorkspaceStore.getState().workspaces.map((w) => w.id)).toEqual(["c", "a", "b"]);
    expect(call).toHaveBeenCalledWith("workspace.reorder", { id: "c", newIndex: 0 });
  });

  it("reverts workspaces order when RPC fails", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        makeWs({ id: "a", name: "a", sort_order: 0 }),
        makeWs({ id: "b", name: "b", sort_order: 1 }),
      ],
    });
    const call = vi.fn().mockRejectedValue(new Error("offline"));
    try {
      await useWorkspaceStore.getState().reorderWorkspace("b", 0, call as unknown as WorkspaceRpcCall);
    } catch { /* expected */ }
    expect(useWorkspaceStore.getState().workspaces.map((w) => w.id)).toEqual(["a", "b"]);
    expect(useWorkspaceStore.getState().error).toMatch(/offline/);
  });
});

describe("workspaceStore new-thread panel transition", () => {
  it("activates a selected resident thread before returning to the event loop", () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const residencySpy = vi.spyOn(conversationResidency, "getConversationResidency")
      .mockReturnValue({ activate } as unknown as ConversationResidency);
    useWorkspaceStore.setState({
      threads: [
        { id: "thread-a" } as WorkspaceThread,
        { id: "thread-b" } as WorkspaceThread,
      ],
      activeThreadId: "thread-a",
    });

    useWorkspaceStore.getState().setActiveThread("thread-b");

    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith("thread-b", expect.any(Array));
    residencySpy.mockRestore();
  });

  it("coalesces non-selection reconciliation until the microtask boundary", async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const residencySpy = vi.spyOn(conversationResidency, "getConversationResidency")
      .mockReturnValue({ activate } as unknown as ConversationResidency);
    const touch = vi.fn().mockResolvedValue(undefined) as unknown as WorkspaceRpcCall;
    useWorkspaceStore.setState({ activeWorkspaceId: null, activeThreadId: null });

    useWorkspaceStore.getState().setActiveWorkspace("ws-1", touch);
    useWorkspaceStore.getState().setActiveWorkspace(null, touch);

    expect(activate).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(null, expect.any(Array));
    residencySpy.mockRestore();
  });

  it("cancels stale reconciliation after workspace selection but allows a later reconcile", async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const residencySpy = vi.spyOn(conversationResidency, "getConversationResidency")
      .mockReturnValue({ activate } as unknown as ConversationResidency);
    const touch = vi.fn().mockResolvedValue(undefined) as unknown as WorkspaceRpcCall;
    useWorkspaceStore.setState({
      activeWorkspaceId: null,
      activeThreadId: "thread-a",
      threads: [
        { id: "thread-a", workspace_id: "ws-1" } as WorkspaceThread,
        { id: "thread-b", workspace_id: "ws-1" } as WorkspaceThread,
      ],
    });

    useWorkspaceStore.getState().setActiveWorkspace("ws-1", touch);
    useWorkspaceStore.getState().setActiveThread("thread-b");

    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenLastCalledWith("thread-b", expect.any(Array));

    useWorkspaceStore.getState().setActiveWorkspace(null, touch);
    await Promise.resolve();

    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenLastCalledWith(null, expect.any(Array));
    residencySpy.mockRestore();
  });

  it("opens the projectless composer without inventing a workspace", () => {
    useWorkspaceStore.setState({
      activeWorkspaceId: null,
      activeThreadId: "thread-1",
      pendingNewThread: false,
    });

    useWorkspaceStore.getState().beginNewThread();

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeWorkspaceId: null,
      activeThreadId: null,
      pendingNewThread: true,
    });
  });

  it("enters a clean pending composer with the last selected mode", () => {
    rememberComposerMode("existing-worktree");
    useWorkspaceStore.setState({
      workspaces: [makeWs(), makeWs({ id: "ws-2", name: "second" })],
      activeWorkspaceId: "ws-2",
      activeThreadId: "thread-1",
      pendingNewThread: false,
      newThreadMode: "worktree",
      newThreadBranch: "feature/old",
    });

    useWorkspaceStore.getState().beginNewThread("ws-2");

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeWorkspaceId: "ws-2",
      activeThreadId: null,
      pendingNewThread: true,
      newThreadMode: "existing-worktree",
      newThreadBranch: "",
    });
  });

  it("closes the threadless right panel without clearing the active thread panel", () => {
    useWorkspaceStore.setState({
      workspaces: [makeWs()],
      activeWorkspaceId: "ws-1",
      activeThreadId: "thread-1",
    });
    const diff = useDiffStore.getState();
    diff.showRightPanel("ws-1", null);
    diff.setRightPanelTab("ws-1", null, "preview");
    diff.showRightPanel("ws-1", "thread-1");
    diff.setRightPanelTab("ws-1", "thread-1", "changes");

    useWorkspaceStore.getState().setPendingNewThread(true);

    expect(diff.getRightPanelVisible("ws-1", null)).toBe(false);
    expect(diff.getRightPanel("ws-1", "thread-1")).toMatchObject({
      visible: true,
      activeTab: "changes",
      openTabs: expect.arrayContaining(["changes"]),
    });
  });
});


function makeThread(overrides: Partial<Thread> = {}): Thread {
  return createMockThread({
    id: "thread-1",
    workspace_id: "workspace-1",
    title: "Lifecycle thread",
    status: "paused",
    mode: "direct",
    worktree_path: null,
    branch: "main",
    checkout_state: "named",
    
    created_at: "2026-08-12T08:00:00.000Z",
    updated_at: "2026-08-12T08:00:00.000Z",
    provider: "claude",
    user_completed_at: null,
    scheduled_deletion_at: null,
    cleanup_state: null,
    cleanup_reason: null,
    delegation_coordinator_thread_id: null,
    ...overrides,
  });
}

describe("workspaceStore completion lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({
      rightPanelByThread: {},
      rightPanelFallbackByWorkspace: {},
    });
    useWorkspaceStore.setState({ threads: [makeThread()], error: null });
  });

  it("releases renderer-owned resources when a completion is applied", async () => {
    const completed = makeThread({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
    });
    const clearTerminal = vi.spyOn(useTerminalStore.getState(), "clearThread");

    useWorkspaceStore.getState().applyThreadLifecycle(completed);

    expect(useWorkspaceStore.getState().threads[0]).toMatchObject(completed);
    expect(releaseBrowserScope).toHaveBeenCalledWith("workspace-1", completed.id);
    expect(clearScope).toHaveBeenCalledWith("workspace-1", completed.id);
    await vi.waitFor(() => expect(clearPreviewReferences).toHaveBeenCalledWith(completed.id));
    expect(clearTerminal).toHaveBeenCalledWith(completed.id);
  });

  it("closes every right-panel tab without changing the workspace fallback", () => {
    const completed = makeThread({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
    });
    const panelStore = useDiffStore.getState();
    panelStore.showRightPanel("workspace-1", null);
    panelStore.setRightPanelTab("workspace-1", null, "changes");
    panelStore.showRightPanel("workspace-1", completed.id);
    panelStore.setRightPanelTab("workspace-1", completed.id, "preview");
    panelStore.ensureRightPanelTab("workspace-1", completed.id, "terminal");

    useWorkspaceStore.getState().applyThreadLifecycle(completed);

    expect(useDiffStore.getState().getRightPanel("workspace-1", completed.id)).toMatchObject({
      visible: false,
      openTabs: [],
      tabInstances: [],
      activeTabId: null,
    });
    expect(useDiffStore.getState().getRightPanel("workspace-1")).toMatchObject({
      visible: true,
      openTabs: ["changes"],
    });
  });

  it("lists a thread first when a lifecycle push introduces it", () => {
    useWorkspaceStore.setState({ threads: [makeThread({ id: "older" })] });

    useWorkspaceStore.getState().applyThreadLifecycle(makeThread({ id: "detached" }));

    expect(useWorkspaceStore.getState().threads.map((thread) => thread.id)).toEqual(["detached", "older"]);
  });

  it("never lists a delegated thread from a lifecycle push and drops one already listed", () => {
    const delegated = makeThread({ id: "delegated", delegation_coordinator_thread_id: "coordinator" });

    useWorkspaceStore.getState().applyThreadLifecycle(delegated);
    expect(useWorkspaceStore.getState().threads.some((thread) => thread.id === "delegated")).toBe(false);

    useWorkspaceStore.setState({ threads: [{ ...delegated, delegation_coordinator_thread_id: null }] });
    useWorkspaceStore.getState().applyThreadLifecycle(delegated);
    expect(useWorkspaceStore.getState().threads.some((thread) => thread.id === "delegated")).toBe(false);
  });

  it("clears tabs from a hidden panel and tolerates a repeated completion event", () => {
    const completed = makeThread({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
    });
    const panelStore = useDiffStore.getState();
    panelStore.setRightPanelTab("workspace-1", completed.id, "preview");
    panelStore.ensureRightPanelTab("workspace-1", completed.id, "terminal");

    useWorkspaceStore.getState().applyThreadLifecycle(completed);
    useWorkspaceStore.getState().applyThreadLifecycle(completed);

    expect(useDiffStore.getState().getRightPanel("workspace-1", completed.id)).toMatchObject({
      visible: false,
      openTabs: [],
      tabInstances: [],
      activeTabId: null,
    });
  });

  it("reopens without clearing preserved renderer state", async () => {
    const reopened = makeThread();
    useWorkspaceStore.setState({
      threads: [makeThread({
        last_activity_at: reopened.last_activity_at,
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
      })],
    });
    reopenThread.mockResolvedValue(reopened);

    await useWorkspaceStore.getState().reopenThread(reopened.id);

    expect(reopenThread).toHaveBeenCalledWith(reopened.id);
    expect(useWorkspaceStore.getState().threads[0]).toMatchObject(reopened);
    expect(clearScope).not.toHaveBeenCalled();
  });

  it("applies a queued manual cleanup retry inline", async () => {
    const queued = makeThread({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
      cleanup_state: "queued",
      cleanup_reason: null,
    });
    useWorkspaceStore.setState({
      threads: [
        makeThread({
          user_completed_at: "2026-08-12T08:00:00.000Z",
          cleanup_state: "blocked",
          cleanup_reason: "The worktree has uncommitted changes.",
        }),
      ],
    });
    retryThreadCleanup.mockResolvedValue(queued);

    await useWorkspaceStore.getState().retryThreadCleanup(queued.id);

    expect(retryThreadCleanup).toHaveBeenCalledWith(queued.id);
    expect(useWorkspaceStore.getState().threads[0]).toMatchObject({
      cleanup_state: "queued",
      cleanup_reason: null,
    });
  });
});


const baseThread = createMockThread({
  id: "t1",
  workspace_id: "ws1",
  branch: "feat/my-feature",
  mode: "worktree",
  worktree_path: "/path/to/worktree",
  status: "active",
  
});

describe("workspaceStore.recordPrCreated", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      threads: [baseThread],
      prUrlsByThreadId: {},
    });
  });

  it("records a created PR on the matching thread", () => {
    useWorkspaceStore.getState().recordPrCreated("t1", 42, "https://github.com/o/r/pull/42");

    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "t1");
    expect(thread?.pull_requests[0]?.number).toBe(42);
    expect(thread?.pull_requests[0]?.state).toBe("open");
  });

  it("stores the pr url in prUrlsByThreadId keyed by thread id", () => {
    useWorkspaceStore.getState().recordPrCreated("t1", 42, "https://github.com/o/r/pull/42");

    expect(useWorkspaceStore.getState().prUrlsByThreadId["t1"]).toBe(
      "https://github.com/o/r/pull/42",
    );
  });

  it("leaves other threads unchanged", () => {
    const other: Thread = { ...baseThread, id: "t2", pull_requests: [] };
    useWorkspaceStore.setState({ threads: [baseThread, other] });

    useWorkspaceStore.getState().recordPrCreated("t1", 42, "https://github.com/o/r/pull/42");

    const unchanged = useWorkspaceStore.getState().threads.find((t) => t.id === "t2");
    expect(unchanged?.pull_requests[0]?.number).toBeUndefined();
  });

  it("is a no-op when the thread id is not found", () => {
    useWorkspaceStore.getState().recordPrCreated("not-exist", 1, "https://github.com/o/r/pull/1");

    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "t1");
    expect(thread?.pull_requests[0]?.number).toBeUndefined();
    expect(useWorkspaceStore.getState().prUrlsByThreadId["not-exist"]).toBeUndefined();
  });
});

describe("workspaceStore.recordPullRequestLink", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      threads: [],
      prUrlsByThreadId: {},
    });
  });

  it("records the URL before the linked Review task is loaded", () => {
    useWorkspaceStore.getState().recordPullRequestLink(
      "review-thread",
      42,
      "https://github.com/o/r/pull/42",
      "open",
    );

    expect(useWorkspaceStore.getState().prUrlsByThreadId["review-thread"]).toBe(
      "https://github.com/o/r/pull/42",
    );
    expect(useWorkspaceStore.getState().threads).toEqual([]);
  });

  it("updates an already loaded thread with the remote PR state", () => {
    useWorkspaceStore.setState({ threads: [baseThread] });

    useWorkspaceStore.getState().recordPullRequestLink(
      "t1",
      42,
      "https://github.com/o/r/pull/42",
      "merged",
    );

    expect(useWorkspaceStore.getState().threads[0]).toMatchObject({
      pull_requests: [createMockThreadPullRequest({ number: 42, state: "merged", url: "https://github.com/o/r/pull/42" })],
    });
  });
});

describe("workspaceStore.deleteThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      threads: [baseThread],
      prUrlsByThreadId: { t1: "https://github.com/o/r/pull/42" },
      activeThreadId: null,
      error: null,
    });
  });

  it("removes the thread's pr url from prUrlsByThreadId", async () => {
    await useWorkspaceStore.getState().deleteThread("t1", false);

    expect(useWorkspaceStore.getState().prUrlsByThreadId["t1"]).toBeUndefined();
  });
});

describe("workspaceStore whole thread hydration", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ threads: [], activeThreadId: null });
    vi.mocked(mockTransport.listAllThreads).mockReset();
  });

  it("loads a thread from a project that has never been expanded", async () => {
    vi.mocked(mockTransport.listAllThreads).mockResolvedValue([
      createMockThread({ id: "unopened", workspace_id: "never-expanded" }),
    ]);
    await useWorkspaceStore.getState().hydrateThreads();
    expect(useWorkspaceStore.getState().threads.map((thread) => [thread.id, thread.workspace_id]))
      .toEqual([["unopened", "never-expanded"]]);
  });

  it("does not duplicate a creation pushed before its RPC response", async () => {
    const thread = createMockThread({ id: "created", workspace_id: "ws-1" });
    useWorkspaceStore.setState({ activeWorkspaceId: "ws-1" });
    vi.mocked(mockTransport.createThread).mockImplementationOnce(async () => {
      useWorkspaceStore.getState().applyThreadCreated(thread);
      return thread;
    });
    await useWorkspaceStore.getState().createThread("Created", "direct", "main");
    expect(useWorkspaceStore.getState().threads.map((candidate) => candidate.id)).toEqual(["created"]);
  });

  it("retains a newer lifecycle push when an earlier snapshot arrives", async () => {
    const original = createMockThread({ id: "racing", title: "Old title" });
    useWorkspaceStore.setState({ threads: [original] });
    let finish: (threads: Thread[]) => void = () => { throw new Error("Request has not started"); };
    vi.mocked(mockTransport.listAllThreads).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const loading = useWorkspaceStore.getState().hydrateThreads();
    useWorkspaceStore.getState().applyThreadLifecycle({ ...original, title: "Pushed title" });
    finish([original]);
    await loading;
    expect(useWorkspaceStore.getState().threads.map((thread) => thread.title)).toEqual(["Pushed title"]);
  });

  it("releases nothing when hydration and a replayed push carry an already-completed thread", async () => {
    const clearTerminal = vi.spyOn(useTerminalStore.getState(), "clearThread");
    const done = createMockThread({ id: "done", workspace_id: "ws-1", user_completed_at: "2026-08-12T08:00:00.000Z" });
    vi.mocked(mockTransport.listAllThreads).mockResolvedValue([done]);

    await useWorkspaceStore.getState().hydrateThreads();
    useWorkspaceStore.getState().applyThreadLifecycle(done);

    expect(clearTerminal).not.toHaveBeenCalledWith("done");
    expect(releaseBrowserScope).not.toHaveBeenCalledWith("ws-1", "done");
    clearTerminal.mockRestore();
  });

  it("preserves preparing placeholders while replacing an obsolete server snapshot", async () => {
    useWorkspaceStore.setState({ threads: [
      createMockThread({ id: "obsolete" }),
      { ...createMockThread({ id: "placeholder" }), clientPreparing: true },
    ] });
    vi.mocked(mockTransport.listAllThreads).mockResolvedValue([createMockThread({ id: "persisted" })]);
    await useWorkspaceStore.getState().hydrateThreads();
    expect(useWorkspaceStore.getState().threads.map((thread) => thread.id).sort()).toEqual(["persisted", "placeholder"]);
  });

  it("keeps creations and deletions pushed during hydration", async () => {
    const deleted = createMockThread({ id: "deleted", workspace_id: "ws-1" });
    useWorkspaceStore.setState({ threads: [deleted] });
    let finish: (threads: Thread[]) => void = () => { throw new Error("Request has not started"); };
    vi.mocked(mockTransport.listAllThreads).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const loading = useWorkspaceStore.getState().hydrateThreads();
    useWorkspaceStore.getState().applyThreadCreated(createMockThread({ id: "pushed" }));
    useWorkspaceStore.getState().applyThreadDeleted("deleted");
    finish([deleted]);
    await loading;
    expect(useWorkspaceStore.getState().threads.map((thread) => thread.id)).toEqual(["pushed"]);
  });
});
