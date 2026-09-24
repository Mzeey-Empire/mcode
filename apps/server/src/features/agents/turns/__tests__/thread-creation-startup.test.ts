import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadBranchingService, type BranchedThreadLifecycle, type CreateBranchedThreadInput } from "../../../projects/worktrees/thread-branching-service.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { ThreadService } from "../../../thread-control/index.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
import { ThreadCreationCoordinator } from "../thread-creation-coordinator.js";

const directStartupId = "00000000-0000-4000-8000-000000000001";
const managedStartupId = "00000000-0000-4000-8000-000000000002";
const cancelledStartupId = "00000000-0000-4000-8000-000000000003";

function harness() {
  const db = openMemoryDatabase();
  const workspaces = new WorkspaceRepo(db);
  const threads = new ThreadRepo(db);
  const workspace = workspaces.create("Project", "/project");
  const startups = new ThreadStartupService(new ThreadStartupRepo(db));
  const threadService = {
    create: vi.fn(),
    delete: vi.fn(async () => true),
  } as unknown as ThreadService;
  const admissions = {
    admitInitialAutomaticTurn: vi.fn(async () => ({ kind: "not-managed" as const })),
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

function branchHarness() {
  const base = harness();
  const messages = new MessageRepo(base.db);
  const parent = base.threads.create(base.workspace.id, "Parent", "direct", "main", true, "claude");
  const fork = messages.create(parent.id, "user", "Start here", 1);
  const handoffs = { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "Parent handoff" })) };
  const branching = new ThreadBranchingService(
    base.threads,
    messages,
    base.threadService,
    { listWorktrees: vi.fn(async () => []) } as never,
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
  it("binds a managed branch before checkout provisioning can be interrupted", async () => {
    const { db, workspace, threads, threadService, startups, parent, fork, makeCoordinator } = branchHarness();
    let failProvision: ((error: Error) => void) | undefined;
    vi.mocked(threadService.create).mockImplementation(async (workspaceId, title, _mode, branch, options) => {
      const child = threads.create(workspaceId, title, "worktree", branch, true, "claude");
      options.lifecycle?.onThreadPersisted(child);
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
    startups.interruptNonterminalOnStartup();
    failProvision?.(new Error("Checkout interrupted"));
    await rejected;

    const restarted = makeCoordinator(new ThreadStartupService(new ThreadStartupRepo(db)));
    await expect(restarted.createInitialTurn(command)).rejects.toThrow("was interrupted");
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(2);
    expect(threadService.create).toHaveBeenCalledOnce();
    db.close();
  });

  it("rolls back a direct branch child when its startup binding fails", async () => {
    const { db, workspace, threads, startups, parent, fork, makeCoordinator } = branchHarness();
    vi.spyOn(startups, "bindThread").mockImplementationOnce(() => { throw new Error("Binding failed"); });
    await expect(makeCoordinator().createInitialTurn({
      workspaceId: workspace.id, content: "Branch directly", parentThreadId: parent.id,
      forkedFromMessageId: fork.id, startupId: directStartupId,
    })).rejects.toThrow("Binding failed");
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(1);
    expect(startups.get(directStartupId)).toMatchObject({ state: "failed", phase: "thread" });
    db.close();
  });

  it("clears a managed branch binding when checkout failure deletes its child", async () => {
    const { db, workspace, threads, threadService, startups, parent, fork, makeCoordinator } = branchHarness();
    vi.mocked(threadService.create).mockImplementation(async (workspaceId, title, _mode, branch, options) => {
      const child = threads.create(workspaceId, title, "worktree", branch, true, "claude");
      options.lifecycle?.onThreadPersisted(child);
      threads.hardDelete(child.id);
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
    db.close();
  });

  it("keeps a failed branch bound when its child still exists", async () => {
    const { db, workspace, threads, startups, parent, fork, handoffs, makeCoordinator } = branchHarness();
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
    db.close();
  });

  it("creates one child for concurrent branch retries and replays it after reconstruction", async () => {
    const { db, workspace, threads, threadService, admissions, gitRepository, startups } = harness();
    const parent = threads.create(workspace.id, "Parent", "direct", "main", true, "claude");
    let finishBranch: (() => void) | undefined;
    const branching = { create: vi.fn(async (_input: CreateBranchedThreadInput, lifecycle?: BranchedThreadLifecycle) => {
      await new Promise<void>((resolve) => { finishBranch = resolve; });
      return {
        thread: lifecycle ? lifecycle.createAndBindDirectThread(() => threads.create(workspace.id, "Child", "direct", "main", true, "claude", {
          parentThreadId: parent.id,
        })) : threads.create(workspace.id, "Child", "direct", "main", true, "claude", { parentThreadId: parent.id }),
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
    coordinator.startInitialAgent(directStartupId);
    coordinator.completeInitialAgent(directStartupId);
    expect(startups.get(directStartupId)).toMatchObject({ state: "completed", threadId: created.thread.id });

    const restarted = makeCoordinator(new ThreadStartupService(new ThreadStartupRepo(db)));
    const restartedReplay = await restarted.createInitialTurn(command);
    expect(restartedReplay).toMatchObject({
      kind: "replay", startupId: directStartupId, thread: { id: created.thread.id },
    });
    await expect(restarted.createInitialTurn({ ...command, content: "Different branch request" }))
      .rejects.toThrow("already assigned to a different request");
    expect(branching.create).toHaveBeenCalledOnce();
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(2);
    db.close();
  });

  it("skips Setup for a managed branch and rejects replay of an interrupted first turn", async () => {
    const { db, workspace, threads, threadService, admissions, gitRepository, startups } = harness();
    const parent = threads.create(workspace.id, "Parent", "direct", "main", true, "claude");
    const branching = { create: vi.fn(async (_input: CreateBranchedThreadInput, lifecycle?: BranchedThreadLifecycle) => {
      const thread = threads.create(workspace.id, "Child", "worktree", "feature/child", true, "claude", {
        parentThreadId: parent.id,
      });
      lifecycle?.onManagedThreadPersisted(thread);
      return { thread, providerWireOverride: "Parent handoff" };
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
    expect(startups.get(managedStartupId)).toMatchObject({
      state: "running", phase: "agent", threadId: created.thread.id,
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "completed" },
        { phase: "setup", state: "skipped" },
        { phase: "agent", state: "running" },
      ],
    });
    startups.interruptNonterminalOnStartup();

    const restarted = makeCoordinator(new ThreadStartupService(new ThreadStartupRepo(db)));
    await expect(restarted.createInitialTurn(command))
      .rejects.toThrow("was interrupted; inspect the workspace before retrying");
    expect(branching.create).toHaveBeenCalledOnce();
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(2);
    db.close();
  });

  it("replays the bound thread after startup service reconstruction without admitting another first turn", async () => {
    const { db, workspace, threads, threadService, admissions, gitRepository, coordinator } = harness();
    const command = { workspaceId: workspace.id, content: "Create once", startupId: directStartupId };
    const first = await coordinator.createInitialTurn(command);
    const restarted = new ThreadCreationCoordinator(
      threads,
      () => threadService,
      admissions as never,
      gitRepository,
      undefined,
      undefined,
      () => new ThreadStartupService(new ThreadStartupRepo(db)),
    );

    const replay = await restarted.createInitialTurn(command);
    expect(replay).toMatchObject({ kind: "replay", startupId: directStartupId, thread: { id: first.thread.id } });
    expect(admissions.admitInitialAutomaticTurn).toHaveBeenCalledOnce();
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(1);
    await expect(restarted.createInitialTurn({ ...command, content: "Different prompt" }))
      .rejects.toThrow("already assigned to a different request");
    db.close();
  });

  it("shares one creation for concurrent calls with the same startup ID", async () => {
    const { db, workspace, threads, admissions, gitRepository, coordinator } = harness();
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
    db.close();
  });

  it("does not create another thread when an interrupted startup has no durable binding", async () => {
    const { db, workspace, threads, startups, admissions, coordinator } = harness();
    startups.start({ startupId: directStartupId, workspaceId: workspace.id, kind: "direct" });
    startups.advance(directStartupId, "thread");
    startups.interruptNonterminalOnStartup();

    await expect(coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Retry after interruption",
      startupId: directStartupId,
    })).rejects.toThrow("inspect the workspace before retrying");
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(0);
    expect(admissions.admitInitialAutomaticTurn).not.toHaveBeenCalled();
    db.close();
  });

  it("completes Direct startup only after first runtime admission and records a first-dispatch failure", async () => {
    const { db, workspace, startups, coordinator } = harness();

    await coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Start directly",
      startupId: directStartupId,
    });
    coordinator.startInitialAgent(directStartupId);
    coordinator.completeInitialAgent(directStartupId);

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
    coordinator.startInitialAgent(failedStartupId);
    coordinator.failInitialAgent(failedStartupId);

    expect(startups.get(failedStartupId)).toMatchObject({
      state: "failed",
      phase: "agent",
      error: { code: "AGENT_START_FAILED", retryable: true },
    });
    db.close();
  });

  it("orders managed checkout and Setup before the queued agent phase", async () => {
    const { db, workspace, threads, startups, threadService, admissions, coordinator } = harness();
    const managed = threads.create(
      workspace.id,
      "Managed",
      "worktree",
      "feature/managed",
      true,
      "claude",
    );
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      options.lifecycle?.onThreadPersisted(managed);
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
    db.close();
  });

  it("fetches a selected pull request before creating its managed worktree", async () => {
    const { db, workspace, threads, threadService, gitRepository, coordinator } = harness();
    const order: string[] = [];
    const thread = threads.create(workspace.id, "Review", "worktree", "contributor/review", true, "claude");
    vi.mocked(gitRepository.fetchBranch).mockImplementation(async () => {
      order.push("fetch");
    });
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      order.push("create");
      options.lifecycle?.onThreadPersisted(thread);
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
    db.close();
  });

  it("keeps the startup retryable when the selected pull request cannot be fetched", async () => {
    const { db, workspace, startups, threadService, gitRepository, coordinator } = harness();
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
      phase: "thread",
      error: { code: "THREAD_CREATE_FAILED", retryable: true },
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
    db.close();
  });

  it("does not create a worktree when cancellation arrives while fetching a pull request", async () => {
    const { db, workspace, startups, threadService, gitRepository, coordinator } = harness();
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
    startups.cancel(managedStartupId);
    finishFetch?.();

    await expect(creating).rejects.toThrow("Thread startup was cancelled");
    expect(threadService.create).not.toHaveBeenCalled();
    expect(startups.get(managedStartupId)).toMatchObject({ state: "cancelled", phase: "thread" });
    db.close();
  });

  it("does not admit a queued agent after startup cancellation wins", () => {
    const { db, workspace, threads, startups, coordinator } = harness();
    const thread = threads.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude");
    startups.start({
      startupId: managedStartupId,
      workspaceId: workspace.id,
      kind: "managed-worktree",
    });
    startups.advance(managedStartupId, "thread");
    startups.bindThread(managedStartupId, thread.id);
    startups.advance(managedStartupId, "worktree");
    startups.advance(managedStartupId, "setup");
    startups.cancel(managedStartupId);

    expect(coordinator.startQueuedAgent(thread.id)).toBeNull();
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
    expect(coordinator.startQueuedAgent(thread.id)).toBeNull();
    db.close();
  });

  it("does not admit a queued agent when cancellation wins after Setup advances to agent", () => {
    const { db, workspace, threads, startups, coordinator } = harness();
    const thread = threads.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude");
    startups.start({
      startupId: managedStartupId,
      workspaceId: workspace.id,
      kind: "managed-worktree",
    });
    startups.advance(managedStartupId, "thread");
    startups.bindThread(managedStartupId, thread.id);
    startups.advance(managedStartupId, "worktree");
    startups.advance(managedStartupId, "setup");
    startups.advance(managedStartupId, "agent");
    startups.cancel(managedStartupId);

    expect(coordinator.startQueuedAgent(thread.id)).toBeNull();
    expect(startups.get(managedStartupId)).toMatchObject({
      state: "cancelled",
      phase: "agent",
      steps: expect.arrayContaining([{ phase: "agent", state: "cancelled" }]),
    });
    db.close();
  });

  it("honors cancellation before Git mutation and cleans up after checkout returns", async () => {
    const { db, workspace, threads, startups, threadService, coordinator } = harness();
    const beforeCheckout = threads.create(workspace.id, "Cancelled", "worktree", "feature/cancelled", true, "claude");
    let gitMutationReached = false;
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      startups.cancel(cancelledStartupId);
      options.lifecycle?.onThreadPersisted(beforeCheckout);
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
    const afterCheckout = threads.create(workspace.id, "Cleanup", "worktree", "feature/cleanup", true, "claude");
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      options.lifecycle?.onThreadPersisted(afterCheckout);
      startups.cancel(afterCheckoutId);
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
    db.close();
  });
});
