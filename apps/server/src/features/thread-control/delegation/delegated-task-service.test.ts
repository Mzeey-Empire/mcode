import "reflect-metadata";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";
import { WS_CHANNELS } from "@mcode/contracts";
import type { AgentStopResult, DelegateTaskResult, TaskStatusResult, IAgentProvider, IProviderRegistry } from "@mcode/contracts";
import type { InternalThreadControlAuthority } from "@mcode/thread-orchestration";
import { createOriginFixture, git } from "../../projects/git/__tests__/start-from-origin-fixture.js";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { ThreadService } from "../lifecycle/thread-service.js";
import { ThreadControlService } from "../authority/thread-control-service.js";
import { ThreadControlApprovalRepo } from "../authority/persistence/thread-control-approval-repo.js";
import { ThreadControlAuditRepo } from "../authority/persistence/thread-control-audit-repo.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { WorktreeRepo } from "../../projects/persistence/worktree-repo.js";
import { ProjectWorktreeService } from "../../projects/worktrees/project-worktree-service.js";
import { SandboxWorktreeCleanupPolicy } from "../../projects/worktrees/sandbox-worktree-cleanup-policy.js";
import { WorktreeSafetyService } from "../../projects/git/worktree-safety-service.js";
import { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import { GitRepositoryService } from "../../projects/git/git-repository-service.js";
import { FileService } from "../../projects/files/file-service.js";
import { startupEnvironmentFixture } from "../../projects/environment/testing/startup-environment-fixture.js";
import { WorkspaceEnvironmentService } from "../../projects/environment/workspace-environment-service.js";
import { SettingsService } from "../../settings/settings-service.js";
import { ModelCacheService } from "../../providers/models/model-cache-service.js";
import { ModelCacheRepo } from "../../providers/models/persistence/model-cache-repo.js";
import { ModelSightingsRepo } from "../../providers/status/model-sightings-repo.js";
import { ProviderRegistry } from "../../providers/composition/provider-registry.js";
import { ProviderAvailabilityService } from "../../providers/availability/provider-availability-service.js";
import { AgentService } from "../../agents/orchestration/agent-service.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../../agents/orchestration/agent-turn-command-port.js";
import { ApprovalService } from "../../agents/approvals/approval-service.js";
import { CanonicalAgentBoundary } from "../../agents/canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../agents/canonical/canonical-agent-writer-client.js";
import { MessageRepo } from "../../agents/conversation/persistence/message-repo.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { HandoffStorage } from "../../handoff/index.js";
import { PlanTurnService } from "../../agents/planning/plan-turn-service.js";
import { PlanQuestionService } from "../../agents/planning/plan-question-service.js";
import { PlanRepo } from "../../agents/planning/persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../../agents/planning/persistence/plan-question-answers-repo.js";
import { GoalLifecycleService } from "../../agents/goals/goal-lifecycle-service.js";
import { TurnRevertStore } from "../../agents/turns/persistence/turn-revert-store.js";
import { ThreadCreationCoordinator } from "../../agents/turns/thread-creation-coordinator.js";
import { TurnAdmissionDispatchCoordinator, type TurnRuntimeAdmissionAuthority } from "../../agents/turns/turn-admission-dispatch-coordinator.js";
import { ThreadStartupService } from "../../thread-startup/thread-startup-service.js";
import { ThreadStartupRepo } from "../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadStartupFetchDecisions } from "../../thread-startup/thread-startup-fetch-decisions.js";
import { DelegationTargetResolver } from "../../agents/collaboration/delegation-target-resolver.js";
import { DelegatedTaskRepo } from "./delegated-task-repo.js";
import { DelegatedTaskService } from "./delegated-task-service.js";
import { broadcast } from "../../../application/transport/push.js";

vi.mock("../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));
const disposables: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of disposables.splice(0)) await dispose();
  vi.restoreAllMocks();
});

async function harness(permissionMode: "full" | "supervised" = "full", setup = false) {
  const fixture = await createOriginFixture();
  const { runtime, workspace, workspaces, repository, worktrees, executor, host } = fixture;
  const threads = new ThreadRepo(runtime.reader, runtime.writer);
  const messages = new MessageRepo(runtime.reader, runtime.writer);
  const startups = new ThreadStartupService(new ThreadStartupRepo(runtime.reader, runtime.writer), runtime.writer);
  const fetchDecisions = new ThreadStartupFetchDecisions();
  const settings = new SettingsService();
  disposables.push(() => settings.dispose());
  const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
    id: "codex" as const, descriptor: { id: "codex" as const, capabilities: [] }, subagentReporting: null,
    supportsCompletion: false, sessionForkOnResume: "unsupported" as const, maxInputCharactersPerTurn: 100_000,
    forker: { fork: async () => { throw new Error("Delegation starts a new session"); } },
    sendTurn: async () => {}, stopSession: () => {}, shutdown: () => {},
    listModels: async () => [{ id: "gpt-test", name: "Test" }],
  });
  const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
  const models = new ModelCacheService(new ModelCacheRepo(runtime.reader, runtime.writer), providers,
    new ModelSightingsRepo(runtime.reader, runtime.writer));
  disposables.push(() => models.close());
  const targets = new DelegationTargetResolver(providers, models, settings);
  const approvals = new ThreadControlApprovalRepo(runtime.reader, runtime.writer);
  const canonical = new CanonicalAgentBoundary(runtime.reader, runtime.writer, new CanonicalAgentWriterClient(runtime.writer), () => {});
  const attachments = new AttachmentService();
  const commands = new AgentRuntimeCommandPort();
  const plans = new PlanTurnService(threads, providers, new PlanQuestionService(messages, new PlanQuestionAnswersRepo(runtime.reader, runtime.writer)),
    new PlanRepo(runtime.reader, runtime.writer), new AgentTurnCommandPort(commands));
  const environment = startupEnvironmentFixture({
    mcodeDir: fixture.root, database: runtime.reader, databaseWriter: runtime.writer, threads, workspaces,
    threadStartups: startups, platform: "windows",
    terminalCommands: { prepare: async () => ({ kind: "ready", command: {
      snapshot: { checkoutPath: fixture.repoPath, terminal: { executable: "sh", arguments: [] } },
      start: () => new Promise(() => {}), close: async () => ({ kind: "contained" }), waitForRelease: () => new Promise(() => {}),
    } }) },
  });
  disposables.push(() => environment.dispose());
  if (setup) await environment.save({ workspaceId: workspace.id, sourceRevision: null,
    document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { default: "setup" }, runOnStartup: true }] } });
  const admission = new TurnAdmissionDispatchCoordinator(threads, workspaces, messages, new TurnRevertStore(runtime.reader), worktrees,
    attachments, providers, new ProviderAvailabilityService(settings, providers), canonical, settings, plans,
    new GoalLifecycleService(threads, providers, runtime.writer, commands, canonical), environment,
    new FileService(workspaces, threads, worktrees, executor, host), host.platform,
    { start: async ({ parentTurn }) => { await canonical.startParentTurn(parentTurn); } });
  const projects = new ProjectWorktreeService(threads, workspaces, runtime.writer, worktrees,
    new SandboxWorktreeCleanupPolicy(new WorktreeSafetyService(executor, host), repository, host));
  const threadService = new ThreadService(threads, projects, attachments, new HandoffStorage(), {
    teardownThread: async () => {}, deletePersistentData: async (_ids, remove) => remove(),
  });
  const creation = new ThreadCreationCoordinator(threads, () => threadService, admission, repository, workspaces, fetchDecisions,
    undefined, undefined, () => startups);
  const active = new Set<string>();
  const authority: TurnRuntimeAdmissionAuthority = {
    reserve: (command) => ({ threadId: command.threadId, turnExecutionId: NodeCrypto.randomUUID(), mutationReservationToken: NodeCrypto.randomUUID(), generation: 1 }),
    activate: () => {}, abort: async () => {}, release: () => {}, owns: () => true,
  };
  const dispatch: Parameters<WorkspaceEnvironmentService["setAutomaticSetupDispatcher"]>[0]["dispatch"] = async (submission) => {
    const admitted = await admission.admit(admission.queuedCommand(submission), authority);
    if (admitted.kind === "dispatch") active.add(submission.threadId);
    return { completion: Promise.resolve() };
  };
  environment.setAutomaticSetupDispatcher({ dispatch });
  const stopSession = async (threadId: string): Promise<AgentStopResult> => {
    active.delete(threadId);
    return { threadId, turnExecutionId: null, status: "already-terminal", dispatchState: "not-dispatched", snapshot: { threadId, turnExecutionId: null, phase: "idle" } };
  };
  const child = container.createChildContainer();
  child.registerInstance(WorkspaceRepo, workspaces);
  child.registerInstance(WorktreeRepo, new WorktreeRepo(runtime.reader, runtime.writer));
  child.registerInstance(ThreadRepo, threads);
  child.registerInstance(GitWorktreeService, worktrees);
  child.registerInstance(GitRepositoryService, repository);
  child.registerInstance(ProjectWorktreeService, projects);
  child.registerInstance(SettingsService, settings);
  child.registerInstance< IProviderRegistry >(ProviderRegistry, providers);
  child.registerInstance(ModelCacheService, models);
  child.registerInstance(DelegationTargetResolver, targets);
  const approvalService = new ApprovalService(providers);
  approvalService.start({ publishApprovalRequest: () => {}, publishApprovalResolved: () => {}, stopSession });
  child.registerInstance(ApprovalService, approvalService);
  child.registerInstance(ThreadControlApprovalRepo, approvals);
  child.registerInstance(ThreadControlAuditRepo, new ThreadControlAuditRepo(runtime.writer));
  child.registerInstance<Pick<AgentService, "stopSession" | "runtimeAccess">>(AgentService, { stopSession,
    runtimeAccess: () => ({ activeThreadIds: () => [...active], activeCount: () => active.size, runtimeSnapshots: () => [] }) });
  child.registerInstance(ThreadStartupService, startups);
  child.registerInstance(ThreadStartupFetchDecisions, fetchDecisions);
  child.registerInstance(WorkspaceEnvironmentService, environment);
  const cancellation = { threadStartupService: startups, threadStartupFetchDecisions: fetchDecisions,
    workspaceEnvironmentService: environment, agentService: { stopSession } };
  child.registerInstance("CancelThreadStartupDeps", cancellation);
  const control = child.resolve(ThreadControlService);
  const tasks = new DelegatedTaskRepo(runtime.reader, runtime.writer);
  const service = new DelegatedTaskService({ tasks, threads, startups, approvals, canonical, targets, git: worktrees, control,
    approvalService, cancellation,
    commands: { createAndSend: async (command, options) => {
      const created = await creation.createInitialTurn(command, options);
      if (created.kind === "dispatch") {
        await admission.admit(created.command, authority);
        active.add(created.thread.id);
      }
      return created.thread;
    } },
  });
  child.registerInstance(DelegatedTaskService, service);
  const coordinator = await threads.create(workspace.id, "Coordinator", "direct", "main", false, "codex");
  const source: InternalThreadControlAuthority = { type: "internal", userId: "local-user", sourceThreadId: coordinator.id,
    sourceTurnId: NodeCrypto.randomUUID(), sourceToolCallId: "delegate-call", sourceProviderId: "codex", permissionMode };
  const input = { clientRequestId: "review-1", title: "Review", prompt: "Find bugs", providerId: "codex", modelId: "gpt-test", isolation: "worktree" as const };
  return { ...fixture, service, tasks, threads, startups, approvals, control, canonical, messages, environment, coordinator, source, input, dispatch };
}

function requireTask(result: DelegateTaskResult): Exclude<DelegateTaskResult, { status: "rejected" }>;
function requireTask(result: TaskStatusResult): Exclude<TaskStatusResult, { status: "rejected" }>;
function requireTask(result: DelegateTaskResult | TaskStatusResult) {
  if ("status" in result) throw new Error(`Task was rejected: ${result.error.code}: ${result.error.message}`);
  return result;
}

describe("delegated task lifecycle", { timeout: 30_000 }, () => {
  it("pins HEAD and repairs lineage on a retried request", async () => {
    const f = await harness();
    const first = requireTask(await f.service.delegate(f.source, f.input));
    git(f.repoPath, "commit", "--allow-empty", "-m", "Moved HEAD");
    const retry = requireTask(await f.service.delegate(f.source, f.input));
    expect(retry.taskId).toBe(first.taskId);
    expect(retry.threadId).toBe(first.threadId);
    expect(f.threads.listByWorkspace(f.workspace.id)).toHaveLength(2);
    const thread = f.threads.findById(first.threadId ?? "");
    expect(git(thread?.worktree_path ?? "", "rev-parse", "HEAD")).toBe(f.localSha);
  });

  it("pushes the delegated thread's lineage to clients that already hold the thread", async () => {
    const f = await harness();
    const task = requireTask(await f.service.delegate(f.source, f.input));
    const pushed = vi.mocked(broadcast).mock.calls
      .filter(([channel]) => channel === "thread.lifecycleChanged")
      .map(([, payload]) => WS_CHANNELS["thread.lifecycleChanged"].parse(payload).thread)
      .filter((thread) => thread.id === task.threadId);
    expect(pushed.at(-1)?.delegation_coordinator_thread_id).toBe(f.coordinator.id);
  });

  it("queues the reserved first turn with its origin and replays it after setup", async () => {
    const f = await harness("full", true);
    const task = requireTask(await f.service.delegate(f.source, f.input));
    expect(task.state).toEqual({ status: "working", phase: "preparing" });
    expect(f.canonical.loadTurn(task.taskId)).toBeNull();
    await vi.waitFor(() => expect(f.environment.getAutomaticSetup({ threadId: task.threadId ?? "" }).attempt?.state).toBe("running"));
    await f.environment.continueAutomaticSetup({ threadId: task.threadId ?? "" });
    await vi.waitFor(() => expect(f.canonical.loadTurn(task.taskId)?.status).toBe("Running"));
    const user = f.messages.listByThreadForThreadControl(task.threadId ?? "", 10).messages.find(message => message.role === "user");
    expect(user).toMatchObject({ originType: "thread", sourceThreadId: f.coordinator.id,
      sourceTurnId: f.source.sourceTurnId, sourceProviderId: "codex" });
  });

  it("requires a durable worktree approval and accepts it only once", async () => {
    const f = await harness("supervised");
    const task = requireTask(await f.service.delegate(f.source, f.input));
    expect(task.state).toEqual({ status: "waiting", reason: "approval" });
    expect(f.startups.get(task.taskId)).toBeNull();
    expect(f.threads.listByWorkspace(f.workspace.id)).toHaveLength(1);
    expect(f.control.listPendingApprovals(f.coordinator.id)[0]?.subject).toMatchObject({ kind: "delegate_task", taskId: task.taskId, commit: f.localSha.slice(0, 12) });
    expect(await f.control.respondToApproval(task.taskId, { choiceId: "allow" })).toEqual({ status: "resolved" });
    expect(await f.control.respondToApproval(task.taskId, { choiceId: "allow" })).toEqual({ status: "not_pending" });
    expect(f.threads.listByWorkspace(f.workspace.id)).toHaveLength(2);
    await vi.waitFor(async () => expect(requireTask(await f.service.status(f.source, { taskId: task.taskId })).state)
      .toEqual({ status: "working", phase: "running" }));
  });

  it("denies without creating a child and recovers a processing approval idempotently", async () => {
    const f = await harness("supervised");
    const denied = requireTask(await f.service.delegate(f.source, f.input));
    await f.control.respondToApproval(denied.taskId, { choiceId: "deny" });
    expect(requireTask(await f.service.status(f.source, { taskId: denied.taskId })).state).toEqual({ status: "finished", outcome: "denied" });
    expect(f.threads.findById(f.coordinator.id)?.status).toBe("active");
    const accepted = requireTask(await f.service.delegate(f.source, { ...f.input, clientRequestId: "review-2" }));
    await f.approvals.claim(accepted.taskId);
    await f.control.recoverApprovals();
    expect(f.threads.listByWorkspace(f.workspace.id)).toHaveLength(1);
    expect(requireTask(await f.service.status(f.source, { taskId: accepted.taskId })).state).toEqual({ status: "waiting", reason: "approval" });
    await f.approvals.claim(accepted.taskId);
    await f.approvals.setOperationPhase(accepted.taskId, "dispatching");
    await f.control.recoverApprovals();
    await f.control.recoverApprovals();
    expect(f.threads.listByWorkspace(f.workspace.id)).toHaveLength(2);
    await vi.waitFor(async () => expect(requireTask(await f.service.status(f.source, { taskId: accepted.taskId })).state)
      .toEqual({ status: "working", phase: "running" }));
  });

  it("enforces the permission ceiling before writing a receipt and inherits the caller mode", async () => {
    const f = await harness("supervised");
    expect(await f.service.delegate(f.source, { ...f.input, permissionMode: "full" })).toMatchObject({ status: "rejected", error: { code: "forbidden" } });
    expect(f.tasks.findByRequest(f.coordinator.id, f.input.clientRequestId)).toBeNull();
    expect(requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" })).effectivePermissionMode).toBe("supervised");
  });

  it("cancels setup through threadStop and requires approval to stop a supervised running task", async () => {
    const f = await harness("full", true);
    const task = requireTask(await f.service.delegate(f.source, f.input));
    await vi.waitFor(() => expect(f.environment.getAutomaticSetup({ threadId: task.threadId ?? "" }).attempt?.state).toBe("running"));
    expect(await f.service.cancel(f.source, { taskId: task.taskId })).toMatchObject({ state: { status: "finished", outcome: "cancelled" } });
    expect(f.startups.get(task.taskId)?.state).toBe("cancelled");
    expect(f.environment.getAutomaticSetup({ threadId: task.threadId ?? "" }).queuedTurns)
      .toEqual([expect.objectContaining({ state: "cancelled", dispatchedAt: null })]);
    const running = requireTask(await f.service.delegate(f.source, { ...f.input, clientRequestId: "running", isolation: "shared" }));
    expect(await f.service.cancel({ ...f.source, permissionMode: "supervised" }, { taskId: running.taskId }))
      .toMatchObject({ stopApprovalId: expect.any(String), state: { status: "waiting", reason: "needs_input" } });
  });

  it("repairs a failed lineage commit on status", async () => {
    const f = await harness();
    f.runtime.database.run(`CREATE TRIGGER reject_delegation_lineage
      BEFORE UPDATE OF delegation_coordinator_thread_id ON threads
      BEGIN SELECT RAISE(ABORT, 'lineage storage failed'); END`);
    await expect(f.service.delegate(f.source, f.input)).rejects.toThrow("lineage storage failed");
    const receipt = f.tasks.findByRequest(f.coordinator.id, f.input.clientRequestId);
    if (!receipt) throw new Error("Expected durable receipt");
    f.runtime.database.run("DROP TRIGGER reject_delegation_lineage");
    const status = requireTask(await f.service.status(f.source, { taskId: receipt.taskId }));
    expect(f.threads.findById(status.threadId ?? "")?.delegation_coordinator_thread_id).toBe(f.coordinator.id);
  });

  it("keeps the original result during a later user turn and makes completed cancellation a no-op", async () => {
    const f = await harness();
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    const turn = f.canonical.loadTurn(task.taskId);
    if (!task.threadId || !turn?.executionId) throw new Error("Expected admitted task turn");
    const message = await f.messages.create(task.threadId, "assistant", "Review complete", 2);
    await f.canonical.finishParentTurnBatched({
      threadId: task.threadId, turnId: task.taskId, executionId: turn.executionId,
      providerId: "codex", providerIdentities: [], outcome: "completed", projection: { message, narrative: [] },
    });
    const laterTurnId = NodeCrypto.randomUUID();
    await f.canonical.startParentTurn({
      thread: { id: task.threadId, workspaceId: f.workspace.id, providerId: "codex", createdAt: new Date().toISOString() },
      turnId: laterTurnId, executionId: NodeCrypto.randomUUID(), permissionMode: "full", providerIdentities: [],
      userMessage: { kind: "create", messageId: NodeCrypto.randomUUID(), content: "Another task", sequence: 3 },
    });
    const completed = { status: "finished", outcome: "completed", summary: "Review complete" };
    expect(await f.service.status(f.source, { taskId: task.taskId }))
      .toEqual({ taskId: task.taskId, threadId: task.threadId, state: completed });
    expect(await f.service.cancel(f.source, { taskId: task.taskId })).toEqual({ taskId: task.taskId, state: completed });
    expect(f.canonical.loadTurn(laterTurnId)?.status).toBe("Running");
    expect(f.approvals.listPending()).toEqual([]);
  });

  it("does not expose another Coordinator's task", async () => {
    const f = await harness("supervised");
    const task = requireTask(await f.service.delegate(f.source, f.input));
    const other = { ...f.source, sourceThreadId: "other" };
    expect(await f.service.status(other, { taskId: task.taskId })).toEqual(await f.service.status(other, { taskId: NodeCrypto.randomUUID() }));
    expect(await f.service.cancel(other, { taskId: task.taskId })).toMatchObject({ status: "rejected", error: { code: "not_found" } });
  });
});
