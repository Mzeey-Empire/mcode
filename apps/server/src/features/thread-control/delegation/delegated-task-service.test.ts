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
import { notifyCommittedCanonicalEvents, subscribeCommittedCanonicalEvents } from "../../agents/canonical/committed-canonical-events.js";
import { notifyTasksOnSettledTurns } from "../attention/thread-attention-service.js";
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
import { SubagentRosterService } from "../../agents/collaboration/subagent-roster-service.js";
import { NarrativeStore } from "../../agents/conversation/narrative/narrative-store.js";
import { ToolCallRecordRepo } from "../../agents/tools/persistence/tool-call-record-repo.js";
import { ToolCallRecordStore } from "../../agents/tools/persistence/tool-call-record-store.js";
import { ThoughtSegmentRepo } from "../../agents/conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo } from "../../agents/events/persistence/hook-execution-repo.js";
import { broadcast } from "../../../application/transport/push.js";

vi.mock("../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));
const disposables: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of disposables.splice(0)) await dispose();
  vi.restoreAllMocks();
});

async function harness(permissionMode: "full" | "supervised" = "full", setup = false, coordinatorMode: "direct" | "worktree" = "direct") {
  const fixture = await createOriginFixture();
  const { runtime, workspace, workspaces, repository, worktrees, executor, host } = fixture;
  const threads = new ThreadRepo(runtime.reader, runtime.writer);
  const messages = new MessageRepo(runtime.reader, runtime.writer);
  const startups = new ThreadStartupService(new ThreadStartupRepo(runtime.reader, runtime.writer), runtime.writer);
  const fetchDecisions = new ThreadStartupFetchDecisions();
  const settings = new SettingsService();
  disposables.push(() => settings.dispose());
  const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
    id: "codex" as const, descriptor: { id: "codex" as const, capabilities: [{ name: "child-cancellation" as const, support: "supported" as const }] }, subagentReporting: null,
    supportsCompletion: false, sessionForkOnResume: "unsupported" as const, maxInputCharactersPerTurn: 100_000,
    forker: { fork: async () => { throw new Error("Delegation starts a new session"); } },
    sendTurn: async () => {}, stopSession: () => {}, shutdown: () => {},
    interruptChildTurn: async () => {},
    listModels: async () => [{ id: "gpt-test", name: "Test" }],
  });
  const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
  const models = new ModelCacheService(new ModelCacheRepo(runtime.reader, runtime.writer), providers,
    new ModelSightingsRepo(runtime.reader, runtime.writer));
  disposables.push(() => models.close());
  const targets = new DelegationTargetResolver(providers, models, settings);
  const approvals = new ThreadControlApprovalRepo(runtime.reader, runtime.writer);
  const canonical = new CanonicalAgentBoundary(runtime.reader, runtime.writer, new CanonicalAgentWriterClient(runtime.writer), notifyCommittedCanonicalEvents);
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
    const turn = canonical.loadLatestTurn(threadId);
    if (turn?.status === "Running" && turn.executionId) {
      await canonical.finishParentTurnBatched({
        threadId, turnId: turn.id, executionId: turn.executionId, providerId: "codex", providerIdentities: [],
        outcome: "interrupted", projection: { message: null, narrative: [] },
      });
    }
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
  const coordinator = coordinatorMode === "worktree"
    ? await threadService.create(workspace.id, "Coordinator", "worktree", "main", { provider: "codex", branchless: true })
    : await threads.create(workspace.id, "Coordinator", "direct", "main", false, "codex");
  const source: InternalThreadControlAuthority = { type: "internal", userId: "local-user", sourceThreadId: coordinator.id,
    sourceTurnId: NodeCrypto.randomUUID(), sourceToolCallId: "delegate-call", sourceProviderId: "codex", permissionMode };
  const input = { clientRequestId: "review-1", title: "Review", prompt: "Find bugs", providerId: "codex", modelId: "gpt-test", isolation: "worktree" as const };
  const narrative = new NarrativeStore(messages, new ToolCallRecordRepo(runtime.reader, runtime.writer),
    new ThoughtSegmentRepo(runtime.reader, runtime.writer), new HookExecutionRepo(runtime.reader, runtime.writer), runtime.reader);
  const roster = new SubagentRosterService(canonical, providers, narrative, runtime.reader);
  disposables.push(roster.bindDelegatedTasks(service));
  disposables.push(startups.subscribe((startup) => service.taskChanged(startup.startupId)));
  disposables.push(roster.observeCommittedEvents());
  return { ...fixture, service, tasks, threads, threadService, roster, startups, approvals, control, canonical, messages, environment, coordinator, source, input, dispatch };
}

function requireTask(result: DelegateTaskResult): Exclude<DelegateTaskResult, { status: "rejected" }>;
function requireTask(result: TaskStatusResult): Exclude<TaskStatusResult, { status: "rejected" }>;
function requireTask(result: DelegateTaskResult | TaskStatusResult) {
  if ("status" in result) throw new Error(`Task was rejected: ${result.error.code}: ${result.error.message}`);
  return result;
}

describe("delegated task lifecycle", { timeout: 30_000 }, () => {
  it("includes Coordinators while launching and running, and excludes completed tasks", async () => {
    const f = await harness();
    const launching: string[][] = [];
    disposables.push(f.service.onRosterChanged(() => {
      const task = f.tasks.listByCoordinator(f.coordinator.id)[0];
      if (task && !f.startups.get(task.taskId) && !f.canonical.loadTurn(task.taskId)) {
        launching.push([...f.service.coordinatorsWithUnfinishedTasks(f.coordinator.id)]);
      }
    }));
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    expect(launching).toEqual([[], [f.coordinator.id]]);
    expect([...f.service.coordinatorsWithUnfinishedTasks()]).toEqual([f.coordinator.id]);
    expect([...f.service.coordinatorsWithUnfinishedTasks("another-coordinator")]).toEqual([]);
    const turn = f.canonical.loadTurn(task.taskId);
    if (!task.threadId || !turn?.executionId) throw new Error("Expected admitted task turn");
    await f.canonical.finishParentTurnBatched({
      threadId: task.threadId, turnId: task.taskId, executionId: turn.executionId, providerId: "codex",
      providerIdentities: [], outcome: "completed", projection: { message: null, narrative: [] },
    });
    expect([...f.service.coordinatorsWithUnfinishedTasks()]).toEqual([]);
  });

  it("notifies the roster when launching starts before a supervised approval is committed", async () => {
    const f = await harness("supervised");
    const preparing: string[] = [];
    disposables.push(f.service.onRosterChanged(() => {
      const task = f.tasks.listByCoordinator(f.coordinator.id)[0];
      if (task && !f.approvals.status(task.taskId)) {
        preparing.push(...f.service.rosterEntries(f.coordinator.id).map((entry) => entry.status));
      }
    }));
    await f.service.delegate(f.source, f.input);
    expect(preparing).toEqual(["failed", "running"]);
    expect([...f.service.coordinatorsWithUnfinishedTasks()]).toEqual([f.coordinator.id]);
  });

  it("notifies the delegated roster once for a committed settled turn and ignores non-settled events", async () => {
    const f = await harness();
    const changed: string[] = [];
    disposables.push(notifyTasksOnSettledTurns({ taskChanged: (taskId) => {
      changed.push(taskId);
      f.service.taskChanged(taskId);
    } }, subscribeCommittedCanonicalEvents));
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    expect(changed).toEqual([]);
    const statuses: string[][] = [];
    disposables.push(f.service.onRosterChanged(() => {
      statuses.push(f.service.rosterEntries(f.coordinator.id).map((entry) => entry.status));
    }));
    const turn = f.canonical.loadTurn(task.taskId);
    if (!task.threadId || !turn?.executionId) throw new Error("Expected admitted task turn");
    await f.canonical.finishParentTurnBatched({
      threadId: task.threadId, turnId: task.taskId, executionId: turn.executionId, providerId: "codex",
      providerIdentities: [], outcome: "completed", projection: { message: null, narrative: [] },
    });
    expect(changed).toEqual([task.taskId]);
    expect(statuses).toEqual([["done"]]);
  });

  it("pins HEAD and replays the same hidden child on a retried request", async () => {
    const f = await harness();
    const first = requireTask(await f.service.delegate(f.source, f.input));
    git(f.repoPath, "commit", "--allow-empty", "-m", "Moved HEAD");
    const retry = requireTask(await f.service.delegate(f.source, f.input));
    expect(retry.taskId).toBe(first.taskId);
    expect(retry.threadId).toBe(first.threadId);
    expect(f.threads.listByWorkspace(f.workspace.id).map((thread) => thread.id)).toEqual([f.coordinator.id]);
    const thread = f.threads.findById(first.threadId ?? "");
    expect(git(thread?.worktree_path ?? "", "rev-parse", "HEAD")).toBe(f.localSha);
  });

  it.each([
    ["direct", "shared"], ["direct", "worktree"], ["worktree", "shared"],
  ] as const)("inserts lineage before binding a %s coordinator's %s child", async (coordinatorMode, isolation) => {
    const f = await harness("full", false, coordinatorMode);
    f.runtime.database.exec(`CREATE TRIGGER require_delegated_lineage BEFORE INSERT ON threads
      WHEN NEW.title = 'Review' AND NEW.delegation_coordinator_thread_id IS NULL
      BEGIN SELECT RAISE(ABORT, 'delegated child must be hidden at insertion'); END`);
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation }));
    expect(f.threads.listByWorkspace(f.workspace.id).map((thread) => thread.id)).toEqual([f.coordinator.id]);
    expect(f.threads.findById(task.threadId ?? "")?.delegation_coordinator_thread_id).toBe(f.coordinator.id);
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
    expect(f.roster.loadRoster({ owningParentThreadId: f.coordinator.id }).entries.map((entry) =>
      [entry.tier, entry.childThreadId, entry.status])).toEqual([["meta", null, "running"]]);
    expect(f.startups.get(task.taskId)).toBeNull();
    expect(f.threads.listByWorkspace(f.workspace.id)).toHaveLength(1);
    expect(f.control.listPendingApprovals(f.coordinator.id)[0]?.subject).toMatchObject({ kind: "delegate_task", taskId: task.taskId, commit: f.localSha.slice(0, 12) });
    expect(await f.control.respondToApproval(task.taskId, { choiceId: "allow" })).toEqual({ status: "resolved" });
    expect(await f.control.respondToApproval(task.taskId, { choiceId: "allow" })).toEqual({ status: "not_pending" });
    expect(f.threads.listByWorkspace(f.workspace.id)).toHaveLength(1);
    await vi.waitFor(async () => expect(requireTask(await f.service.status(f.source, { taskId: task.taskId })).state)
      .toEqual({ status: "working", phase: "running" }));
  });

  it("denies without creating a child and recovers a processing approval idempotently", async () => {
    const f = await harness("supervised");
    const denied = requireTask(await f.service.delegate(f.source, f.input));
    await f.control.respondToApproval(denied.taskId, { choiceId: "deny" });
    expect(requireTask(await f.service.status(f.source, { taskId: denied.taskId })).state).toEqual({ status: "finished", outcome: "denied" });
    expect(f.roster.loadRoster({ owningParentThreadId: f.coordinator.id }).entries.map((entry) => entry.status)).toEqual(["stopped"]);
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
    expect(f.threads.listByWorkspace(f.workspace.id)).toHaveLength(1);
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
    expect(await f.service.stopForUser(f.coordinator.id, task.threadId)).toBe(true);
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

  it.each([
    ["completed", "done"], ["errored", "failed"], ["cancelled", "stopped"], ["interrupted", "stopped"],
  ] as const)("projects a running delegated transcript and its %s outcome", async (outcome, expected) => {
    const f = await harness();
    await f.threads.updateProvider(f.coordinator.id, "claude");
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    const turn = f.canonical.loadTurn(task.taskId);
    if (!task.threadId || !turn?.executionId) throw new Error("Expected admitted task turn");
    const request = { owningParentThreadId: f.coordinator.id };
    expect(f.roster.loadRoster(request).entries).toEqual([{
      id: `task:${task.taskId}`, provider: "codex", model: "gpt-test", title: "Review", prompt: "Find bugs",
      subagentType: null, reasoningEffort: null, stepCount: 0, status: "running",
      startedAt: new Date(f.tasks.get(task.taskId)?.createdAt ?? 0).toISOString(), endedAt: null,
      tier: "transcript", canStop: true, childThreadId: task.threadId,
      sourceToolCallId: null, sourceMessageId: null, parentEntryId: null,
    }]);
    const before = f.roster.loadRoster(request).revision;
    await f.canonical.finishParentTurnBatched({
      threadId: task.threadId, turnId: task.taskId, executionId: turn.executionId, providerId: "codex",
      providerIdentities: [], outcome, projection: { message: null, narrative: [] },
    });
    expect(f.roster.loadRoster(request).entries.map((entry) => [entry.status, entry.canStop]))
      .toEqual([[expected, false]]);
    expect(f.roster.loadRoster(request).revision).toBeGreaterThan(before);
  });

  it("resolves the earliest delegate call by creator turn and request key", async () => {
    const f = await harness();
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    const executionId = NodeCrypto.randomUUID();
    await f.canonical.startParentTurn({
      thread: { id: f.coordinator.id, workspaceId: f.workspace.id, providerId: "codex", createdAt: new Date().toISOString() },
      turnId: f.source.sourceTurnId, executionId, permissionMode: "full", providerIdentities: [],
      userMessage: { kind: "create", messageId: NodeCrypto.randomUUID(), content: "Review", sequence: 1 },
    });
    const message = await f.messages.create(f.coordinator.id, "assistant", "Delegating", 2);
    const record = new ToolCallRecordStore(f.runtime.database).create({
      toolCallId: "narrative-call", messageId: message.id, toolName: "mcp:mcode/delegate_task",
      inputSummary: "A bounded display summary", outputSummary: "", status: "running", sortOrder: 0,
    });
    await f.canonical.recordParentNarrativeRecovery({ executionId, items: [{ kind: "toolCall", record }] });
    for (const [index, toolCallId, toolName, clientRequestId] of [
      [1, "unrelated-call", "delegate_task", "other-request"],
      [2, "wrong-tool", "mcp__other__delegate_task", f.input.clientRequestId],
      [3, "narrative-call", "mcp:mcode/delegate_task", f.input.clientRequestId],
      [4, "retried-call", "mcp__mcode__delegate_task", f.input.clientRequestId],
    ] as const) {
      await f.canonical.commit({ threadId: f.coordinator.id, turnId: f.source.sourceTurnId, executionId,
        phase: `call-${index}`, events: [{ eventId: `call-${index}`, routing: { threadId: f.coordinator.id, turnId: f.source.sourceTurnId, executionId },
          sourceProviderId: "codex", sourceIdentities: [], payload: { type: "publication.recorded", publicationId: String(index),
            event: { type: "toolUse", threadId: f.coordinator.id, toolCallId, toolName,
              toolInput: { prompt: "x".repeat(1_000), clientRequestId } } } }] });
    }
    const entries = f.roster.loadRoster({ owningParentThreadId: f.coordinator.id }).entries;
    expect(entries.map((entry) => [entry.id, entry.sourceToolCallId, entry.sourceMessageId]))
      .toEqual([[`task:${task.taskId}`, "narrative-call", message.id]]);
  });

  it("stops a supervised running child through the user roster without approval", async () => {
    const f = await harness("supervised");
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    if (!task.threadId) throw new Error("Expected bound child");
    expect(await f.service.stopForUser("another-coordinator", task.threadId)).toBe(false);
    expect(f.canonical.loadTurn(task.taskId)?.status).toBe("Running");
    expect(await f.roster.stop({ owningParentThreadId: f.coordinator.id, childThreadId: task.threadId }))
      .toEqual({ childThreadId: task.threadId, status: "interrupted" });
    expect(f.canonical.loadTurn(task.taskId)?.status).toBe("Interrupted");
    expect(f.approvals.listPending()).toEqual([]);
    expect(await f.roster.stop({ owningParentThreadId: f.coordinator.id, childThreadId: task.threadId }))
      .toEqual({ childThreadId: task.threadId, status: "already-terminal" });
  });

  it("deletes inactive delegated children and promotes active children on coordinator deletion", async () => {
    const f = await harness();
    const active = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    const inactive = requireTask(await f.service.delegate(f.source, { ...f.input, clientRequestId: "finished-child", isolation: "shared" }));
    if (!active.threadId || !inactive.threadId) throw new Error("Expected bound children");
    const finished = f.canonical.loadTurn(inactive.taskId);
    if (!finished?.executionId) throw new Error("Expected admitted task turn");
    await f.canonical.finishParentTurnBatched({
      threadId: inactive.threadId, turnId: inactive.taskId, executionId: finished.executionId,
      providerId: "codex", providerIdentities: [], outcome: "completed", projection: { message: null, narrative: [] },
    });
    expect(await f.threadService.delete(f.coordinator.id, false)).toBe(true);
    expect(f.threads.findById(inactive.threadId)).toBeNull();
    expect(f.threads.listByWorkspace(f.workspace.id).map((thread) => thread.id)).toEqual([active.threadId]);
    expect(f.canonical.loadTurn(active.taskId)?.status).toBe("Running");
    const promoted = vi.mocked(broadcast).mock.calls.filter(([channel]) => channel === "thread.lifecycleChanged")
      .map(([, payload]) => WS_CHANNELS["thread.lifecycleChanged"].parse(payload).thread)
      .find((thread) => thread.id === active.threadId && thread.delegation_coordinator_thread_id === null);
    expect(promoted?.id).toBe(active.threadId);
    expect(f.tasks.listByCoordinator(f.coordinator.id)).toEqual([]);
  });

  it("keeps native children on the native stop path when there is no delegated receipt", async () => {
    const f = await harness();
    const executionId = NodeCrypto.randomUUID();
    await f.canonical.startParentTurn({
      thread: { id: f.coordinator.id, workspaceId: f.workspace.id, providerId: "codex", createdAt: new Date().toISOString() },
      turnId: f.source.sourceTurnId, executionId, permissionMode: "full", providerIdentities: [],
      userMessage: { kind: "create", messageId: NodeCrypto.randomUUID(), content: "Start native child", sequence: 1 },
    });
    const child = await f.canonical.startCodexChildDelegation({
      parentThreadId: f.coordinator.id, parentTurnId: f.source.sourceTurnId, parentExecutionId: executionId,
      parentItemId: "toolCall:native", receiverThreadIds: ["native-child"], providerIdentities: [],
    });
    const turn = await f.canonical.startCodexChildTurn({
      parentThreadId: f.coordinator.id, parentTurnId: f.source.sourceTurnId, parentExecutionId: executionId,
      parentItemId: "toolCall:native", nativeThreadId: "native-child", nativeTurnId: "native-turn",
    });
    expect(await f.roster.stop({ owningParentThreadId: f.coordinator.id, childThreadId: child.childThread.id }))
      .toEqual({ childThreadId: child.childThread.id, status: "interrupted" });
    expect(f.canonical.loadTurn(turn.id)?.status).toBe("Interrupted");
    expect(f.tasks.listByCoordinator(f.coordinator.id)).toEqual([]);
  });
});
