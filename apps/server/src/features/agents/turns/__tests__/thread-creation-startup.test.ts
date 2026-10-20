import "reflect-metadata";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createThreadPersistenceTestRuntime } from "../../../thread-control/testing/thread-persistence-test-runtime.js";
let persistenceRuntime: ReturnType<typeof createThreadPersistenceTestRuntime>;
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadBranchingService, type BranchedThreadLifecycle, type CreateBranchedThreadInput } from "../../../projects/worktrees/thread-branching-service.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { ThreadService } from "../../../thread-control/index.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { HandoffStorage } from "../../../handoff/index.js";
import { ProjectWorktreeService } from "../../../projects/worktrees/project-worktree-service.js";
import { SandboxWorktreeCleanupPolicy } from "../../../projects/worktrees/sandbox-worktree-cleanup-policy.js";
import { WorktreeSafetyService } from "../../../projects/git/worktree-safety-service.js";
import { createOriginFixture, git } from "../../../projects/git/__tests__/start-from-origin-fixture.js";
import { routeThreadStartupRpc } from "../../../thread-startup/transport/thread-startup-rpc.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
import { ThreadStartupFetchDecisions } from "../../../thread-startup/thread-startup-fetch-decisions.js";
import { ThreadCreationCoordinator } from "../thread-creation-coordinator.js";
import type { TurnAdmissionDispatchCoordinator } from "../turn-admission-dispatch-coordinator.js";

const directStartupId = "00000000-0000-4000-8000-000000000001";
const managedStartupId = "00000000-0000-4000-8000-000000000002";
const cancelledStartupId = "00000000-0000-4000-8000-000000000003";

async function originHarness(withStartupService = true) {
  const fixture = await createOriginFixture();
  const { runtime, workspaces, worktrees, repository, executor, host } = fixture;
  const threads = new ThreadRepo(runtime.reader, runtime.writer);
  const startups = new ThreadStartupService(new ThreadStartupRepo(runtime.reader, runtime.writer), runtime.writer);
  const fetchDecisions = new ThreadStartupFetchDecisions();
  const projects = new ProjectWorktreeService(threads, workspaces, runtime.writer, worktrees,
    new SandboxWorktreeCleanupPolicy(new WorktreeSafetyService(executor, host), repository, host));
  const service = new ThreadService(threads, projects, new AttachmentService(), new HandoffStorage(), {
    teardownThread: async () => { throw new Error("No runtime has started"); },
    deletePersistentData: async (_ids, remove) => remove(),
  });
  const coordinator = new ThreadCreationCoordinator(threads, () => service, {
    admitInitialAutomaticTurn: async () => ({ kind: "not-managed" }),
    createAttachedExistingWorktreeThread: async () => { throw new Error("Origin starts create a new worktree"); },
  }, repository, workspaces, fetchDecisions, undefined, undefined, () => withStartupService ? startups : undefined);
  const deps = {
    threadStartupService: startups, threadStartupFetchDecisions: fetchDecisions,
    workspaceEnvironmentService: { stopAutomaticSetup: async () => { throw new Error("No setup has started"); } },
    agentService: { stopSession: async () => { throw new Error("No agent has started"); } },
  };
  const command = {
    workspaceId: fixture.workspace.id, content: "Build from origin", mode: "worktree", branch: "main",
    startFromOrigin: true, startupId: managedStartupId,
  } satisfies Parameters<ThreadCreationCoordinator["createInitialTurn"]>[0];
  return { ...fixture, threads, startups, coordinator, command,
    resolve: (action: "retry" | "continue") => routeThreadStartupRpc("thread.startup.resolve", { startupId: managedStartupId, action }, deps),
    cancel: () => routeThreadStartupRpc("thread.startup.cancel", { startupId: managedStartupId }, deps),
  };
}

describe("ThreadCreationCoordinator start from origin", { timeout: 20_000 }, () => {
  it("uses a trusted commit for a detached worktree and includes it in replay identity", async () => {
    const { coordinator, command, localSha, originSha, repoPath, threads } = await originHarness();
    const input = { ...command, startFromOrigin: false };
    git(repoPath, "fetch", "origin", "main");
    const branches = git(repoPath, "branch", "--list");
    const created = await coordinator.createInitialTurn(input, { worktreeStart: { commit: originSha } });
    expect(git(created.thread.worktree_path ?? "", "rev-parse", "HEAD")).toBe(originSha);
    expect(git(created.thread.worktree_path ?? "", "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(repoPath, "rev-parse", "HEAD")).toBe(localSha);
    expect(git(repoPath, "branch", "--list")).toBe(branches);
    expect(threads.findById(created.thread.id)).toMatchObject({ checkout_state: "branchless", base_branch: "main" });
    expect((await coordinator.createInitialTurn(input, { worktreeStart: { commit: originSha } })).thread.id).toBe(created.thread.id);
    await expect(coordinator.createInitialTurn(input, { worktreeStart: { commit: localSha } }))
      .rejects.toMatchObject({ name: "ThreadStartupConflictError" });
  });

  it("records origin fetch and starts the worktree at its tip with the local base preserved", async () => {
    const { coordinator, command, startups, threads, repoPath, localSha, originSha } = await originHarness();
    const created = await coordinator.createInitialTurn(command);
    expect(startups.get(managedStartupId)?.steps[1]).toMatchObject({ phase: "fetch", state: "completed",
      detail: { phase: "fetch", ref: "origin/main", branch: "main" } });
    expect(threads.findById(created.thread.id)).toMatchObject({ base_branch: "main", checkout_state: "branchless" });
    expect(git(created.thread.worktree_path ?? "", "rev-parse", "HEAD")).toBe(originSha);
    expect(git(repoPath, "rev-parse", "main")).toBe(localSha);
  });

  it("blocks without a thread, retries repeatedly, and fetches successfully after origin is restored", async () => {
    const { coordinator, command, startups, threads, workspace, repoPath, origin, originSha, resolve } = await originHarness();
    git(repoPath, "remote", "remove", "origin");
    const creation = coordinator.createInitialTurn(command);
    await vi.waitFor(() => expect(startups.get(managedStartupId)).toMatchObject({ state: "blocked", phase: "fetch",
      block: { code: "start_from_origin_failed", message: "This project has no origin remote.", actions: ["retry", "continue"] } }), { timeout: 10_000 });
    expect(threads.listByWorkspace(workspace.id)).toEqual([]);
    const revision = startups.get(managedStartupId)?.revision ?? 0;
    resolve("retry");
    await vi.waitFor(() => expect(startups.get(managedStartupId)).toMatchObject({ state: "blocked", revision: revision + 2 }), { timeout: 10_000 });
    git(repoPath, "remote", "add", "origin", origin);
    resolve("retry");
    const created = await creation;
    expect(git(created.thread.worktree_path ?? "", "rev-parse", "HEAD")).toBe(originSha);
    expect(startups.get(managedStartupId)?.steps[1].state).toBe("completed");
    expect(() => resolve("retry")).toThrow(expect.objectContaining({ code: "STARTUP_NOT_BLOCKED_ON_FETCH" }));
  });

  it.each([
    ["no_origin", "This project has no origin remote."],
    ["branch_missing", 'Branch "main" does not exist on origin.'],
    ["network_or_auth", "Could not fetch from origin. Check your connection and Git access."],
  ])("continues from local main after %s", async (failure, message) => {
    const { coordinator, command, startups, repoPath, origin, localSha, resolve } = await originHarness();
    if (failure === "no_origin") git(repoPath, "remote", "remove", "origin");
    if (failure === "branch_missing") git(origin, "update-ref", "-d", "refs/heads/main");
    if (failure === "network_or_auth") git(repoPath, "remote", "set-url", "origin", "http://127.0.0.1:1/unreachable.git");
    const creation = coordinator.createInitialTurn(command);
    await vi.waitFor(() => expect(startups.get(managedStartupId)?.state).toBe("blocked"), { timeout: 10_000 });
    expect(startups.get(managedStartupId)?.block).toMatchObject({ message, detail: expect.stringMatching(/^(fatal|error): /) });
    resolve("continue");
    const created = await creation;
    expect(git(created.thread.worktree_path ?? "", "rev-parse", "HEAD")).toBe(localSha);
    expect(created.thread.base_branch).toBe("main");
    expect(startups.get(managedStartupId)?.steps[1]).toMatchObject({ phase: "fetch", state: "skipped" });
  });

  it("cancels while blocked and releases the pending create without creating a thread", async () => {
    const { coordinator, command, startups, threads, workspace, repoPath, cancel, resolve } = await originHarness();
    git(repoPath, "remote", "remove", "origin");
    const creation = coordinator.createInitialTurn(command);
    const rejected = expect(creation).rejects.toThrow("Thread startup was cancelled");
    await vi.waitFor(() => expect(startups.get(managedStartupId)?.state).toBe("blocked"), { timeout: 10_000 });
    await cancel();
    await rejected;
    expect(startups.get(managedStartupId)).toMatchObject({ state: "cancelled", phase: "fetch", cancellation: "requested" });
    expect(threads.listByWorkspace(workspace.id)).toEqual([]);
    expect(() => resolve("continue")).toThrow(expect.objectContaining({ code: "STARTUP_NOT_BLOCKED_ON_FETCH" }));
  });

  it("switch off omits fetch and uses local main even with no origin", async () => {
    const { coordinator, command, startups, repoPath, localSha } = await originHarness();
    git(repoPath, "remote", "remove", "origin");
    const created = await coordinator.createInitialTurn({ ...command, startFromOrigin: false });
    expect(startups.get(managedStartupId)?.steps.map((step) => step.phase)).toEqual(["thread", "worktree", "setup", "agent"]);
    expect(git(created.thread.worktree_path ?? "", "rev-parse", "HEAD")).toBe(localSha);
  });

  it("throws fetch failure when no startup service is present", async () => {
    const { coordinator, command, repoPath, threads, workspace } = await originHarness(false);
    git(repoPath, "remote", "remove", "origin");
    await expect(coordinator.createInitialTurn({ ...command, startupId: undefined })).rejects.toMatchObject({ code: "no_origin" });
    expect(threads.listByWorkspace(workspace.id)).toEqual([]);
  });
});

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
  const gitRepository = { fetchBranch: vi.fn(), fetchOriginTrackingBranch: vi.fn() };
  const fetchDecisions = new ThreadStartupFetchDecisions();
  const coordinator = new ThreadCreationCoordinator(
    threads,
    () => threadService,
    admissions as never,
    gitRepository,
    workspaces,
    fetchDecisions,
    undefined,
    undefined,
    () => startups,
  );
  return { db, workspace, workspaces, threads, startups, threadService, admissions, gitRepository, fetchDecisions, coordinator };
}

async function branchHarness() {
  const base = await harness();
  const messages = new MessageRepo(persistenceRuntime.reader, persistenceRuntime.writer);
  const parent = await base.threads.create(base.workspace.id, "Parent", "direct", "main", true, "claude");
  const fork = await messages.create(parent.id, "user", "Start here", 1);
  const handoffs = HandoffStorage.forTesting({ mcodeDirFn: () => NodePath.dirname(base.db.filename) });
  const worktrees = { listWorktrees: vi.fn(async () => [{ path: "/project/existing", branch: "feature/existing" }]) };
  const branching = new ThreadBranchingService(
    base.threads,
    messages,
    base.threadService,
    worktrees as never,
    handoffs,
    { platform: "win32" } as never,
    new ToolCallRecordRepo(persistenceRuntime.reader, persistenceRuntime.writer),
    { resolve: (id) => ({ id, maxInputCharactersPerTurn: 16_000 }) },
  );
  const makeCoordinator = (startupService = base.startups) => new ThreadCreationCoordinator(
    base.threads, () => base.threadService, base.admissions as never, base.gitRepository,
    base.workspaces, base.fetchDecisions,
    () => branching, undefined, () => startupService,
  );
  return { ...base, parent, fork, handoffs, makeCoordinator };
}

describe("ThreadCreationCoordinator startup lifecycle", () => {
  it("attaches an Implement startup without entering automatic Setup and fingerprints the trusted option", async () => {
    const { workspace, threads, startups, coordinator, admissions } = await harness();
    const source = await threads.create(workspace.id, "Source", "worktree", "main", false, "codex");
    await threads.updateWorktreePath(source.id, "/project/existing");
    admissions.admitInitialAutomaticTurn.mockResolvedValue({ kind: "queued" });
    const command = { workspaceId: workspace.id, content: "Implement", mode: "worktree" as const,
      existingWorktreePath: "/project/existing", startupId: managedStartupId };
    const options = { setupSkip: { reason: "plan-implement" as const, sourceThreadId: source.id } };
    const created = await coordinator.createInitialTurn(command, options);
    expect(created.kind).toBe("dispatch");
    expect(created.thread).toMatchObject({ mode: "worktree", worktree_path: "/project/existing", worktree_managed: false });
    expect(startups.get(managedStartupId)?.steps.find(step => step.phase === "setup")).toMatchObject({ state: "skipped",
      detail: { phase: "setup", skipReason: "plan-implement" } });
    expect(admissions.admitInitialAutomaticTurn).not.toHaveBeenCalled();
    expect((await coordinator.createInitialTurn(command, options)).thread.id).toBe(created.thread.id);
    await expect(coordinator.createInitialTurn(command)).rejects.toThrow("already assigned to a different request");
    expect(threads.listByWorkspace(workspace.id)).toHaveLength(2);
  });

  it.each(["different", "missing", "direct"])("refuses a %s source checkout before creating or queuing a thread", async (kind) => {
    const { workspace, threads, coordinator, admissions } = await harness();
    const source = await threads.create(workspace.id, "Source", "worktree", "main", false, "codex");
    await threads.updateWorktreePath(source.id, kind === "different" ? "/project/other" : "/project/existing");
    await expect(coordinator.createInitialTurn({ workspaceId: workspace.id, content: "Implement",
      mode: kind === "direct" ? "direct" : "worktree", existingWorktreePath: "/project/existing", startupId: managedStartupId },
    { setupSkip: { reason: "plan-implement", sourceThreadId: kind === "missing" ? "missing" : source.id } })).rejects.toThrow();
    expect(threads.listByWorkspace(workspace.id).map(thread => thread.id)).toEqual([source.id]);
    expect(admissions.admitInitialAutomaticTurn).not.toHaveBeenCalled();
  });

  it("records an attached checkout and runs setup before its queued first turn", async () => {
    const { workspace, startups, coordinator, admissions } = await harness();
    admissions.admitInitialAutomaticTurn.mockResolvedValue({ kind: "queued" });
    const created = await coordinator.createInitialTurn({ workspaceId: workspace.id, content: "Use existing",
      mode: "worktree", branch: "main", existingWorktreePath: "/project/existing", startupId: managedStartupId });
    expect(created.kind).toBe("queued");
    expect(startups.get(managedStartupId)).toMatchObject({ kind: "attached-worktree", phase: "setup", steps: [
      { phase: "thread", state: "completed" },
      { phase: "worktree", state: "completed", detail: { phase: "worktree", mode: "opened", folderName: "existing", path: "/project/existing" } },
      { phase: "setup", state: "running" },
      { phase: "agent", state: "pending" },
    ] });
  });

  it("branches into an attached checkout, skips setup and dispatches its first turn", async () => {
    const { workspace, startups, parent, fork, makeCoordinator, admissions } = await branchHarness();
    const coordinator = makeCoordinator();
    const created = await coordinator.createInitialTurn({ workspaceId: workspace.id, content: "Branch here",
      mode: "worktree", branch: "main", existingWorktreePath: "/project/existing", parentThreadId: parent.id,
      forkedFromMessageId: fork.id, startupId: managedStartupId });
    expect(created).toMatchObject({ kind: "dispatch", command: { content: "Branch here", handoffPreamble: expect.stringContaining("Start here") } });
    expect(admissions.admitInitialAutomaticTurn).not.toHaveBeenCalled();
    expect(startups.get(managedStartupId)).toMatchObject({ kind: "attached-worktree", phase: "agent", steps: [
      { phase: "thread", state: "completed" },
      { phase: "worktree", state: "completed", detail: { phase: "worktree", mode: "opened", folderName: "existing", path: "/project/existing" } },
      { phase: "setup", state: "skipped", detail: { phase: "setup" } },
      { phase: "agent", state: "running" },
    ] });
    await coordinator.startInitialAgent(managedStartupId);
    // Admission alone leaves the agent phase running until the provider answers.
    expect(startups.get(managedStartupId)).toMatchObject({ state: "running", phase: "agent" });
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

  it("retains Git stderr when worktree creation fails", async () => {
    const { workspace, startups, threadService, coordinator } = await harness();
    vi.mocked(threadService.create).mockRejectedValue(Object.assign(
      new Error("Command failed: git -C /project worktree add /project-wt"),
      { stderr: "fatal: 'feature/x' is already checked out at '/other'\n" },
    ));
    await expect(coordinator.createInitialTurn({ workspaceId: workspace.id, content: "Build", mode: "worktree", branch: "main",
      startupId: managedStartupId })).rejects.toThrow("Command failed");
    expect(startups.get(managedStartupId)?.error?.detail).toBe("fatal: 'feature/x' is already checked out at '/other'");
  });

  it("records a thread creation failure after a successful direct PR fetch", async () => {
    const { db, workspace, threads, startups, gitRepository, coordinator } = await harness();
    db.exec(`CREATE TRIGGER reject_thread_creation BEFORE INSERT ON threads
      BEGIN SELECT RAISE(ABORT, '\n  Thread storage unavailable  \nmore context'); END`);
    await expect(coordinator.createInitialTurn({ workspaceId: workspace.id, content: "Review", mode: "direct",
      branch: "feature/pr", pullRequestNumber: 42, startupId: directStartupId })).rejects.toThrow();
    expect(gitRepository.fetchBranch).toHaveBeenCalledExactlyOnceWith(workspace.id, "feature/pr", 42);
    expect(threads.listByWorkspace(workspace.id)).toEqual([]);
    expect(startups.get(directStartupId)?.error).toEqual({ code: "THREAD_CREATE_FAILED", message: "Thread creation failed",
      retryable: true, detail: "Thread storage unavailable" });
  });

  it("does not fetch or record a fetch phase for a direct branch carrying a PR number", async () => {
    const { workspace, startups, gitRepository, parent, fork, makeCoordinator } = await branchHarness();
    const created = await makeCoordinator().createInitialTurn({ workspaceId: workspace.id, content: "Branch here",
      mode: "direct", branch: "feature/pr", pullRequestNumber: 42, parentThreadId: parent.id,
      forkedFromMessageId: fork.id, startupId: directStartupId });
    expect(created).toMatchObject({ kind: "dispatch", command: { content: "Branch here", handoffPreamble: expect.stringContaining("Start here") } });
    expect(gitRepository.fetchBranch).not.toHaveBeenCalled();
    expect(startups.get(directStartupId)?.steps.map((step) => step.phase)).toEqual(["thread", "agent"]);
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
    vi.spyOn(handoffs, "writeHandoffAudit").mockRejectedValueOnce(new Error("Handoff failed"));
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
    const { workspace, workspaces, threads, threadService, admissions, gitRepository, fetchDecisions, startups } = await harness();
    const parent = await threads.create(workspace.id, "Parent", "direct", "main", true, "claude");
    let finishBranch: (() => void) | undefined;
    const branching = { create: vi.fn(async (_input: CreateBranchedThreadInput, lifecycle?: BranchedThreadLifecycle) => {
      await new Promise<void>((resolve) => { finishBranch = resolve; });
      return {
        thread: lifecycle ? await lifecycle.createAndBindDirectThread({ args: [workspace.id, "Child", "direct", "main", true, "claude", { parentThreadId: parent.id, forkedFromMessageId: "origin-message" }, "named", null] }) : await threads.create(workspace.id, "Child", "direct", "main", true, "claude", { parentThreadId: parent.id, forkedFromMessageId: "origin-message" }),
        handoffPreamble: "Parent handoff",
      };
    }) };
    const makeCoordinator = (startupService = startups) => new ThreadCreationCoordinator(
      threads, () => threadService, admissions as never, gitRepository,
      workspaces, fetchDecisions,
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
      command: { threadId: created.thread.id, handoffPreamble: "Parent handoff" },
    });
    expect(concurrentReplay).toMatchObject({ kind: "replay", thread: { id: created.thread.id } });
    await coordinator.startInitialAgent(directStartupId);
    expect(startups.get(directStartupId)).toMatchObject({ state: "running", phase: "agent", threadId: created.thread.id });

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
    const { workspace, workspaces, threads, threadService, admissions, gitRepository, fetchDecisions, startups } = await harness();
    const parent = await threads.create(workspace.id, "Parent", "direct", "main", true, "claude");
    const branching = { create: vi.fn(async (_input: CreateBranchedThreadInput, lifecycle?: BranchedThreadLifecycle) => {
      const thread = await threads.create(workspace.id, "Child", "worktree", "feature/child", true, "claude", {
        parentThreadId: parent.id, forkedFromMessageId: "origin-message",
      });
      await lifecycle?.onManagedThreadPersisted(thread);
      await threads.updateWorktreePath(thread.id, "/project/branched");
      return { thread: { ...thread, worktree_path: "/project/branched" }, handoffPreamble: "Parent handoff" };
    }) };
    const makeCoordinator = (startupService = startups) => new ThreadCreationCoordinator(
      threads, () => threadService, admissions as never, gitRepository,
      workspaces, fetchDecisions,
      () => branching as never, undefined, () => startupService,
    );
    const command = {
      workspaceId: workspace.id, content: "Branch in a worktree", mode: "worktree" as const,
      branch: "feature/child", pullRequestNumber: 42, parentThreadId: parent.id, startupId: managedStartupId,
    };
    const coordinator = makeCoordinator();
    const created = await coordinator.createInitialTurn(command);
    expect(created).toMatchObject({ kind: "dispatch", startupId: managedStartupId });
    expect(gitRepository.fetchBranch).not.toHaveBeenCalled();
    expect(startups.get(managedStartupId)?.steps[1].detail).toEqual({ phase: "worktree", mode: "created", folderName: "branched", path: "/project/branched" });
    expect(startups.get(managedStartupId)?.steps[2].detail).toEqual({ phase: "setup" });
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
    const { workspace, workspaces, threads, threadService, admissions, gitRepository, fetchDecisions, coordinator } = await harness();
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
      workspaces,
      fetchDecisions,
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

  it("keeps Direct startup in its agent phase after first runtime admission and records a first-dispatch failure", async () => {
    const { workspace, startups, coordinator } = await harness();

    await coordinator.createInitialTurn({
      workspaceId: workspace.id,
      content: "Start directly",
      startupId: directStartupId,
    });
    await coordinator.startInitialAgent(directStartupId);

    expect(startups.get(directStartupId)).toMatchObject({
      state: "running",
      phase: "agent",
      steps: [{ phase: "thread", state: "completed" }, { phase: "agent", state: "running" }],
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
