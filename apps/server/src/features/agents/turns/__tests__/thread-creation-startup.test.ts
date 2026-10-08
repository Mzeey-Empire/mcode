import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { createThreadPersistenceTestRuntime } from "../../../thread-control/testing/thread-persistence-test-runtime.js";
let persistenceRuntime: ReturnType<typeof createThreadPersistenceTestRuntime>;
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadBranchingService, type BranchedThreadLifecycle, type CreateBranchedThreadInput } from "../../../projects/worktrees/thread-branching-service.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { ThreadService } from "../../../thread-control/index.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
import { ThreadCreationCoordinator } from "../thread-creation-coordinator.js";
import type { TurnAdmissionDispatchCoordinator } from "../turn-admission-dispatch-coordinator.js";

const directStartupId = "00000000-0000-4000-8000-000000000001";
const managedStartupId = "00000000-0000-4000-8000-000000000002";
const cancelledStartupId = "00000000-0000-4000-8000-000000000003";

function requireThreadCreationOptions(options: Parameters<ThreadService["create"]>[4]) {
  if (!options) throw new Error("Expected thread creation options");
  return options;
}

async function harness() {
  const db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
  const workspaces = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);
  const threads = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
  const workspace = await workspaces.create("Project", "/project");
  const startups = new ThreadStartupService(new ThreadStartupRepo(persistenceRuntime.reader, persistenceRuntime.writer), persistenceRuntime.writer);
  const threadService = {
    create: vi.fn(),
    delete: vi.fn(async () => true),
  } as unknown as ThreadService;
  const admissions = {
    admitInitialAutomaticTurn: vi.fn<TurnAdmissionDispatchCoordinator["admitInitialAutomaticTurn"]>(async () => ({ kind: "not-managed" })),
    createAttachedExistingWorktreeThread: vi.fn<TurnAdmissionDispatchCoordinator["createAttachedExistingWorktreeThread"]>(async (input) => {
      const thread = await threads.create(input.workspaceId, input.title, "worktree", "feature/existing", false, input.provider);
      await threads.updateWorktreePath(thread.id, input.existingWorktreePath);
      return { ...thread, worktree_path: input.existingWorktreePath };
    }),
  };
  const gitRepository = { fetchBranch: vi.fn() };
  const coordinator = new ThreadCreationCoordinator(
    threads,
    () => threadService,
    admissions as never,
    gitRepository,
    undefined,
    undefined,
    () => startups,
  );
  return { db, workspace, threads, startups, threadService, admissions, gitRepository, coordinator };
}

async function branchHarness() {
  const base = await harness();
  const messages = new MessageRepo(persistenceRuntime.reader, persistenceRuntime.writer);
  const parent = await base.threads.create(base.workspace.id, "Parent", "direct", "main", true, "claude");
  const fork = await messages.create(parent.id, "user", "Start here", 1);
  const handoffs = { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "Parent handoff" })) };
  const worktrees = { listWorktrees: vi.fn(async () => [{ path: "/project/existing", branch: "feature/existing" }]) };
  const branching = new ThreadBranchingService(
    base.threads,
    messages,
    base.threadService,
    worktrees as never,
    handoffs as never,
    { platform: "win32" } as never,
  );
  const makeCoordinator = (startupService = base.startups) => new ThreadCreationCoordinator(
    base.threads, () => base.threadService, base.admissions as never, base.gitRepository,
    () => branching, undefined, () => startupService,
  );
  return { ...base, parent, fork, handoffs, makeCoordinator };
}

describe("ThreadCreationCoordinator startup lifecycle", () => {
  it("records an attached checkout and skips setup before first dispatch", async () => {
    const { workspace, startups, coordinator } = await harness();
    const created = await coordinator.createInitialTurn({ workspaceId: workspace.id, content: "Use existing",
      mode: "worktree", existingWorktreePath: "/project/existing", startupId: managedStartupId });
    expect(created.kind).toBe("dispatch");
    expect(startups.get(managedStartupId)).toMatchObject({ kind: "attached-worktree", phase: "agent", steps: [
      { phase: "thread", state: "completed" },
      { phase: "worktree", state: "completed", detail: { phase: "worktree", mode: "opened", folderName: "existing", path: "/project/existing" } },
      { phase: "setup", state: "skipped", detail: { phase: "setup", skipReason: "not-configured" } },
      { phase: "agent", state: "running" },
    ] });
  });

  it("branches into an attached checkout, skips setup and dispatches its first turn", async () => {
    const { workspace, startups, parent, fork, makeCoordinator } = await branchHarness();
    const coordinator = makeCoordinator();
    const created = await coordinator.createInitialTurn({ workspaceId: workspace.id, content: "Branch here",
      mode: "worktree", existingWorktreePath: "/project/existing", parentThreadId: parent.id,
      forkedFromMessageId: fork.id, startupId: managedStartupId });
    expect(created).toMatchObject({ kind: "dispatch", command: { content: "Branch here", providerWireOverride: "Parent handoff" } });
    expect(startups.get(managedStartupId)).toMatchObject({ kind: "attached-worktree", phase: "agent", steps: [
      { phase: "thread", state: "completed" },
      { phase: "worktree", state: "completed", detail: { phase: "worktree", mode: "opened", folderName: "existing", path: "/project/existing" } },
      { phase: "setup", state: "skipped", detail: { phase: "setup", skipReason: "not-configured" } },
      { phase: "agent", state: "running" },
    ] });
    await coordinator.startInitialAgent(managedStartupId);
    await coordinator.completeInitialAgent(managedStartupId);
    expect(startups.get(managedStartupId)?.state).toBe("completed");
  });

  it.each(["direct", "worktree"] as const)("records the real PR fetch phase in %s mode", async (mode) => {
    const { workspace, threads, startups, threadService, gitRepository, coordinator } = await harness();
    vi.mocked(gitRepository.fetchBranch).mockImplementation(async () => {
      expect(startups.get(managedStartupId)).toMatchObject({ phase: "fetch", steps: expect.arrayContaining([
        expect.objectContaining({ phase: "fetch", state: "running", detail: { phase: "fetch", ref: "pull/42/head", pullRequestNumber: 42, branch: "feature/pr" } }),
      ]) });
    });
    vi.mocked(threadService.create).mockImplementation(async (workspaceId, title, _mode, branch, options) => {
      const thread = await threads.create(workspaceId, title, "worktree", branch, true, options?.provider);
      await options?.lifecycle?.onThreadPersisted(thread);
      await threads.updateWorktreePath(thread.id, "/project/created");
      return { ...thread, worktree_path: "/project/created" };
    });
    await coordinator.createInitialTurn({ workspaceId: workspace.id, content: "Review", mode,
      branch: "feature/pr", pullRequestNumber: 42, startupId: managedStartupId });
    if (mode === "worktree") {
      expect(startups.get(managedStartupId)?.steps[2].detail).toEqual({ phase: "worktree", mode: "created", folderName: "created", path: "/project/created" });
      await startups.skip(managedStartupId, "setup", { phase: "setup", skipReason: "not-configured" });
    }
    await coordinator.startInitialAgent(managedStartupId);
    expect(startups.get(managedStartupId)?.steps[1]).toMatchObject({ phase: "fetch", state: "completed",
      detail: { phase: "fetch", ref: "pull/42/head", pullRequestNumber: 42, branch: "feature/pr" } });
    expect(gitRepository.fetchBranch).toHaveBeenCalledWith(workspace.id, "feature/pr", 42);
  });

  it("retains Git stderr instead of execFile's command-prefixed message", async () => {
    const { workspace, startups, gitRepository, coordinator } = await harness();
    const error = Object.assign(new Error("Command failed: git fetch origin pull/42/head\nfatal: Could not resolve host: github.com"),
      { stderr: "\n  fatal: Could not resolve host: github.com  \nmore context" });
    gitRepository.fetchBranch.mockRejectedValue(error);
    await expect(coordinator.createInitialTurn({ workspaceId: workspace.id, content: "Review", mode: "direct",
      branch: "feature/pr", pullRequestNumber: 42, startupId: directStartupId })).rejects.toBe(error);
    expect(startups.get(directStartupId)?.error).toEqual({ code: "FETCH_FAILED", message: "Git fetch failed",
      retryable: true, detail: "fatal: Could not resolve host: github.com" });
  });

  it.each([
    ["\n  useful cause  \nignored line", "useful cause"],
    ["x".repeat(2_100), "x".repeat(2_000)],
  ])("bounds the first non-empty thrown error line", async (message, detail) => {
    const { workspace, startups, admissions, coordinator } = await harness();
    const error = new Error(message);
    admissions.admitInitialAutomaticTurn.mockRejectedValue(error);
    await expect(coordinator.createInitialTurn({ workspaceId: workspace.id, content: "Start", startupId: directStartupId })).rejects.toBe(error);
    expect(startups.get(directStartupId)?.error?.detail).toBe(detail);
  });

  it("binds a managed branch before checkout provisioning can be interrupted", async () => {
    const { workspace, threads, threadService, startups, parent, fork, makeCoordinator } = await branchHarness();
    let failProvision: ((error: Error) => void) | undefined;
    vi.mocked(threadService.create).mockImplementation(async (workspaceId, title, _mode, branch, options) => {
      const child = await threads.create(workspaceId, title, "worktree", branch, true, options?.provider);
      await options?.lifecycle?.onThreadPersisted(child);
      await new Promise<void>((_resolve, reject) => { failProvision = reject; });
      return child;
    });
    const command = {
      workspaceId: workspace.id, content: "Branch while checkout runs", mode: "worktree" as const,
      branch: "feature/child", parentThreadId: parent.id, forkedFromMessageId: fork.id,
      startupId: managedStartupId,
    };
    const pending = makeCoordinator().createInitialTurn(command);
    const rejected = expect(pending).rejects.toThrow("Checkout interrupted");
    await vi.waitFor(() => expect(startups.get(managedStartupId)?.phase).toBe("worktree"));
    const childId = startups.get(managedStartupId)?.threadId;
    if (!childId) throw new Error("Managed branch child was not bound");
    expect(threads.findById(childId)).toMatchObject({ parent_thread_id: parent.id, provider: "claude" });
    await startups.interruptNonterminalOnStartup();
    failProvision?.(new Error("Checkout interrupted"));
    await rejected;

    const restarted = makeCoordinator(new ThreadStartupService(new ThreadStartupRepo(persistenceRuntime.reader, persistenceRuntime.writer), persistenceRuntime.writer));
    await expect(restarted.createInitialTurn(command)).rejects.toThrow("was interrupted");
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(2);
    expect(threadService.create).toHaveBeenCalledOnce();
  });

  it("rolls back a direct branch child when its startup binding fails", async () => {
    const { workspace, threads, startups, parent, fork, makeCoordinator } = await branchHarness();
    persistenceRuntime.database.exec(`CREATE TRIGGER fail_startup_thread_binding BEFORE UPDATE OF thread_id ON thread_startups
      WHEN NEW.startup_id = '${directStartupId}' AND NEW.thread_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'Binding failed'); END`);
    await expect(makeCoordinator().createInitialTurn({
      workspaceId: workspace.id, content: "Branch directly", parentThreadId: parent.id,
      forkedFromMessageId: fork.id, startupId: directStartupId,
    })).rejects.toThrow("Binding failed");
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(1);
    expect(startups.get(directStartupId)).toMatchObject({ state: "failed", phase: "thread" });
  });

  it("clears a managed branch binding when checkout failure deletes its child", async () => {
    const { workspace, threads, threadService, startups, parent, fork, makeCoordinator } = await branchHarness();
    vi.mocked(threadService.create).mockImplementation(async (workspaceId, title, _mode, branch, options) => {
      const child = await threads.create(workspaceId, title, "worktree", branch, true, options?.provider);
      await options?.lifecycle?.onThreadPersisted(child);
      await threads.hardDelete(child.id);
      throw new Error("Checkout failed");
    });
    await expect(makeCoordinator().createInitialTurn({
      workspaceId: workspace.id, content: "Branch in a worktree", mode: "worktree",
      branch: "feature/child", parentThreadId: parent.id, forkedFromMessageId: fork.id,
      startupId: managedStartupId,
    })).rejects.toThrow("Checkout failed");
    expect(startups.get(managedStartupId)).toMatchObject({ state: "failed", phase: "worktree" });
    expect(startups.get(managedStartupId)?.threadId).toBeUndefined();
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(1);
  });

  it("inserts a managed thread row with the selected provider before checkout runs", async () => {
    const { workspace, threads, threadService, admissions, coordinator } = await harness();
    let providerAtBind: string | undefined;
    vi.mocked(threadService.create).mockImplementation(async (workspaceId, title, _mode, branch, options) => {
      const thread = await threads.create(workspaceId, title, "worktree", branch, true, options?.provider);
      providerAtBind = threads.findById(thread.id)?.provider;
      await options?.lifecycle?.onThreadPersisted(thread);
      return thread;
    });
    admissions.admitInitialAutomaticTurn.mockResolvedValue({ kind: "queued" });

    const created = await coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Managed Devin turn",
      mode: "worktree",
      branch: "feature/devin",
      provider: "devin",
      startupId: managedStartupId,
    });

    expect(threadService.create).toHaveBeenCalledWith(
      workspace.id, expect.any(String), "worktree", "feature/devin",
      expect.objectContaining({ provider: "devin" }),
    );
    expect(providerAtBind).toBe("devin");
    expect(created.thread.provider).toBe("devin");
    expect(threads.findById(created.thread.id)?.provider).toBe("devin");
  });

  it("inserts a managed branch row with the selected provider before checkout runs", async () => {
    const { workspace, threads, threadService, parent, fork, makeCoordinator } = await branchHarness();
    let providerAtBind: string | undefined;
    vi.mocked(threadService.create).mockImplementation(async (workspaceId, title, _mode, branch, options) => {
      const thread = await threads.create(workspaceId, title, "worktree", branch, true, options?.provider);
      providerAtBind = threads.findById(thread.id)?.provider;
      await options?.lifecycle?.onThreadPersisted(thread);
      return thread;
    });

    const created = await makeCoordinator().createInitialTurn({
      workspaceId: workspace.id,
      content: "Branch to Devin",
      mode: "worktree",
      branch: "feature/devin-branch",
      parentThreadId: parent.id,
      forkedFromMessageId: fork.id,
      provider: "devin",
      startupId: managedStartupId,
    });

    expect(threadService.create).toHaveBeenCalledWith(
      workspace.id, expect.any(String), "worktree", "feature/devin-branch",
      expect.objectContaining({ provider: "devin" }),
    );
    expect(providerAtBind).toBe("devin");
    expect(created).toMatchObject({ kind: "dispatch", thread: { provider: "devin" } });
    if (created.kind !== "dispatch") throw new Error("Expected dispatch result");
    expect(threads.findById(created.thread.id)?.provider).toBe("devin");
  });

  it("keeps a failed branch bound when its child still exists", async () => {
    const { workspace, threads, startups, parent, fork, handoffs, makeCoordinator } = await branchHarness();
    handoffs.deliverHandoff.mockRejectedValueOnce(new Error("Handoff failed"));
    await expect(makeCoordinator().createInitialTurn({
      workspaceId: workspace.id, content: "Branch directly", parentThreadId: parent.id,
      forkedFromMessageId: fork.id, startupId: directStartupId,
    })).rejects.toThrow("Handoff failed");
    const startup = startups.get(directStartupId);
    expect(startup).toMatchObject({ state: "failed", phase: "thread" });
    if (!startup?.threadId) throw new Error("Persisted child lost its startup binding");
    expect(threads.findById(startup.threadId)).toMatchObject({ parent_thread_id: parent.id });
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(2);
  });

  it("creates one child for concurrent branch retries and replays it after reconstruction", async () => {
    const { workspace, threads, threadService, admissions, gitRepository, startups } = await harness();
    const parent = await threads.create(workspace.id, "Parent", "direct", "main", true, "claude");
    let finishBranch: (() => void) | undefined;
    const branching = { create: vi.fn(async (_input: CreateBranchedThreadInput, lifecycle?: BranchedThreadLifecycle) => {
      await new Promise<void>((resolve) => { finishBranch = resolve; });
      return {
        thread: lifecycle ? await lifecycle.createAndBindDirectThread({ args: [workspace.id, "Child", "direct", "main", true, "claude", { parentThreadId: parent.id, forkedFromMessageId: "origin-message" }, "named", null] }) : await threads.create(workspace.id, "Child", "direct", "main", true, "claude", { parentThreadId: parent.id, forkedFromMessageId: "origin-message" }),
        providerWireOverride: "Parent handoff",
      };
    }) };
    const makeCoordinator = (startupService = startups) => new ThreadCreationCoordinator(
      threads, () => threadService, admissions as never, gitRepository,
      () => branching as never, undefined, () => startupService,
    );
    const coordinator = makeCoordinator();
    const command = {
      workspaceId: workspace.id,
      content: "Branch this conversation",
      parentThreadId: parent.id,
      startupId: directStartupId,
    };

    const first = coordinator.createInitialTurn(command);
    const second = coordinator.createInitialTurn(command);
    await vi.waitFor(() => expect(finishBranch).toBeDefined());
    await expect(coordinator.createInitialTurn({ ...command, content: "Different branch request" }))
      .rejects.toThrow("already assigned to a different request");
    finishBranch?.();
    const [created, concurrentReplay] = await Promise.all([first, second]);
    expect(created).toMatchObject({
      kind: "dispatch", startupId: directStartupId,
      command: { threadId: created.thread.id, providerWireOverride: "Parent handoff" },
    });
    expect(concurrentReplay).toMatchObject({ kind: "replay", thread: { id: created.thread.id } });
    await coordinator.startInitialAgent(directStartupId);
    await coordinator.completeInitialAgent(directStartupId);
    expect(startups.get(directStartupId)).toMatchObject({ state: "completed", threadId: created.thread.id });

    const restarted = makeCoordinator(new ThreadStartupService(new ThreadStartupRepo(persistenceRuntime.reader, persistenceRuntime.writer), persistenceRuntime.writer));
    const restartedReplay = await restarted.createInitialTurn(command);
    expect(restartedReplay).toMatchObject({
      kind: "replay", startupId: directStartupId, thread: { id: created.thread.id },
    });
    await expect(restarted.createInitialTurn({ ...command, content: "Different branch request" }))
      .rejects.toThrow("already assigned to a different request");
    expect(branching.create).toHaveBeenCalledOnce();
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(2);
  });

  it("skips Setup for a managed branch and rejects replay of an interrupted first turn", async () => {
    const { workspace, threads, threadService, admissions, gitRepository, startups } = await harness();
    const parent = await threads.create(workspace.id, "Parent", "direct", "main", true, "claude");
    const branching = { create: vi.fn(async (_input: CreateBranchedThreadInput, lifecycle?: BranchedThreadLifecycle) => {
      const thread = await threads.create(workspace.id, "Child", "worktree", "feature/child", true, "claude", {
        parentThreadId: parent.id, forkedFromMessageId: "origin-message",
      });
      await lifecycle?.onManagedThreadPersisted(thread);
      await threads.updateWorktreePath(thread.id, "/project/branched");
      return { thread: { ...thread, worktree_path: "/project/branched" }, providerWireOverride: "Parent handoff" };
    }) };
    const makeCoordinator = (startupService = startups) => new ThreadCreationCoordinator(
      threads, () => threadService, admissions as never, gitRepository,
      () => branching as never, undefined, () => startupService,
    );
    const command = {
      workspaceId: workspace.id, content: "Branch in a worktree", mode: "worktree" as const,
      branch: "feature/child", parentThreadId: parent.id, startupId: managedStartupId,
    };
    const coordinator = makeCoordinator();
    const created = await coordinator.createInitialTurn(command);
    expect(created).toMatchObject({ kind: "dispatch", startupId: managedStartupId });
    expect(startups.get(managedStartupId)?.steps[1].detail).toEqual({ phase: "worktree", mode: "created", folderName: "branched", path: "/project/branched" });
    expect(startups.get(managedStartupId)).toMatchObject({
      state: "running", phase: "agent", threadId: created.thread.id,
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "completed" },
        { phase: "setup", state: "skipped" },
        { phase: "agent", state: "running" },
      ],
    });
    await startups.interruptNonterminalOnStartup();

    const restarted = makeCoordinator(new ThreadStartupService(new ThreadStartupRepo(persistenceRuntime.reader, persistenceRuntime.writer), persistenceRuntime.writer));
    await expect(restarted.createInitialTurn(command))
      .rejects.toThrow("was interrupted; inspect the workspace before retrying");
    expect(branching.create).toHaveBeenCalledOnce();
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(2);
  });

  it("replays an old record after reconstruction without admitting another first turn", async () => {
    const { workspace, threads, threadService, admissions, gitRepository, coordinator } = await harness();
    const command = { workspaceId: workspace.id, content: "Create once", startupId: directStartupId };
    const first = await coordinator.createInitialTurn(command);
    persistenceRuntime.database.prepare("UPDATE thread_startups SET steps_json = ? WHERE startup_id = ?").run(JSON.stringify([
      { phase: "thread", state: "running" }, { phase: "agent", state: "pending" },
    ]), directStartupId);
    const restarted = new ThreadCreationCoordinator(
      threads,
      () => threadService,
      admissions as never,
      gitRepository,
      undefined,
      undefined,
      () => new ThreadStartupService(new ThreadStartupRepo(persistenceRuntime.reader, persistenceRuntime.writer), persistenceRuntime.writer),
    );

    const replay = await restarted.createInitialTurn(command);
    expect(replay).toMatchObject({ kind: "replay", startupId: directStartupId, thread: { id: first.thread.id } });
    expect(admissions.admitInitialAutomaticTurn).toHaveBeenCalledOnce();
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(1);
    await expect(restarted.createInitialTurn({ ...command, content: "Different prompt" }))
      .rejects.toThrow("already assigned to a different request");
  });

  it("shares one creation for concurrent calls with the same startup ID", async () => {
    const { workspace, threads, admissions, gitRepository, coordinator } = await harness();
    let finishFetch: (() => void) | undefined;
    vi.mocked(gitRepository.fetchBranch).mockImplementation(() => new Promise<void>((resolve) => {
      finishFetch = resolve;
    }));
    const command = {
      workspaceId: workspace.id,
      content: "Concurrent first turn",
      pullRequestNumber: 42,
      startupId: directStartupId,
    };
    const first = coordinator.createInitialTurn(command);
    const second = coordinator.createInitialTurn(command);
    await vi.waitFor(() => expect(finishFetch).toBeDefined());
    await expect(coordinator.createInitialTurn({ ...command, content: "Different prompt" }))
      .rejects.toThrow("already assigned to a different request");
    finishFetch?.();

    const [a, b] = await Promise.all([first, second]);
    expect(a.thread.id).toBe(b.thread.id);
    expect(b.kind).toBe("replay");
    expect(gitRepository.fetchBranch).toHaveBeenCalledOnce();
    expect(admissions.admitInitialAutomaticTurn).toHaveBeenCalledOnce();
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(1);
  });

  it("does not create another thread when an interrupted startup has no durable binding", async () => {
    const { workspace, threads, startups, admissions, coordinator } = await harness();
    await startups.start({ startupId: directStartupId, workspaceId: workspace.id, kind: "direct" });
    await startups.advance(directStartupId, "thread");
    await startups.interruptNonterminalOnStartup();

    await expect(coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Retry after interruption",
      startupId: directStartupId,
    })).rejects.toThrow("inspect the workspace before retrying");
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(0);
    expect(admissions.admitInitialAutomaticTurn).not.toHaveBeenCalled();
  });

  it("completes Direct startup only after first runtime admission and records a first-dispatch failure", async () => {
    const { workspace, startups, coordinator } = await harness();

    await coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Start directly",
      startupId: directStartupId,
    });
    await coordinator.startInitialAgent(directStartupId);
    await coordinator.completeInitialAgent(directStartupId);

    expect(startups.get(directStartupId)).toMatchObject({
      state: "completed",
      phase: "agent",
      steps: [{ phase: "thread", state: "completed" }, { phase: "agent", state: "completed" }],
    });

    const failedStartupId = "00000000-0000-4000-8000-000000000004";
    await coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Fail dispatch",
      startupId: failedStartupId,
    });
    await coordinator.startInitialAgent(failedStartupId);
    await coordinator.failInitialAgent(failedStartupId);

    expect(startups.get(failedStartupId)).toMatchObject({
      state: "failed",
      phase: "agent",
      error: { code: "AGENT_START_FAILED", retryable: true },
    });
  });

  it("orders managed checkout and Setup before the queued agent phase", async () => {
    const { workspace, threads, startups, threadService, admissions, coordinator } = await harness();
    const managed = await threads.create(
      workspace.id,
      "Managed",
      "worktree",
      "feature/managed",
      true,
      "claude",
    );
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      await requireThreadCreationOptions(options).lifecycle?.onThreadPersisted(managed);
      return managed;
    });
    admissions.admitInitialAutomaticTurn.mockResolvedValue({ kind: "queued" });

    const created = await coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Queue managed work",
      mode: "worktree",
      branch: "feature/managed",
      startupId: managedStartupId,
    });

    expect(created).toMatchObject({ kind: "queued", startupId: managedStartupId, thread: { id: managed.id } });
    expect(startups.get(managedStartupId)).toMatchObject({
      state: "running",
      phase: "setup",
      threadId: managed.id,
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "completed" },
        { phase: "setup", state: "running" },
        { phase: "agent", state: "pending" },
      ],
    });
    expect(await coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Queue managed work",
      mode: "worktree",
      branch: "feature/managed",
      startupId: managedStartupId,
    })).toMatchObject({ kind: "replay", thread: { id: managed.id } });
    expect(threadService.create).toHaveBeenCalledOnce();
    expect(admissions.admitInitialAutomaticTurn).toHaveBeenCalledOnce();
  });

  it("fetches a selected pull request before creating its managed worktree", async () => {
    const { workspace, threads, threadService, gitRepository, coordinator } = await harness();
    const order: string[] = [];
    const thread = await threads.create(workspace.id, "Review", "worktree", "contributor/review", true, "claude");
    vi.mocked(gitRepository.fetchBranch).mockImplementation(async () => {
      order.push("fetch");
    });
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      order.push("create");
      await requireThreadCreationOptions(options).lifecycle?.onThreadPersisted(thread);
      return thread;
    });

    await coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Review this PR",
      mode: "worktree",
      branch: "contributor/review",
      pullRequestNumber: 42,
    });

    expect(gitRepository.fetchBranch).toHaveBeenCalledWith(workspace.id, "contributor/review", 42);
    expect(order).toEqual(["fetch", "create"]);
  });

  it("keeps the startup retryable when the selected pull request cannot be fetched", async () => {
    const { workspace, startups, threadService, gitRepository, coordinator } = await harness();
    vi.mocked(gitRepository.fetchBranch).mockRejectedValue(new Error("pull request is unavailable"));

    await expect(coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Review this PR",
      mode: "worktree",
      branch: "contributor/review",
      pullRequestNumber: 42,
      startupId: managedStartupId,
    })).rejects.toThrow("pull request is unavailable");

    expect(threadService.create).not.toHaveBeenCalled();
    expect(startups.get(managedStartupId)).toMatchObject({
      state: "failed",
      phase: "fetch",
      error: { code: "FETCH_FAILED", retryable: true, detail: "pull request is unavailable" },
    });
    await expect(coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Review this PR",
      mode: "worktree",
      branch: "contributor/review",
      pullRequestNumber: 42,
      startupId: managedStartupId,
    })).rejects.toThrow("retry with a new startup ID");
    expect(threadService.create).not.toHaveBeenCalled();
  });

  it("does not create a worktree when cancellation arrives while fetching a pull request", async () => {
    const { workspace, startups, threadService, gitRepository, coordinator } = await harness();
    let finishFetch: (() => void) | undefined;
    vi.mocked(gitRepository.fetchBranch).mockImplementation(() => new Promise<void>((resolve) => {
      finishFetch = resolve;
    }));

    const creating = coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Cancel PR checkout",
      mode: "worktree",
      branch: "contributor/review",
      pullRequestNumber: 42,
      startupId: managedStartupId,
    });
    await vi.waitFor(() => expect(finishFetch).toBeDefined());
    await startups.cancel(managedStartupId);
    finishFetch?.();

    await expect(creating).rejects.toThrow("Thread startup was cancelled");
    expect(threadService.create).not.toHaveBeenCalled();
    expect(startups.get(managedStartupId)).toMatchObject({ state: "cancelled", phase: "fetch" });
  });

  it("does not admit a queued agent after startup cancellation wins", async () => {
    const { workspace, threads, startups, coordinator } = await harness();
    const thread = await threads.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude");
    await startups.start({
      startupId: managedStartupId,
      workspaceId: workspace.id,
      kind: "managed-worktree",
    });
    await startups.advance(managedStartupId, "thread");
    await startups.bindThread(managedStartupId, thread.id);
    await startups.advance(managedStartupId, "worktree");
    await startups.advance(managedStartupId, "setup");
    await startups.cancel(managedStartupId);

    expect(await coordinator.startQueuedAgent(thread.id)).toBeNull();
    expect(startups.get(managedStartupId)).toMatchObject({
      state: "cancelled",
      phase: "setup",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "completed" },
        { phase: "setup", state: "cancelled" },
        { phase: "agent", state: "pending" },
      ],
    });
    expect(await coordinator.startQueuedAgent(thread.id)).toBeNull();
  });

  it("does not admit a queued agent when cancellation wins after Setup advances to agent", async () => {
    const { workspace, threads, startups, coordinator } = await harness();
    const thread = await threads.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude");
    await startups.start({
      startupId: managedStartupId,
      workspaceId: workspace.id,
      kind: "managed-worktree",
    });
    await startups.advance(managedStartupId, "thread");
    await startups.bindThread(managedStartupId, thread.id);
    await startups.advance(managedStartupId, "worktree");
    await startups.advance(managedStartupId, "setup");
    await startups.advance(managedStartupId, "agent");
    await startups.cancel(managedStartupId);

    expect(await coordinator.startQueuedAgent(thread.id)).toBeNull();
    expect(startups.get(managedStartupId)).toMatchObject({
      state: "cancelled",
      phase: "agent",
      steps: expect.arrayContaining([expect.objectContaining({ phase: "agent", state: "cancelled" })]),
    });
  });

  it("honors cancellation before Git mutation and cleans up after checkout returns", async () => {
    const { workspace, threads, startups, threadService, coordinator } = await harness();
    const beforeCheckout = await threads.create(workspace.id, "Cancelled", "worktree", "feature/cancelled", true, "claude");
    let gitMutationReached = false;
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      await startups.cancel(cancelledStartupId);
      await requireThreadCreationOptions(options).lifecycle?.onThreadPersisted(beforeCheckout);
      gitMutationReached = true;
      return beforeCheckout;
    });

    await expect(coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Cancel before checkout",
      mode: "worktree",
      branch: "feature/cancelled",
      startupId: cancelledStartupId,
    })).rejects.toThrow("Thread startup was cancelled");
    expect(gitMutationReached).toBe(false);
    expect(startups.get(cancelledStartupId)).toMatchObject({ state: "cancelled", phase: "worktree" });

    const afterCheckoutId = "00000000-0000-4000-8000-000000000005";
    const afterCheckout = await threads.create(workspace.id, "Cleanup", "worktree", "feature/cleanup", true, "claude");
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      await requireThreadCreationOptions(options).lifecycle?.onThreadPersisted(afterCheckout);
      await startups.cancel(afterCheckoutId);
      return afterCheckout;
    });

    await expect(coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Cancel after checkout",
      mode: "worktree",
      branch: "feature/cleanup",
      startupId: afterCheckoutId,
    })).rejects.toThrow("Thread startup was cancelled");
    expect(threadService.delete).toHaveBeenCalledWith(afterCheckout.id, true);
    expect(startups.get(afterCheckoutId)).toMatchObject({ state: "cancelled", phase: "worktree" });
  });
});
