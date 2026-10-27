import { createMockApproval, createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
// @vitest-environment jsdom
import { selectDockApprovals, useApprovalStore } from "@/stores/approvalStore";
import { act } from "@testing-library/react";
import { mockTransport } from "@/__tests__/mocks/transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadStartup } from "@mcode/contracts/thread-startup";
import type { Thread } from "@/transport";

vi.mock("@/transport", () => ({
  getTransport: vi.fn(() => mockTransport),
}));

vi.mock("@/components/chat/useFileAutocomplete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/chat/useFileAutocomplete")>()),
  clearFileListCache: vi.fn(),
}));

vi.mock("@/features/preview/navigation/open-url-in-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/preview/navigation/open-url-in-preview")>()),
  openActionPreview: vi.fn(async () => undefined),
}));

import { pushEmitter } from "./ws-transport";
import { openActionPreview } from "@/features/preview/navigation/open-url-in-preview";
import { startPushListeners, stopPushListeners } from "./ws-events";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useProviderCatalogStore } from "@/stores/providerCatalogStore";
import { useDiffStore } from "@/stores/diffStore";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { onPtyExit } from "@/features/terminal/adapters/pty-data-registry";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useThreadStartupStore } from "@/features/thread-startup";
import { clearFileListCache } from "@/components/chat/useFileAutocomplete";

import { useProjectIconStore } from "@/features/projects/icons/projectIconStore";
import { resetThreadStoreForTests, getTestThreadToolCalls } from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord } from "@/stores/thread-record";

describe("workspace deletion Browser profiles", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const remove = vi.fn(async () => undefined);
  const originalBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");

  beforeEach(() => {
    remove.mockClear();
    Object.defineProperty(window, "desktopBridge", { configurable: true, value: { preview: { profiles: { remove } } } });
    useWorkspaceStore.setState({ workspaces: [createMockWorkspace({ id: workspaceId })], activeWorkspaceId: null });
    startPushListeners();
  });
  afterEach(() => {
    stopPushListeners();
    if (originalBridge) Object.defineProperty(window, "desktopBridge", originalBridge);
    else delete window.desktopBridge;
  });

  it("removes the local profile when any client deletes the workspace", () => {
    pushEmitter.emit("workspace.deleted", { workspaceId });
    expect(remove.mock.calls).toEqual([[workspaceId]]);
    expect(useWorkspaceStore.getState().workspaces).toEqual([]);
  });

  it("removes workspace state without a desktop bridge", () => {
    delete window.desktopBridge;
    pushEmitter.emit("workspace.deleted", { workspaceId });
    expect(useWorkspaceStore.getState().workspaces).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("workspace.iconChanged", () => {
  beforeEach(() => {
    useProjectIconStore.setState({ iconsByWorkspaceId: {} });
    startPushListeners();
  });
  afterEach(() => stopPushListeners());

  it("replaces the cached icon when any client chooses a new one", () => {
    const icon = {
      workspaceId: "ws-1",
      source: "chosen",
      chosenMissing: false,
      path: "brand.svg",
      version: "0123456789abcdef",
      url: "/workspace-images/ws-1?path=brand.svg&use=icon&v=0123456789abcdef",
    } as const;
    pushEmitter.emit("workspace.iconChanged", { workspaceId: "ws-1", icon });
    expect(useProjectIconStore.getState().iconsByWorkspaceId).toEqual({ "ws-1": icon });
  });

  it("ignores a payload that does not match the channel schema", () => {
    pushEmitter.emit("workspace.iconChanged", { workspaceId: "ws-1", icon: { workspaceId: "ws-1", source: "remote" } });
    expect(useProjectIconStore.getState().iconsByWorkspaceId).toEqual({});
  });
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return createMockThread({
    id: "thread-1",
    workspace_id: "ws-1",
    title: "Thread",
    status: "active",
    mode: "worktree",
    worktree_path: "/repo-wt",
    branch: "feat/old",
    checkout_state: "named",
    base_branch: null,
    head_sha: null,
    worktree_managed: true,
    pr_number: 10,
    pr_status: "OPEN",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    provider: "claude",
    user_completed_at: null,
    scheduled_deletion_at: null,
    scheduled_resume: null,
    ...overrides,
  });
}

describe("ws-events thread.lifecycleChanged", () => {
  afterEach(() => {
    stopPushListeners();
    vi.restoreAllMocks();
  });

  it("advances activity pushes without allowing an older push to regress the clock", () => {
    useWorkspaceStore.setState({ threads: [makeThread({ last_activity_at: "2026-01-01T00:00:00.000Z" })] });
    startPushListeners();
    pushEmitter.emit("thread.activity", { threadId: "thread-1", at: "2026-01-03T00:00:00.000Z" });
    pushEmitter.emit("thread.activity", { threadId: "thread-1", at: "2026-01-02T00:00:00.000Z" });
    expect(useWorkspaceStore.getState().threads[0].last_activity_at).toBe("2026-01-03T00:00:00.000Z");
  });

  it("applies a server-authoritative completion push", () => {
    useWorkspaceStore.setState({ threads: [makeThread()] });
    startPushListeners();

    pushEmitter.emit("thread.lifecycleChanged", {
      thread: makeThread({
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
      }),
    });

    expect(useWorkspaceStore.getState().threads).toEqual([
      expect.objectContaining({
        id: "thread-1",
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
      }),
    ]);
  });

  it("removes a thread after an automatic deletion push", () => {
    useWorkspaceStore.setState({ threads: [makeThread(), makeThread({ id: "thread-2" })] });
    startPushListeners();

    pushEmitter.emit("thread.deleted", { threadId: "thread-1" });

    expect(useWorkspaceStore.getState().threads.map((thread) => thread.id)).toEqual(["thread-2"]);
  });
});

describe("ws-events thread.resumeScheduled", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ threads: [makeThread({ id: "thread-1" })] });
    startPushListeners();
  });
  afterEach(() => stopPushListeners());

  const scheduledResume = () => useWorkspaceStore.getState().threads[0]?.scheduled_resume;

  it("shows a resume another client scheduled and clears it when cancelled", () => {
    pushEmitter.emit("thread.resumeScheduled", { threadId: "thread-1", resume: { turnId: "turn-7", at: "2026-10-11T14:05:00.000Z" } });
    expect(scheduledResume()).toEqual({ turnId: "turn-7", at: "2026-10-11T14:05:00.000Z" });

    pushEmitter.emit("thread.resumeScheduled", { threadId: "thread-1", resume: null });
    expect(scheduledResume()).toBeNull();
  });

  it("ignores a malformed schedule", () => {
    pushEmitter.emit("thread.resumeScheduled", { threadId: "thread-1", resume: { turnId: "turn-7", at: "soon" } });
    expect(scheduledResume()).toBeNull();
  });
});

describe("ws-events thread.status", () => {
  afterEach(() => {
    stopPushListeners();
    resetThreadStoreForTests();
  });

  it("stops in-flight calls on interruption but leaves a background call for its late result", () => {
    const running = { toolInput: {}, output: null, isError: false, isComplete: false };
    resetThreadStoreForTests({
      records: new Map([["thread-1", {
        ...createEmptyThreadRecord(),
        toolCalls: [
          { ...running, id: "agent-bg", toolName: "Agent", background: true },
          { ...running, id: "read-1", toolName: "Read" },
        ],
      }]]),
    });
    startPushListeners();

    pushEmitter.emit("thread.status", { threadId: "thread-1", status: "interrupted" });

    expect(getTestThreadToolCalls("thread-1")).toEqual([
      expect.objectContaining({ id: "agent-bg", isComplete: false, output: null }),
      expect.objectContaining({ id: "read-1", isComplete: true, isError: true, output: "Cancelled" }),
    ]);
  });
});

describe("ws-events thread.startup.updated", () => {
  afterEach(() => {
    stopPushListeners();
    useThreadStartupStore.setState({ recordsByStartupId: {}, startupIdByThreadId: {} });
  });

  it("ignores an out-of-order startup revision", () => {
    const current: ThreadStartup = {
      startupId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "ws-1",
      kind: "direct",
      state: "running",
      phase: "agent",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "agent", state: "running" },
      ],
      transcript: [],
      cancellation: "none",
      revision: 2,
      threadId: "00000000-0000-4000-8000-000000000002",
      createdAt: "2026-09-02T12:00:00.000Z",
      updatedAt: "2026-09-02T12:00:01.000Z",
    };
    startPushListeners();

    pushEmitter.emit("thread.startup.updated", current);
    pushEmitter.emit("thread.startup.updated", {
      ...current,
      revision: 1,
      state: "failed",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "agent", state: "failed" },
      ],
      error: { code: "STALE", message: "stale", retryable: true },
    });

    expect(useThreadStartupStore.getState().recordsByStartupId[current.startupId]).toMatchObject({
      revision: 2,
      state: "running",
    });
  });
});

describe("ws-events Project Actions", () => {
  const run = {
    threadId: "thread-1",
    workspaceId: "ws-1",
    actionId: "build",
    runId: "run-1",
    revision: 1,
    terminalSessionId: "terminal-1",
    trigger: "manual" as const,
    actionName: "Build",
    status: "completed" as const,
    snapshot: { platform: "windows" as const, script: "bun run build", checkoutPath: "C:\\repo", terminal: null, environmentNames: [] },
    createdAt: "2026-08-22T12:00:00.000Z",
    startedAt: "2026-08-22T12:00:00.000Z",
    finishedAt: "2026-08-22T12:00:01.000Z",
    exitCode: 0,
    port: null,
  };
  afterEach(() => {
    stopPushListeners();
    vi.mocked(openActionPreview).mockClear();
  });

  it("opens the requested preview once for the thread and still records the run", () => {
    useProjectActionStore.setState({ runsByThread: {} });
    startPushListeners();

    pushEmitter.emit("workspace.environment.action.updated", {
      threadId: run.threadId,
      actionId: run.actionId,
      runId: run.runId,
      run,
      openPreview: { url: "http://localhost:5173/" },
    });

    expect(vi.mocked(openActionPreview).mock.calls).toEqual([[{ threadId: "thread-1", url: "http://localhost:5173/" }]]);
    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build?.status).toBe("completed");
  });

  it("does not open a preview for a push that did not ask for one", () => {
    useProjectActionStore.setState({ runsByThread: {} });
    startPushListeners();

    pushEmitter.emit("workspace.environment.action.updated", {
      threadId: run.threadId,
      actionId: run.actionId,
      runId: run.runId,
      run,
    });

    expect(openActionPreview).not.toHaveBeenCalled();
    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build?.status).toBe("completed");
  });

  it("applies retained Action output outside Thread Overview and clears it on Thread deletion", () => {
    useProjectActionStore.setState({ runsByThread: {} });
    startPushListeners();

    pushEmitter.emit("workspace.environment.action.updated", {
      threadId: run.threadId,
      actionId: run.actionId,
      runId: run.runId,
      run,
    });
    expect(useProjectActionStore.getState().runsByThread["thread-1"]?.build?.status).toBe("completed");

    pushEmitter.emit("thread.deleted", { threadId: "thread-1" });
    expect(useProjectActionStore.getState().runsByThread["thread-1"]).toBeUndefined();
  });
});

describe("ws-events thread.checkoutChanged", () => {
  beforeEach(() => {
    stopPushListeners();
    useWorkspaceStore.setState({
      threads: [makeThread()],
      prUrlsByThreadId: { "thread-1": "https://example.test/pr/10", other: "keep" },
      checksById: {
        "thread-1": { aggregate: "passing", runs: [], fetchedAt: 1 },
        other: { aggregate: "no_checks", runs: [], fetchedAt: 2 },
      },
    });
  });

  it("patches thread checkout fields and clears stale PR/check caches", () => {
    startPushListeners();

    pushEmitter.emit("thread.checkoutChanged", {
      threadId: "thread-1",
      workspaceId: "ws-1",
      branch: "HEAD",
      checkoutState: "branchless",
      baseBranch: "feat/old",
      headSha: "3f9a1c2",
      prNumber: null,
      prStatus: null,
    });

    const state = useWorkspaceStore.getState();
    expect(state.threads[0]).toMatchObject({
      branch: "HEAD",
      checkout_state: "branchless",
      base_branch: "feat/old",
      head_sha: "3f9a1c2",
      pr_number: null,
      pr_status: null,
    });
    expect(state.prUrlsByThreadId).toEqual({ other: "keep" });
    expect(state.checksById).toEqual({
      other: { aggregate: "no_checks", runs: [], fetchedAt: 2 },
    });
  });

  it("keeps PR and check caches when a detached HEAD only moves to another commit", () => {
    startPushListeners();
    const detached = {
      threadId: "thread-1",
      workspaceId: "ws-1",
      branch: "HEAD",
      checkoutState: "branchless" as const,
      baseBranch: "feat/old",
      prNumber: 10,
      prStatus: "OPEN" as const,
    };
    pushEmitter.emit("thread.checkoutChanged", { ...detached, headSha: "3f9a1c2" });
    useWorkspaceStore.setState({
      prUrlsByThreadId: { "thread-1": "https://example.test/pr/10" },
      checksById: { "thread-1": { aggregate: "passing", runs: [], fetchedAt: 1 } },
    });

    pushEmitter.emit("thread.checkoutChanged", { ...detached, headSha: "9b8e7d6" });

    const state = useWorkspaceStore.getState();
    expect(state.threads[0].head_sha).toBe("9b8e7d6");
    expect(state.prUrlsByThreadId).toEqual({ "thread-1": "https://example.test/pr/10" });
    expect(state.checksById["thread-1"]?.aggregate).toBe("passing");
  });
});

describe("ws-events skills.changed", () => {
  afterEach(() => {
    stopPushListeners();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces a burst of provider invalidations into one cache refresh", () => {
    vi.useFakeTimers();
    const invalidate = vi.spyOn(useProviderCatalogStore.getState(), "invalidate");
    startPushListeners();

    const change = { providerIds: ["claude", "copilot", "cursor"] as const };
    pushEmitter.emit("skills.changed", change);
    pushEmitter.emit("skills.changed", change);
    pushEmitter.emit("skills.changed", change);
    vi.advanceTimersByTime(100);

    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith(change.providerIds);
  });
});

describe("ws-events provider.catalogChanged", () => {
  afterEach(() => {
    stopPushListeners();
    vi.restoreAllMocks();
  });

  it("drops malformed catalog changes before store reconciliation", () => {
    const reconcile = vi.spyOn(useProviderCatalogStore.getState(), "reconcile");
    startPushListeners();

    pushEmitter.emit("provider.catalogChanged", { request: { providerId: "codex" } });

    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("ws-events approval.requested", () => {
  it.each(["approval.requested", "approval.resolved"] as const)("logs and drops malformed %s without changing state", (channel) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = createMockApproval({ requestId: "pending", threadId: "thread-1" });
    useApprovalStore.setState({ approvals: [{ ...request, settled: false }] });
    const before = useApprovalStore.getState();
    startPushListeners();
    expect(() => pushEmitter.emit(channel, { requestId: "pending", secret: "private" })).not.toThrow();
    expect(useApprovalStore.getState()).toBe(before);
    expect(warn.mock.calls).toEqual([[`[ws-events] dropped invalid ${channel} message`]]);
  });

  it("shows a cross-thread send approval only in the owner's dock", () => {
    const request = createMockApproval({ requestId: "approval-send", threadId: "thread-A", subject: { kind: "thread_operation", operation: "thread_send", targetThreadId: "thread-B", message: "Needs approval." } });
    useApprovalStore.setState({ approvals: [] });
    startPushListeners();
    const dockOf = (threadId: string) => selectDockApprovals(useApprovalStore.getState().approvals, threadId);
    expect(dockOf("thread-A")).toEqual([]);
    expect(dockOf("thread-B")).toEqual([]);

    act(() => pushEmitter.emit("approval.requested", request));

    expect(dockOf("thread-A").map(({ requestId, threadId, subject, settled }) => ({ requestId, threadId, subject, settled }))).toEqual([{
      requestId: "approval-send",
      threadId: "thread-A",
      subject: { kind: "thread_operation", operation: "thread_send", targetThreadId: "thread-B", message: "Needs approval." },
      settled: false,
    }]);
    expect(dockOf("thread-B")).toEqual([]);
  });

  afterEach(() => {
    stopPushListeners();
    vi.restoreAllMocks();
  });

  it("puts a pushed command approval in the dock, not the transcript", () => {
    const request = createMockApproval({ requestId: "permission-1", threadId: "thread-1" });
    useApprovalStore.setState({ approvals: [] });
    startPushListeners();

    expect(selectDockApprovals(useApprovalStore.getState().approvals, "thread-1")).toEqual([]);
    pushEmitter.emit("approval.requested", request);

    expect(selectDockApprovals(useApprovalStore.getState().approvals, "thread-1"))
      .toMatchObject([{ requestId: "permission-1", subject: { kind: "command", command: "git status" } }]);
  });
});

describe("ws-events turn.persisted Review invalidation", () => {
  beforeEach(() => {
    stopPushListeners();
    useWorkspaceStore.setState({ threads: [makeThread()] });
    useDiffStore.setState({ diffRevisionByScope: {} });
    startPushListeners();
  });

  afterEach(() => stopPushListeners());

  it("invalidates Review only when the persisted turn changed files", () => {
    pushEmitter.emit("turn.persisted", {
      threadId: "thread-1",
      messageId: "message-1",
      settledMessage: { id: "message-1", sequence: 1 },
      toolCallCount: 0,
      filesChanged: [],
    });
    expect(useDiffStore.getState().diffRevisionByScope["thread-1"]).toBeUndefined();

    pushEmitter.emit("turn.persisted", {
      threadId: "thread-1",
      messageId: "message-2",
      settledMessage: { id: "message-2", sequence: 2 },
      toolCallCount: 0,
      filesChanged: ["src/changed.ts"],
    });
    expect(useDiffStore.getState().diffRevisionByScope["thread-1"]).toBe(1);
  });
});

describe("ws-events files.changed", () => {
  beforeEach(() => {
    useDiffStore.setState({ diffRevisionByScope: {} });
    vi.mocked(clearFileListCache).mockClear();
  });

  afterEach(() => stopPushListeners());

  it("invalidates the file autocomplete cache and bumps the diff revision for the pushed scope", () => {
    startPushListeners();

    pushEmitter.emit("files.changed", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      changedPaths: ["new-folder/second.ts"],
      wholeWorkspace: false,
    });

    expect(clearFileListCache).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(useDiffStore.getState().diffRevisionByScope["thread-1"]).toBe(1);
  });

  it("falls back to the workspace scope when the push carries no threadId", () => {
    startPushListeners();

    pushEmitter.emit("files.changed", {
      workspaceId: "ws-1",
      changedPaths: ["new-folder/second.ts"],
      wholeWorkspace: false,
    });

    expect(clearFileListCache).toHaveBeenCalledWith("ws-1", undefined);
    expect(useDiffStore.getState().diffRevisionByScope["ws-1"]).toBe(1);
  });
});

describe("ws-events terminal.exit", () => {
  afterEach(() => {
    stopPushListeners();
    vi.useRealTimers();
  });

  it("reports a natural exit and keeps the exited terminal until it is closed", () => {
    vi.useFakeTimers();
    useTerminalStore.setState({
      terminals: {
        "thread-1": [{ id: "pty-1", threadId: "thread-1", label: "PowerShell" }],
      },
      ptyToThread: { "pty-1": "thread-1" },
    });
    const onExit = vi.fn();
    const unsubscribe = onPtyExit("pty-1", onExit);
    startPushListeners();

    pushEmitter.emit("terminal.exit", { ptyId: "pty-1", code: 7 });

    expect(onExit).toHaveBeenCalledWith({ ptyId: "pty-1", code: 7 });
    vi.advanceTimersByTime(60_000);
    expect(useTerminalStore.getState().terminals["thread-1"]).toEqual([
      expect.objectContaining({
        id: "pty-1",
        state: "exited",
        exitCode: 7,
        exit: { code: 7, signal: null, reason: "natural" },
      }),
    ]);
    unsubscribe();
  });
});
