import "reflect-metadata";
import { startupEnvironmentFixture } from "../../../projects/environment/testing/startup-environment-fixture.js";
import { ThreadStartupFetchDecisions } from "../../../thread-startup/thread-startup-fetch-decisions.js";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { createThreadPersistenceTestRuntime } from "../../../thread-control/testing/thread-persistence-test-runtime.js";
let persistenceRuntime: ReturnType<typeof createThreadPersistenceTestRuntime>;
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { createAgentServiceForTest, drainAgentServicePersistenceForTest, goalLifecycleForAgentServiceTest, waitForAgentServiceWorkersForTest } from "./agent-service-test-harness.js";
import { WorkspaceEnvironmentService } from "../../../projects/environment/workspace-environment-service.js";
import { createCanonicalAgentBoundaryStub } from "../../canonical/__tests__/canonical-agent-boundary-stub.js";
import type { IAgentProvider, ProviderId } from "@mcode/contracts/providers/interfaces";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { FakeGitExecutor } from "../../../projects/git/execution/fake-git-executor.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { GoalLifecycleService } from "../../goals/goal-lifecycle-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
import type { TerminalCommandCompletion } from "../../../terminal/commands/terminal-command-service.js";
import { routeThreadStartupRpc } from "../../../thread-startup/transport/thread-startup-rpc.js";
import { routeAgentRpc, type AgentRouterDeps } from "../../transport/agent-rpc.js";

const roots: string[] = [];
const services: ReturnType<typeof createAgentServiceForTest>[] = [];

afterEach(async () => {
  // Each service owns a pool of execution worker threads. Left open, the pools pile up across the file, slow later
  // pool starts, and keep writing after their database closes.
  await Promise.all(services.splice(0).map((service) => drainAgentServicePersistenceForTest(service)));
  await Promise.all(roots.splice(0).map((root) => NodeFSPromises.rm(root, { recursive: true, force: true })));
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function requireThreadCreationOptions(options: Parameters<ThreadService["create"]>[4]) {
  if (!options) throw new Error("Expected thread creation options");
  return options;
}

function sendRpcDeps(agentService: AgentRouterDeps["agentService"]): AgentRouterDeps {
  const unused = (): never => { throw new Error("Unexpected dependency in send RPC"); };
  return {
    agentService,
    approvalService: { respondToApproval: unused, listPendingApprovals: unused },
    hookExecutionRepo: { listByMessage: unused },
    messageRepo: { listByThread: unused, listByThreadAfter: unused, listSessionNotices: unused, confirmUserMessage: unused },
    narrativeStore: { load: unused, listApprovals: unused },
    planQuestionAnswersRepo: { listAnsweredForThread: unused },
    planService: { saveVersion: unused, snapshot: unused, implement: unused, createComment: unused, updateComment: unused, setCommentStatus: unused, deleteComment: unused },
    planTurnService: { answerQuestions: unused, dismissQuestions: unused },
    recapService: { generate: unused },
    subagentRosterService: { loadRoster: unused, loadDetail: unused, stop: unused },
    taskRepo: { get: unused },
    thoughtSegmentRepo: { listByMessage: unused },
    threadControlService: { respondToApproval: unused, listPendingApprovals: unused },
    toolCallRecordRepo: { listByMessage: unused, listByParent: unused },
    turnRecoveryService: { retryErroredTurn: unused, resumeTurn: unused },
    turnResumeScheduler: { schedule: unused, unschedule: unused },
  };
}

async function createAgentServiceHarness(automaticSetup?:
  | { queueAutomaticFirstTurn: ReturnType<typeof vi.fn>; admitAutomaticTurn?: ReturnType<typeof vi.fn> }
  | ((deps: {
    readonly db: Database;
    readonly threadRepo: ThreadRepo;
    readonly threadStartups: ThreadStartupService;
  }) => WorkspaceEnvironmentService),
  useGoalLifecycle = false,
  threadBranching?: { create: ReturnType<typeof vi.fn> },
  providerId: ProviderId = "claude",
) {
  const db: Database = (persistenceRuntime = createThreadPersistenceTestRuntime()).reader;
  const threadRepo = new ThreadRepo(db, persistenceRuntime.writer);
  const workspaceRepo = new WorkspaceRepo(db, persistenceRuntime.writer);
  const messageRepo = new MessageRepo(db, persistenceRuntime.writer);
  const threadStartups = new ThreadStartupService(new ThreadStartupRepo(db, persistenceRuntime.writer), persistenceRuntime.writer);
  const gitService = new GitWorktreeService(workspaceRepo, new FakeGitExecutor(), hostRuntime);
  vi.spyOn(gitService, "listWorktrees").mockResolvedValue([]);
  vi.spyOn(gitService, "resolveWorkingDir").mockReturnValue(process.cwd());
  const threadService = {
    create: vi.fn(),
  } as unknown as ThreadService;
  const availability = { assertUsable: vi.fn() };
  const provider = {
    id: providerId,
    listModels: vi.fn<IAgentProvider["listModels"]>(async () => [
      { id: "provider-default", name: "Provider default" },
      { id: "provider-alternative", name: "Provider alternative" },
    ]),
    sendTurn: vi.fn<IAgentProvider["sendTurn"]>(async () => undefined),
    stopSession: vi.fn<IAgentProvider["stopSession"]>(async () => undefined),
    setGoal: vi.fn(),
    clearGoal: vi.fn(),
    getGoal: vi.fn(),
  };
  const providerRegistry = {
    resolve: vi.fn(() => provider),
    resolveAll: vi.fn(() => [provider]),
  };
  const attachmentService = {
    persist: vi.fn<AttachmentService["persist"]>(async () => ({ stored: [], persisted: [] })),
    removeStoredAttachments: vi.fn(async () => undefined),
  };
  const goals = { routeCommand: vi.fn<GoalLifecycleService["routeCommand"]>(async () => ({ kind: "passthrough" })) };
  const resolvedAutomaticSetup = typeof automaticSetup === "function"
    ? automaticSetup({ db, threadRepo, threadStartups })
    : automaticSetup;
  const service = createAgentServiceForTest(
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    attachmentService as never,
    providerRegistry as never,
    threadService,
    {} as never,
    {
      captureRef: vi.fn(async () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      getFilesChanged: vi.fn(async () => []),
    } as never,
    db,
    {
      markActive: vi.fn(),
      markIdle: vi.fn(),
      onPressureChange: vi.fn(),
    } as never,
    {
      get: vi.fn(() => ({
        model: { defaults: { fallbackId: undefined } },
        agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
      })),
    } as never,
    availability as never,
    { clear: vi.fn() } as never,
    new NarrativeStore(
      messageRepo,
      { bulkCreate: vi.fn(), bulkCreateBatched: vi.fn() } as never,
      { bulkCreate: vi.fn(), bulkCreateBatched: vi.fn() } as never,
      { bulkCreate: vi.fn(), bulkCreateBatched: vi.fn() } as never,
    ),
    new ParentAssistantTextCheckpointService(db, persistenceRuntime.writer),
    {} as never,
    undefined,
    undefined,
    createCanonicalAgentBoundaryStub(db, persistenceRuntime.writer),
    resolvedAutomaticSetup as never,
    undefined,
    undefined,
    useGoalLifecycle ? undefined : goals as never,
    undefined,
    undefined,
    threadBranching as never,
    undefined,
    threadStartups,
    persistenceRuntime.writer,
  );
  await waitForAgentServiceWorkersForTest(service);
  services.push(service);
  return {
    db,
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    threadService,
    service,
    provider,
    availability,
    attachmentService,
    goals,
    goalLifecycle: goalLifecycleForAgentServiceTest(service),
    automaticSetup: resolvedAutomaticSetup,
    threadStartups,
  };
}

describe("AgentService.createAndSend defaults", () => {
  it("queues only the first Turn for a managed New worktree before AgentService reserves runtime state", async () => {
    const automaticSetup = { queueAutomaticFirstTurn: vi.fn(), admitAutomaticTurn: vi.fn(() => ({ queued: true })) };
    const { threadRepo, workspaceRepo, threadService, service, provider } = await createAgentServiceHarness(automaticSetup);
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const managed = (await threadRepo.create(workspace.id, "Managed first Turn", "worktree", "feature/managed", true, "claude"));
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    vi.mocked(threadService.create).mockResolvedValue(managed);

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Queue this first Turn",
      mode: "worktree",
      branch: "feature/managed",
    });

    expect(automaticSetup.admitAutomaticTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: managed.id,
      content: "Queue this first Turn",
      submission: expect.objectContaining({ messageId: expect.any(String) }),
    }));
    expect(provider.sendTurn).not.toHaveBeenCalled();
    expect(result.runtimeSnapshot).toEqual({ threadId: managed.id, turnExecutionId: null, phase: "idle" });
  });

  it("dispatches a managed New first Turn without Continue when the workspace has no Setup", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-automatic-setup-"));
    roots.push(root);
    const prepare = vi.fn();
    const { threadRepo, workspaceRepo, threadService, service, provider, automaticSetup, threadStartups } = await createAgentServiceHarness(({ db, threadRepo: threads, threadStartups: startups }) =>
      startupEnvironmentFixture({
        mcodeDir: root,
        database: db,
        databaseWriter: persistenceRuntime.writer,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare },
        threadStartups: startups,
        platform: "linux",
      }),
    );
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const managed = (await threadRepo.create(workspace.id, "Managed first Turn", "worktree", "feature/managed", true, "claude"));
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      (await requireThreadCreationOptions(options).lifecycle?.onThreadPersisted(managed));
      return managed;
    });
    const providerCompletion = deferred<void>();
    provider.sendTurn.mockImplementation(async () => await providerCompletion.promise);
    const environment = automaticSetup as WorkspaceEnvironmentService;
    environment.setAutomaticSetupDispatcher({ dispatch: (submission) => service.dispatchQueuedAutomaticTurn(submission) });

    await service.createAndSend({
      workspaceId: workspace.id,
      content: "Dispatch without Setup",
      mode: "worktree",
      branch: "feature/managed",
      startupId: "00000000-0000-4000-8000-000000000001",
    });

    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledOnce());
    expect(prepare).not.toHaveBeenCalled();
    expect(environment.getAutomaticSetup({ threadId: managed.id })).toMatchObject({
      gate: "not-required",
      attempt: null,
      queuedTurns: [{ state: "dispatched", dispatchedAt: expect.any(String) }],
    });
    // The dispatched Turn holds the agent phase until its provider answers.
    expect(threadStartups.get("00000000-0000-4000-8000-000000000001")).toMatchObject({
      state: "running",
      phase: "agent",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "worktree", state: "completed" },
        { phase: "setup", state: "skipped" },
        { phase: "agent", state: "running" },
      ],
    });
    providerCompletion.resolve();
  });

  it("dispatches a follow-up Turn queued behind automatic Setup after the first Turn is dispatched", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-queued-drain-"));
    roots.push(root);
    const setupCompletion = deferred<TerminalCommandCompletion>();
    const { threadRepo, workspaceRepo, threadService, service, provider, automaticSetup, threadStartups } = await createAgentServiceHarness(({ db, threadRepo: threads, threadStartups: startups }) =>
      startupEnvironmentFixture({
        mcodeDir: root,
        database: db,
        databaseWriter: persistenceRuntime.writer,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: {
          prepare: async () => ({
            kind: "ready" as const,
            command: {
              snapshot: { checkoutPath: "/repo/.worktrees/managed", terminal: { executable: "sh", arguments: ["-c", "bun run setup"] } },
              start: async () => await setupCompletion.promise,
              close: async () => ({ kind: "contained" as const }),
              waitForRelease: async () => await new Promise<never>(() => undefined),
            },
          }),
        },
        threadStartups: startups,
        platform: "linux",
      }),
    );
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const managed = (await threadRepo.create(workspace.id, "Managed first Turn", "worktree", "feature/managed", true, "claude"));
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      (await requireThreadCreationOptions(options).lifecycle?.onThreadPersisted(managed));
      return managed;
    });
    const environment = automaticSetup as WorkspaceEnvironmentService;
    environment.setAutomaticSetupDispatcher({ dispatch: (submission) => service.dispatchQueuedAutomaticTurn(submission) });
    const startupId = "00000000-0000-4000-8000-000000000005";
    await environment.save({
      workspaceId: workspace.id,
      sourceRevision: null,
      document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { linux: "bun run setup" }, runOnStartup: true }] },
    });

    const creating = service.createAndSend({
      workspaceId: workspace.id,
      content: "First blocked Turn",
      mode: "worktree",
      branch: "feature/managed",
      startupId,
    });
    await vi.waitFor(() => expect(environment.getAutomaticSetup({ threadId: managed.id }).attempt?.state).toBe("running"));
    await service.sendMessage({ threadId: managed.id, content: "Second blocked Turn" });
    expect(environment.getAutomaticSetup({ threadId: managed.id }).queuedTurns).toHaveLength(2);

    setupCompletion.resolve({ kind: "exited", exitCode: 0, output: "", outputTruncated: false });
    await creating;
    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledOnce());
    // Dispatch alone leaves the startup waiting for the provider's first frame.
    expect(threadStartups.get(startupId)).toMatchObject({ state: "running", phase: "agent" });

    // Ending the first session releases the drain loop so it claims the second queued Turn.
    await service.stopSession(managed.id, { by: "user" });

    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledTimes(2));
    expect(environment.getAutomaticSetup({ threadId: managed.id }).queuedTurns).toEqual([
      expect.objectContaining({ state: "dispatched" }),
      expect.objectContaining({ state: "dispatched" }),
    ]);
  });

  it("dispatches a new turn on a kept thread after setup cancellation without replaying the first prompt", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-kept-cancelled-startup-"));
    roots.push(root);
    const setupCompletion = deferred<TerminalCommandCompletion>();
    const setupRelease = deferred<void>();
    const { threadRepo, workspaceRepo, threadService, service, provider, automaticSetup, threadStartups } = await createAgentServiceHarness(({ db, threadRepo: threads, threadStartups: startups }) =>
      startupEnvironmentFixture({
        mcodeDir: root, database: db, databaseWriter: persistenceRuntime.writer,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: {
          prepare: async () => ({
            kind: "ready",
            command: {
              snapshot: { checkoutPath: "/repo/.worktrees/managed", terminal: { executable: "sh", arguments: ["-c", "bun run setup"] } },
              start: async () => await setupCompletion.promise,
              close: async () => {
                setupCompletion.resolve({ kind: "exited", exitCode: 1, output: "", outputTruncated: false });
                setupRelease.resolve();
                return { kind: "contained" };
              },
              waitForRelease: async () => await setupRelease.promise,
            },
          }),
        },
        threadStartups: startups, platform: "linux",
      }),
    );
    if (!(automaticSetup instanceof WorkspaceEnvironmentService)) throw new Error("Expected automatic setup service");
    automaticSetup.setAutomaticSetupDispatcher({ dispatch: (submission) => service.dispatchQueuedAutomaticTurn(submission) });
    const workspace = await workspaceRepo.create("Repo", "/repo");
    const managed = await threadRepo.create(workspace.id, "Kept thread", "worktree", "feature/managed", true, "claude");
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      await requireThreadCreationOptions(options).lifecycle?.onThreadPersisted(managed);
      return managed;
    });
    await automaticSetup.save({ workspaceId: workspace.id, sourceRevision: null,
      document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { linux: "bun run setup" }, runOnStartup: true }] } });
    const startupId = "00000000-0000-4000-8000-000000000024";
    const creating = service.createAndSend({ workspaceId: workspace.id, content: "Cancelled first prompt",
      mode: "worktree", branch: "feature/managed", startupId });
    await vi.waitFor(() => expect(automaticSetup.getAutomaticSetup({ threadId: managed.id }).attempt?.state).toBe("running"));
    await routeThreadStartupRpc("thread.startup.cancel", { startupId }, {
      threadStartupService: threadStartups, workspaceEnvironmentService: automaticSetup, agentService: service,
      threadStartupFetchDecisions: new ThreadStartupFetchDecisions(),
    });
    await creating;
    expect(threadStartups.get(startupId)).toMatchObject({ state: "cancelled", phase: "setup" });
    expect(provider.sendTurn).not.toHaveBeenCalled();

    await service.sendMessage({ threadId: managed.id, content: "New prompt after Keep thread" });
    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledOnce());
    expect(provider.sendTurn.mock.calls[0]?.[0]).toMatchObject({ message: "New prompt after Keep thread" });
    expect(automaticSetup.getAutomaticSetup({ threadId: managed.id })).toMatchObject({
      gate: "not-required", queuedTurns: [{ state: "cancelled" }],
    });
    await expect(automaticSetup.continueAutomaticSetup({ threadId: managed.id })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
    });
    await expect(automaticSetup.retryAutomaticSetup({ threadId: managed.id })).resolves.toEqual(
      automaticSetup.getAutomaticSetup({ threadId: managed.id }),
    );
    expect(provider.sendTurn).toHaveBeenCalledOnce();
  });

  it("does not admit the queued provider turn when cancellation wins during admission", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-cancelled-admission-"));
    roots.push(root);
    const prepare = vi.fn();
    const { threadRepo, workspaceRepo, threadService, service, provider, automaticSetup, threadStartups, goals } = await createAgentServiceHarness(({ db, threadRepo: threads, threadStartups: startups }) =>
      startupEnvironmentFixture({
        mcodeDir: root,
        database: db,
        databaseWriter: persistenceRuntime.writer,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare },
        threadStartups: startups,
        platform: "linux",
      }),
    );
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const managed = (await threadRepo.create(workspace.id, "Managed first Turn", "worktree", "feature/managed", true, "claude"));
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      (await requireThreadCreationOptions(options).lifecycle?.onThreadPersisted(managed));
      return managed;
    });
    const heldAdmission = deferred<{ kind: "passthrough" }>();
    goals.routeCommand.mockImplementation(async () => await heldAdmission.promise);
    const environment = automaticSetup as WorkspaceEnvironmentService;
    environment.setAutomaticSetupDispatcher({ dispatch: (submission) => service.dispatchQueuedAutomaticTurn(submission) });
    const startupId = "00000000-0000-4000-8000-000000000022";

    const creating = service.createAndSend({
      workspaceId: workspace.id,
      content: "Cancel during provider admission",
      mode: "worktree",
      branch: "feature/managed",
      startupId,
    });
    await vi.waitFor(() => expect(goals.routeCommand).toHaveBeenCalledOnce());

    (await threadStartups.cancel(startupId));
    heldAdmission.resolve({ kind: "passthrough" });

    await creating;
    await vi.waitFor(() => expect(threadStartups.get(startupId)).toMatchObject({ state: "cancelled", phase: "agent" }));
    expect(provider.sendTurn).not.toHaveBeenCalled();
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(managed.id);
  });

  it("does not admit the initial provider turn after managed startup cancellation wins during admission", async () => {
    const automaticSetup = {
      queueAutomaticFirstTurn: vi.fn(),
      admitAutomaticTurn: vi.fn(() => ({ queued: false })),
      getAutomaticSetup: vi.fn(() => ({ gate: "released" })),
    };
    const { threadRepo, workspaceRepo, threadService, service, provider, attachmentService, threadStartups } = await createAgentServiceHarness(automaticSetup);
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const managed = (await threadRepo.create(workspace.id, "Managed first Turn", "worktree", "feature/managed", true, "claude"));
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      (await requireThreadCreationOptions(options).lifecycle?.onThreadPersisted(managed));
      return managed;
    });
    const heldAttachmentPersistence = deferred<{ stored: []; persisted: [] }>();
    attachmentService.persist.mockImplementation(async () => await heldAttachmentPersistence.promise);
    const startupId = "00000000-0000-4000-8000-000000000024";

    const creating = service.createAndSend({
      workspaceId: workspace.id,
      content: "Cancel managed initial provider admission",
      mode: "worktree",
      branch: "feature/managed",
      startupId,
    });
    await vi.waitFor(() => expect(attachmentService.persist).toHaveBeenCalledOnce());

    (await threadStartups.cancel(startupId));
    (await threadStartups.markCancelled(startupId));
    heldAttachmentPersistence.resolve({ stored: [], persisted: [] });

    const result = await creating;

    expect(threadStartups.get(startupId)).toMatchObject({ state: "cancelled", phase: "setup" });
    expect(result.runtimeSnapshot).toEqual({ threadId: result.id, turnExecutionId: null, phase: "idle" });
    expect(provider.sendTurn).not.toHaveBeenCalled();
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(result.id);
  });

  it("discards a prepared goal effect when queued cancellation wins before runtime reserve", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-cancelled-goal-admission-"));
    roots.push(root);
    const prepare = vi.fn();
    const { threadRepo, workspaceRepo, threadService, service, provider, automaticSetup, threadStartups, goalLifecycle } = await createAgentServiceHarness(({ db, threadRepo: threads, threadStartups: startups }) =>
      startupEnvironmentFixture({
        mcodeDir: root,
        database: db,
        databaseWriter: persistenceRuntime.writer,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare },
        threadStartups: startups,
        platform: "linux",
      }),
    true);
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const managed = (await threadRepo.create(workspace.id, "Managed first Turn", "worktree", "feature/managed", true, "claude"));
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    vi.mocked(threadService.create).mockImplementation(async (_workspaceId, _title, _mode, _branch, options) => {
      (await requireThreadCreationOptions(options).lifecycle?.onThreadPersisted(managed));
      return managed;
    });
    const environment = automaticSetup as WorkspaceEnvironmentService;
    environment.setAutomaticSetupDispatcher({ dispatch: (submission) => service.dispatchQueuedAutomaticTurn(submission) });
    const startupId = "00000000-0000-4000-8000-000000000023";
    const routeCommand = goalLifecycle.routeCommand.bind(goalLifecycle);
    vi.spyOn(goalLifecycle, "routeCommand").mockImplementation(async (...args) => {
      const outcome = await routeCommand(...args);
      (await threadStartups.cancel(startupId));
      return outcome;
    });

    await service.createAndSend({
      workspaceId: workspace.id,
      content: "Cancel queued goal admission",
      mode: "worktree",
      branch: "feature/managed",
      goalObjective: "Do not retain this goal",
      startupId,
    });

    await vi.waitFor(() => expect(goalLifecycle.routeCommand).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(threadStartups.get(startupId)).toMatchObject({ state: "cancelled", phase: "agent" }));
    expect(goalLifecycle.pendingCommandEffectCount()).toBe(0);
    expect(provider.sendTurn).not.toHaveBeenCalled();
  });

  it("persists each later Turn sent while automatic Setup remains blocked", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-queued-turn-"));
    roots.push(root);
    const { db, threadRepo, workspaceRepo, service, automaticSetup } = await createAgentServiceHarness(({ db, threadRepo: threads }) =>
      startupEnvironmentFixture({
        mcodeDir: root,
        database: db,
        databaseWriter: persistenceRuntime.writer,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: {
          prepare: async () => ({
            kind: "ready" as const,
            command: {
              snapshot: { checkoutPath: "/repo/.worktrees/managed", terminal: { executable: "sh", arguments: ["-c", "bun run setup"] } },
              start: async () => await new Promise<never>(() => undefined),
              close: async () => ({ kind: "contained" as const }),
              waitForRelease: async () => await new Promise<never>(() => undefined),
            },
          }),
        },
        platform: "linux",
      }),
    );
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const managed = (await threadRepo.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude"));
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    const environment = automaticSetup as WorkspaceEnvironmentService;
    await environment.save({
      workspaceId: workspace.id,
      sourceRevision: null,
      document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { linux: "bun run setup" }, runOnStartup: true }] },
    });
    (await environment.queueAutomaticFirstTurn({
      threadId: managed.id,
      messageId: "message-first",
      content: "First blocked Turn",
      attachments: [],
      mentions: [],
      submission: {
        threadId: managed.id,
        messageId: "message-first",
        content: "First blocked Turn",
        displayContent: "First blocked Turn",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        attachments: [],
        persistedAttachments: [],
        mentions: [],
        provider: "claude",
      },
    }));

    await service.sendMessage({ threadId: managed.id, content: "Second blocked Turn" });

    expect(environment.getAutomaticSetup({ threadId: managed.id }).queuedTurns).toHaveLength(2);
    expect(environment.getAutomaticSetup({ threadId: managed.id }).queuedTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: "message-first", state: "queued" }),
      expect.objectContaining({ state: "queued" }),
    ]));
    expect(db.prepare("SELECT content FROM messages WHERE thread_id = ? ORDER BY sequence").all(managed.id)).toEqual([
      { content: "First blocked Turn" },
      { content: "Second blocked Turn" },
    ]);
  });

  it("refuses a Send again resend while automatic Setup is blocked instead of queueing it unclaimed", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-queued-resend-"));
    roots.push(root);
    const { db, threadRepo, workspaceRepo, service, automaticSetup } = await createAgentServiceHarness(({ db, threadRepo: threads }) =>
      startupEnvironmentFixture({
        mcodeDir: root,
        database: db,
        databaseWriter: persistenceRuntime.writer,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare: vi.fn() },
        platform: "linux",
      }),
    );
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const managed = (await threadRepo.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude"));
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    const environment = automaticSetup as WorkspaceEnvironmentService;
    await environment.save({
      workspaceId: workspace.id,
      sourceRevision: null,
      document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { linux: "bun run setup" }, runOnStartup: true }] },
    });
    (await environment.queueAutomaticFirstTurn({
      threadId: managed.id,
      messageId: "message-first",
      content: "First blocked Turn",
      attachments: [],
      mentions: [],
      submission: {
        threadId: managed.id,
        messageId: "message-first",
        content: "First blocked Turn",
        displayContent: "First blocked Turn",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        attachments: [],
        persistedAttachments: [],
        mentions: [],
        provider: "claude",
      },
    }));

    await expect(service.sendMessage({ threadId: managed.id, content: "Use staging",
      messageId: "00000000-0000-4000-8000-0000000000a2", resendOfSteerId: "00000000-0000-4000-8000-0000000000a1" }))
      .rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE" });

    expect(environment.getAutomaticSetup({ threadId: managed.id }).queuedTurns).toHaveLength(1);
    expect(db.prepare("SELECT content FROM messages WHERE thread_id = ? ORDER BY sequence").all(managed.id)).toEqual([
      { content: "First blocked Turn" },
    ]);
  });

  it("removes newly persisted attachments when the automatic queue is at capacity", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-queued-turn-capacity-"));
    roots.push(root);
    const { threadRepo, workspaceRepo, service, attachmentService, automaticSetup } = await createAgentServiceHarness(({ db, threadRepo: threads }) =>
      startupEnvironmentFixture({
        mcodeDir: root,
        database: db,
        databaseWriter: persistenceRuntime.writer,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare: vi.fn() },
        platform: "linux",
      }),
    );
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const managed = (await threadRepo.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude"));
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    const environment = automaticSetup as WorkspaceEnvironmentService;
    await environment.save({
      workspaceId: workspace.id,
      sourceRevision: null,
      document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { linux: "bun run setup" }, runOnStartup: true }] },
    });
    for (let index = 1; index <= 64; index += 1) {
      (await environment.queueAutomaticFirstTurn({
        threadId: managed.id,
        messageId: `queued-capacity-${index}`,
        content: `Queued Turn ${index}`,
        attachments: [],
        mentions: [],
        submission: {
          threadId: managed.id,
          messageId: `queued-capacity-${index}`,
          content: `Queued Turn ${index}`,
          displayContent: `Queued Turn ${index}`,
          model: "claude-sonnet-4-6",
          permissionMode: "default",
          attachments: [],
          persistedAttachments: [],
          mentions: [],
          provider: "claude",
        },
      }));
    }
    const stored = { id: "attachment-capacity", name: "capacity.png", mimeType: "image/png", sizeBytes: 4 };
    attachmentService.persist.mockResolvedValue({
      stored: [stored],
      persisted: [{ ...stored, sourcePath: "/tmp/capacity.png" }],
    });

    await expect(service.sendMessage({
      threadId: managed.id,
      content: "Overflow queued Turn",
      attachments: [{ ...stored, sourcePath: "/tmp/source-capacity.png" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_SETUP_CAPACITY" });

    expect(attachmentService.removeStoredAttachments).toHaveBeenCalledWith(managed.id, [stored]);
  });

  it("removes newly persisted attachments when Thread deletion rejects automatic admission", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-queued-turn-deletion-"));
    roots.push(root);
    const { threadRepo, workspaceRepo, service, attachmentService, automaticSetup } = await createAgentServiceHarness(({ db, threadRepo: threads }) =>
      startupEnvironmentFixture({
        mcodeDir: root,
        database: db,
        databaseWriter: persistenceRuntime.writer,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare: vi.fn() },
        platform: "linux",
      }),
    );
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const managed = (await threadRepo.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude"));
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    const environment = automaticSetup as WorkspaceEnvironmentService;
    await environment.save({
      workspaceId: workspace.id,
      sourceRevision: null,
      document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { linux: "bun run setup" }, runOnStartup: true }] },
    });
    (await environment.queueAutomaticFirstTurn({
      threadId: managed.id,
      messageId: "queued-deletion-1",
      content: "First blocked Turn",
      attachments: [],
      mentions: [],
      submission: {
        threadId: managed.id,
        messageId: "queued-deletion-1",
        content: "First blocked Turn",
        displayContent: "First blocked Turn",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        attachments: [],
        persistedAttachments: [],
        mentions: [],
        provider: "claude",
      },
    }));
    const stored = { id: "attachment-deletion", name: "deletion.png", mimeType: "image/png", sizeBytes: 4 };
    attachmentService.persist.mockResolvedValue({
      stored: [stored],
      persisted: [{ ...stored, sourcePath: "/tmp/deletion.png" }],
    });
    const releaseDeletion = environment.beginThreadDeletion(managed.id);

    await expect(service.sendMessage({
      threadId: managed.id,
      content: "Rejected by deletion",
      attachments: [{ ...stored, sourcePath: "/tmp/source-deletion.png" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE" });

    expect(attachmentService.removeStoredAttachments).toHaveBeenCalledWith(managed.id, [stored]);
    releaseDeletion();
  });

  it("cleans released-gate attachments when a native command handles the send without persisting a Turn", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-queued-turn-handled-"));
    roots.push(root);
    const { threadRepo, workspaceRepo, messageRepo, service, attachmentService, goals, automaticSetup } = await createAgentServiceHarness(({ db, threadRepo: threads }) =>
      startupEnvironmentFixture({
        mcodeDir: root,
        database: db,
        databaseWriter: persistenceRuntime.writer,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare: async () => { throw new Error("setup unavailable"); } },
        platform: "linux",
      }),
    );
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const managed = (await threadRepo.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude"));
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    const environment = automaticSetup as WorkspaceEnvironmentService;
    await environment.save({
      workspaceId: workspace.id,
      sourceRevision: null,
      document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { linux: "bun run setup" }, runOnStartup: true }] },
    });
    (await environment.queueAutomaticFirstTurn({
      threadId: managed.id,
      messageId: "message-first",
      content: "First blocked Turn",
      attachments: [],
      mentions: [],
      submission: {
        threadId: managed.id,
        messageId: "message-first",
        content: "First blocked Turn",
        displayContent: "First blocked Turn",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        attachments: [],
        persistedAttachments: [],
        mentions: [],
        provider: "claude",
      },
    }));
    await vi.waitFor(() => expect(environment.getAutomaticSetup({ threadId: managed.id }).attempt?.state).toBe("failed"));
    const stored = { id: "attachment-handled", name: "handled.png", mimeType: "image/png", sizeBytes: 4 };
    attachmentService.persist.mockImplementationOnce(async () => {
      await environment.continueAutomaticSetup({ threadId: managed.id });
      return { stored: [stored], persisted: [{ ...stored, sourcePath: "/tmp/handled.png" }] };
    });
    goals.routeCommand.mockResolvedValueOnce({ kind: "handled" });

    await service.sendMessage({
      threadId: managed.id,
      content: "handled command after release",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      provider: "claude",
      attachments: [{ ...stored, sourcePath: "/tmp/source-handled.png" }],
    });

    expect(attachmentService.removeStoredAttachments).toHaveBeenCalledWith(managed.id, [stored]);
    expect(messageRepo.listByThread(managed.id, 100).messages.map((message) => message.content)).not.toContain("handled command after release");
  });

  it("replays a blocked reply with its plan and provenance fields exactly as queued", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-queued-turn-fidelity-"));
    roots.push(root);
    const { db, threadRepo, workspaceRepo, messageRepo, service, automaticSetup } = await createAgentServiceHarness(({ db, threadRepo: threads }) =>
      startupEnvironmentFixture({
        mcodeDir: root,
        database: db,
        databaseWriter: persistenceRuntime.writer,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare: vi.fn() },
        platform: "linux",
      }),
    );
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const managed = (await threadRepo.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude"));
    await threadRepo.updateWorktreePath(managed.id, "/repo/.worktrees/managed");
    managed.worktree_path = "/repo/.worktrees/managed";
    const replyTarget = (await messageRepo.create(managed.id, "assistant", "Prior answer", 1));
    const environment = automaticSetup as WorkspaceEnvironmentService;
    await environment.save({
      workspaceId: workspace.id,
      sourceRevision: null,
      document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { linux: "bun run setup" }, runOnStartup: true }] },
    });
    (await environment.queueAutomaticFirstTurn({
      threadId: managed.id,
      messageId: "message-first",
      content: "First blocked Turn",
      attachments: [],
      mentions: [],
      submission: {
        threadId: managed.id,
        messageId: "message-first",
        content: "First blocked Turn",
        displayContent: "First blocked Turn",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        attachments: [],
        persistedAttachments: [],
        mentions: [],
        provider: "claude",
      },
    }));

    await service.sendMessage({
      threadId: managed.id,
      content: "Queued reply",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      provider: "claude",
      attachments: [],
      replyToMessageId: replyTarget.id,
      quotedText: "The precise quoted passage",
      markPlanAnswerForMessageId: "00000000-0000-4000-8000-000000000001",
      sourceTurnId: "00000000-0000-4000-8000-000000000002",
      sourceThreadId: "source-thread",
      sourceProviderId: "codex",
      originSourceTurnId: "00000000-0000-4000-8000-000000000003",
    });

    const queued = db.prepare(
      "SELECT q.submission_json, m.id, m.reply_to_message_id, m.quoted_text, m.origin_type, m.source_thread_id, m.source_turn_id, m.source_provider_id FROM workspace_environment_queued_turns q JOIN messages m ON m.id = q.message_id WHERE q.thread_id = ? AND m.content = ?",
    ).get(managed.id, "Queued reply") as {
      submission_json: string;
      id: string;
      reply_to_message_id: string | null;
      quoted_text: string | null;
      origin_type: string;
      source_thread_id: string | null;
      source_turn_id: string | null;
      source_provider_id: string | null;
    };
    expect(queued).toMatchObject({
      reply_to_message_id: replyTarget.id,
      quoted_text: "The precise quoted passage",
      origin_type: "thread",
      source_thread_id: "source-thread",
      source_turn_id: "00000000-0000-4000-8000-000000000003",
      source_provider_id: "codex",
    });
    const persisted = JSON.parse(queued.submission_json) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      replyToMessageId: replyTarget.id,
      quotedText: "The precise quoted passage",
      markPlanAnswerForMessageId: "00000000-0000-4000-8000-000000000001",
      sourceTurnId: "00000000-0000-4000-8000-000000000002",
      sourceThreadId: "source-thread",
      sourceProviderId: "codex",
      originSourceTurnId: "00000000-0000-4000-8000-000000000003",
    });

  });

  it("dispatches Direct first turns and queues attached worktree first turns", async () => {
    const automaticSetup = { queueAutomaticFirstTurn: vi.fn(), admitAutomaticTurn: vi.fn(() => ({ queued: true })) };
    const { workspaceRepo, gitService, service, provider } = await createAgentServiceHarness(automaticSetup);
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    vi.mocked(gitService.listWorktrees).mockResolvedValue([
      { name: "existing", path: "/repo/.worktrees/existing", branch: "feature/existing", managed: true },
    ]);

    const direct = await service.createAndSend({ workspaceId: workspace.id, content: "Direct dispatch" });
    const attached = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Existing dispatch",
      mode: "worktree",
      branch: "feature/existing",
      existingWorktreePath: "/repo/.worktrees/existing",
    });

    expect(automaticSetup.queueAutomaticFirstTurn).not.toHaveBeenCalled();
    expect(direct.runtimeSnapshot.phase).toBe("running");
    expect(attached.runtimeSnapshot).toEqual({ threadId: attached.id, turnExecutionId: null, phase: "idle" });
    expect(automaticSetup.admitAutomaticTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: attached.id, content: "Existing dispatch" }));
    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledOnce());
  });

  it("returns the authoritative running runtime snapshot after startup", async () => {
    const { workspaceRepo, service } = await createAgentServiceHarness();
    const workspace = (await workspaceRepo.create("Repo", "/repo"));

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Start the first turn",
    });

    expect(result.runtimeSnapshot).toMatchObject({
      threadId: result.id,
      phase: "running",
    });
    expect(result.runtimeSnapshot.turnExecutionId).toEqual(expect.any(String));
  });

  it("replays a lost createAndSend response without creating or dispatching twice", async () => {
    const { workspaceRepo, threadRepo, service, provider, messageRepo } = await createAgentServiceHarness();
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const command = {
      workspaceId: workspace.id,
      content: "Start exactly once",
      startupId: "00000000-0000-4000-8000-000000000041",
    };

    const first = await service.createAndSend(command);
    const replay = await service.createAndSend(command);

    expect(replay.id).toBe(first.id);
    expect(replay.runtimeSnapshot).toEqual(first.runtimeSnapshot);
    expect(threadRepo.listByWorkspace(workspace.id)).toHaveLength(1);
    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledOnce());
    expect(messageRepo.listByThread(first.id, 10).messages).toHaveLength(1);
  });

  it("cancels a Direct startup whose cancellation lands while its thread is being created", async () => {
    const { workspaceRepo, service, provider, threadStartups } = await createAgentServiceHarness();
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const startupId = "00000000-0000-4000-8000-000000000026";
    const createAndBindThread = threadStartups.createAndBindThread.bind(threadStartups);
    vi.spyOn(threadStartups, "createAndBindThread").mockImplementation(async (...args) => {
      const thread = await createAndBindThread(...args);
      // The thread phase checkpoint has already passed, so only admission can see this intent.
      (await threadStartups.cancel(startupId));
      return thread;
    });

    const result = await service.createAndSend({ workspaceId: workspace.id, content: "Cancel while creating", startupId });

    expect(threadStartups.get(startupId)).toMatchObject({ state: "cancelled", phase: "agent", cancellation: "requested" });
    expect(result.runtimeSnapshot).toEqual({ threadId: result.id, turnExecutionId: null, phase: "idle" });
    expect(provider.sendTurn).not.toHaveBeenCalled();
  });

  it("completes startup when the initial native command is handled without a provider turn", async () => {
    const { workspaceRepo, service, provider, threadStartups } = await createAgentServiceHarness(undefined, true);
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const startupId = "00000000-0000-4000-8000-000000000025";

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "/goal clear",
      startupId,
    });

    expect(result.runtimeSnapshot).toEqual({ threadId: result.id, turnExecutionId: null, phase: "idle" });
    expect(threadStartups.get(startupId)).toMatchObject({
      state: "completed",
      phase: "agent",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "agent", state: "completed" },
      ],
    });
    expect(provider.sendTurn).not.toHaveBeenCalled();
  });

  it("returns an idle snapshot when startup fails before runtime ownership", async () => {
    const { workspaceRepo, service, availability } = await createAgentServiceHarness();
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    availability.assertUsable.mockImplementation(() => {
      throw new Error("startup failed");
    });

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Start the first turn",
    });

    expect(result.runtimeSnapshot).toEqual({
      threadId: result.id,
      turnExecutionId: null,
      phase: "idle",
    });
  });

  it("returns after runtime startup without waiting for provider completion", async () => {
    const { workspaceRepo, service, provider } = await createAgentServiceHarness();
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    let finishProvider!: () => void;
    const providerDone = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    provider.sendTurn.mockImplementation(async () => await providerDone);

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Start without waiting",
    });

    expect(result.runtimeSnapshot.phase).toBe("running");
    finishProvider();
  });

  it("uses the default model when the command omits it", async () => {
    const { threadRepo, workspaceRepo, service, provider } = await createAgentServiceHarness();
    const workspace = (await workspaceRepo.create("Repo", "/repo"));

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Use the default model",
    });

    expect(thread.model).toBe("claude-sonnet-4-6");
    expect(threadRepo.findById(thread.id)?.model).toBe("claude-sonnet-4-6");
    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: `mcode-${thread.id}`,
      model: "claude-sonnet-4-6",
    })));
  });

  it.each(["codex", "cursor"] satisfies ProviderId[])("defaults a model-less %s send to its own catalog", async (providerId) => {
    const { threadRepo, workspaceRepo, service, provider } = await createAgentServiceHarness(undefined, false, undefined, providerId);
    const workspace = await workspaceRepo.create("Repo", "/repo");
    const thread = await threadRepo.create(workspace.id, "New thread", "direct", "main", true, providerId);
    await threadRepo.updateModel(thread.id, "claude-sonnet-4-6");

    await routeAgentRpc("agent.send", { threadId: thread.id, content: "Use this provider's default", provider: providerId }, sendRpcDeps(service));

    expect(threadRepo.findById(thread.id)?.model).toBe("provider-default");
    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: thread.id,
      model: "provider-default",
    })));
  });

  it.each(["codex", "cursor"] satisfies ProviderId[])("keeps a stored %s model from its catalog when the send omits it", async (providerId) => {
    const { threadRepo, workspaceRepo, service, provider } = await createAgentServiceHarness(undefined, false, undefined, providerId);
    const workspace = await workspaceRepo.create("Repo", "/repo");
    const thread = await threadRepo.create(workspace.id, "Saved selection", "direct", "main", true, providerId);
    await threadRepo.updateModel(thread.id, "provider-alternative");

    await routeAgentRpc("agent.send", { threadId: thread.id, content: "Keep the selected model", provider: providerId }, sendRpcDeps(service));

    expect(threadRepo.findById(thread.id)?.model).toBe("provider-alternative");
    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledWith(expect.objectContaining({ model: "provider-alternative" })));
  });

  it("keeps an explicit model without consulting the default catalog", async () => {
    const { threadRepo, workspaceRepo, service, provider } = await createAgentServiceHarness(undefined, false, undefined, "codex");
    const workspace = await workspaceRepo.create("Repo", "/repo");
    const thread = await threadRepo.create(workspace.id, "Explicit model", "direct", "main", true, "codex");

    await routeAgentRpc("agent.send", { threadId: thread.id, content: "Use the selected model", provider: "codex", model: "provider-alternative" }, sendRpcDeps(service));

    expect(threadRepo.findById(thread.id)?.model).toBe("provider-alternative");
    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledWith(expect.objectContaining({ model: "provider-alternative" })));
    expect(provider.listModels).not.toHaveBeenCalled();
  });

  it("rejects a model-less send with no provider models before persisting a turn", async () => {
    const { threadRepo, workspaceRepo, messageRepo, service, provider } = await createAgentServiceHarness(undefined, false, undefined, "codex");
    const workspace = await workspaceRepo.create("Repo", "/repo");
    const thread = await threadRepo.create(workspace.id, "Empty catalog", "direct", "main", true, "codex");
    provider.listModels.mockResolvedValue([]);

    await expect(routeAgentRpc("agent.send", { threadId: thread.id, content: "No models", provider: "codex" }, sendRpcDeps(service))).rejects.toThrow();

    expect(threadRepo.findById(thread.id)?.model).toBeNull();
    expect(messageRepo.listByThread(thread.id, 100).messages).toEqual([]);
    expect(provider.sendTurn).not.toHaveBeenCalled();
  });

  it("adds selected-text comments to a branched first-turn handoff and persists their metadata", async () => {
    const threadBranching = { create: vi.fn() };
    const { threadRepo, workspaceRepo, messageRepo, service, provider } = await createAgentServiceHarness(
      undefined,
      false,
      threadBranching,
    );
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const parent = (await threadRepo.create(workspace.id, "Parent", "direct", "main", true, "claude"));
    const child = (await threadRepo.create(workspace.id, "Child", "direct", "branch/comment", true, "claude"));
    const comment = {
      id: "550e8400-e29b-41d4-a716-446655440010",
      displayNumber: 1,
      source: {
        threadId: parent.id,
        messageId: "completed-user-message",
        sourceRole: "user" as const,
        start: 1,
        end: 3,
        quote: "😀",
      },
      note: "Explain the selected text.",
      mentions: [],
    };
    threadBranching.create.mockResolvedValue({
      thread: child,
      handoffPreamble: "<branch-handoff>Historical context</branch-handoff>",
    });

    await service.createAndSend({
      workspaceId: workspace.id,
      content: "Continue from this branch.",
      mode: "direct",
      branch: "branch/comment",
      parentThreadId: parent.id,
      selectedTextComments: [comment],
    });

    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledOnce());
    const request = vi.mocked(provider.sendTurn).mock.calls[0]![0];
    if (!request) throw new Error("Expected the dispatched provider request");
    expect(request.message).toContain("<branch-handoff>Historical context</branch-handoff>");
    expect(request.message.match(/<!-- mcode-selected-text-comments-v1 -->/g)).toHaveLength(1);
    expect(request.message).toContain('"sourceRole":"user"');
    expect(messageRepo.listByThread(child.id, 10).messages).toEqual([
      expect.objectContaining({
        content: "Continue from this branch.",
        selectedTextComments: [comment],
      }),
    ]);
  });
});

describe("AgentService.createAndSend existing worktree attach", () => {
  it("creates a new worktree as branchless from the selected base branch", async () => {
    const { threadRepo, workspaceRepo, threadService, service } = await createAgentServiceHarness();
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const createdThread = {
      ...(await threadRepo.create(
        workspace.id,
        "Work from feature base",
        "worktree",
        "feature/base",
        true,
        "claude",
        undefined,
        "branchless",
        "feature/base",
      )),
      worktree_path: "/repo/.worktrees/feature-base",
    };
    vi.mocked(threadService.create).mockResolvedValue(createdThread);

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Work from feature base",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      mode: "worktree",
      branch: "feature/base",
    });

    expect(threadService.create).toHaveBeenCalledWith(
      workspace.id,
      "Work from feature base",
      "worktree",
      "feature/base",
      { branchless: true, provider: "claude" },
    );
    expect(thread).toMatchObject({
      mode: "worktree",
      branch: "feature/base",
      checkout_state: "branchless",
      base_branch: "feature/base",
    });
  });

  it("creates a new worktree on a PR branch as a named checkout", async () => {
    const { threadRepo, workspaceRepo, threadService, service } = await createAgentServiceHarness();
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    const createdThread = {
      ...(await threadRepo.create(
        workspace.id,
        "Review PR",
        "worktree",
        "contributor/pr-branch",
        true,
        "claude",
        undefined,
        "named",
        null,
      )),
      worktree_path: "/repo/.worktrees/contributor-pr-branch",
    };
    vi.mocked(threadService.create).mockResolvedValue(createdThread);

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Review PR",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      mode: "worktree",
      branch: "contributor/pr-branch",
      worktreeBranchMode: "named",
    });

    expect(threadService.create).toHaveBeenCalledWith(
      workspace.id,
      "Review PR",
      "worktree",
      "contributor/pr-branch",
      { branchless: false, provider: "claude" },
    );
    expect(thread).toMatchObject({
      mode: "worktree",
      branch: "contributor/pr-branch",
      checkout_state: "named",
      base_branch: null,
    });
  });

  it("attaches a detached existing worktree as branchless with the selected base branch", async () => {
    const { workspaceRepo, gitService, service } = await createAgentServiceHarness();
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    vi.mocked(gitService.listWorktrees).mockResolvedValue([
      {
        name: "branchless-existing",
        path: "/repo/.worktrees/branchless-existing",
        branch: "(detached)",
        managed: true,
      },
    ]);

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Work in detached worktree",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      mode: "worktree",
      branch: "main",
      existingWorktreePath: "/repo/.worktrees/branchless-existing/",
      existingWorktreeBaseBranch: "main",
      attachments: [],
      provider: "claude",
    });

    expect(thread).toMatchObject({
      mode: "worktree",
      worktree_path: "/repo/.worktrees/branchless-existing",
      branch: "main",
      checkout_state: "branchless",
      base_branch: "main",
      worktree_managed: false,
    });
  });

  it("keeps named existing worktree attach behavior unchanged", async () => {
    const { workspaceRepo, gitService, service } = await createAgentServiceHarness();
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    vi.mocked(gitService.listWorktrees).mockResolvedValue([
      {
        name: "feature-existing",
        path: "/repo/.worktrees/feature-existing",
        branch: "feat/existing",
        managed: true,
      },
    ]);

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Work in named worktree",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      mode: "worktree",
      branch: "main",
      existingWorktreePath: "/repo/.worktrees/feature-existing",
      attachments: [],
      provider: "claude",
    });

    expect(thread).toMatchObject({
      mode: "worktree",
      worktree_path: "/repo/.worktrees/feature-existing",
      branch: "feat/existing",
      checkout_state: "named",
      base_branch: null,
      worktree_managed: false,
    });
  });

  it("rejects HEAD as the base branch for detached existing worktrees", async () => {
    const { workspaceRepo, gitService, service } = await createAgentServiceHarness();
    const workspace = (await workspaceRepo.create("Repo", "/repo"));
    vi.mocked(gitService.listWorktrees).mockResolvedValue([
      {
        name: "branchless-existing",
        path: "/repo/.worktrees/branchless-existing",
        branch: "(detached)",
        managed: true,
      },
    ]);

    await expect(
      service.createAndSend({
        workspaceId: workspace.id,
        content: "Work in detached worktree",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        mode: "worktree",
        branch: "main",
        existingWorktreePath: "/repo/.worktrees/branchless-existing",
        existingWorktreeBaseBranch: "HEAD",
        attachments: [],
        provider: "claude",
      }),
    ).rejects.toThrow("Base branch cannot be HEAD");
  });
});
