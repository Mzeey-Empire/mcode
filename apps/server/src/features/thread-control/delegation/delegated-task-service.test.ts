import "reflect-metadata";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";
import { WS_CHANNELS, SystemNoticeMetadataSchema } from "@mcode/contracts";
import type { AgentStopResult, ApprovalRequestEnvelope, DelegateTaskResult, TaskStatusResult, IAgentProvider, IProviderRegistry, TurnSteerOutcome, TurnStopCause } from "@mcode/contracts";
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
import { TurnResumeScheduleStore } from "../../agents/recovery/turn-resume-schedule-store.js";
import { CoordinatorWakeService, type CoordinatorWakeClock } from "./coordinator-wake-service.js";
import { TurnSteerService } from "../../agents/steering/turn-steer-service.js";
import { TurnSteerRepo } from "../../agents/steering/persistence/turn-steer-repo.js";
import type { SteerableTurn, TurnSteerRuntime } from "../../agents/steering/turn-steer-runtime-port.js";
import type { PreparedTurnDispatch, SendMessageCommand } from "../../agents/turns/turn-admission-dispatch-coordinator.js";
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
  const pendingApprovals: ApprovalRequestEnvelope[] = [];
  disposables.push(() => settings.dispose());
  const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
    id: "codex" as const, descriptor: { id: "codex" as const, capabilities: [{ name: "child-cancellation" as const, support: "supported" as const }] }, subagentReporting: null,
    supportsCompletion: false, sessionForkOnResume: "unsupported" as const, maxInputCharactersPerTurn: 100_000,
    forker: { fork: async () => { throw new Error("Delegation starts a new session"); } },
    sendTurn: async () => {}, stopSession: () => {}, shutdown: () => {},
    interruptChildTurn: async () => {},
    listModels: async () => [{ id: "gpt-test", name: "Test" }],
    listPendingApprovals: (threadId?: string) => pendingApprovals.filter((request) => !threadId || request.threadId === threadId),
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
  const resumes = new TurnResumeScheduleStore(runtime.reader, runtime.writer);
  const service = new DelegatedTaskService({ tasks, threads, startups, approvals, canonical, targets, git: worktrees, control, resumes,
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
  return { ...fixture, service, tasks, threads, threadService, roster, startups, approvals, control, canonical, messages, environment,
    coordinator, source, input, dispatch, active, admission, authority, resumes, pendingApprovals };
}

function requireTask(result: DelegateTaskResult): Exclude<DelegateTaskResult, { status: "rejected" }>;
function requireTask(result: TaskStatusResult): Exclude<TaskStatusResult, { status: "rejected" }>;
function requireTask(result: DelegateTaskResult | TaskStatusResult) {
  if ("status" in result) throw new Error(`Task was rejected: ${result.error.code}: ${result.error.message}`);
  return result;
}

type Fixture = Awaited<ReturnType<typeof harness>>;

async function startCoordinator(f: Fixture) {
  const turnId = NodeCrypto.randomUUID();
  await f.canonical.startParentTurn({
    thread: { id: f.coordinator.id, workspaceId: f.workspace.id, providerId: "codex", createdAt: new Date().toISOString() },
    turnId, executionId: NodeCrypto.randomUUID(), permissionMode: "full", providerIdentities: [],
    userMessage: { kind: "create", messageId: NodeCrypto.randomUUID(), content: "Human turn", sequence: 1 },
  });
  f.active.add(f.coordinator.id);
  return turnId;
}

async function finish(f: Fixture, threadId: string, turnId: string, outcome: "completed" | "interrupted" | "cancelled" = "completed",
  stop: TurnStopCause = { by: "user" }, summary = "Review complete") {
  const turn = f.canonical.loadTurn(turnId);
  if (!turn?.executionId) throw new Error("Expected turn");
  const message = outcome === "completed" ? await f.messages.create(threadId, "assistant", summary, 2) : null;
  await f.canonical.finishParentTurnBatched({ threadId, turnId, executionId: turn.executionId, providerId: "codex",
    providerIdentities: [], outcome, projection: { message, narrative: [] },
    ...(outcome === "cancelled" ? { ending: { stop } } : {}),
    ...(outcome === "interrupted" ? { ending: { cause: "app_closed" } } : {}),
  });
  f.active.delete(threadId);
}

async function wakeHarness(f: Fixture) {
  await f.threads.updateSettings(f.coordinator.id, { permission_mode: "full", model: "gpt-test" });
  const timers = new Map<number, { callback: () => Promise<void>; delay: number }>();
  let timerId = 0;
  const clock: CoordinatorWakeClock = {
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => { if (typeof id === "number") timers.delete(id); },
  };
  const steers = new TurnSteerRepo(f.runtime.reader, f.runtime.writer);
  const state: { steerable: boolean; response: TurnSteerOutcome; busyNext: boolean; sends: number;
    directives: PreparedTurnDispatch["threadControl"][]; sendGate: Promise<void> | null } = {
    steerable: true, response: { outcome: "accepted" }, busyNext: false, sends: 0, directives: [], sendGate: null,
  };
  const runningTurn = (threadId: string): SteerableTurn | null => {
    if (!f.active.has(threadId)) return null;
    const turn = f.canonical.loadLatestTurn(threadId);
    if (!turn?.executionId) return null;
    return { turnExecutionId: turn.executionId, workspaceId: f.workspace.id, providerId: "codex",
      steer: state.steerable ? async () => state.response : null };
  };
  const runtime: TurnSteerRuntime = { runningTurn, recordDelivered: async (message) => {
    await f.messages.create(message.threadId, "user", message.content, 3, undefined, undefined, undefined,
      undefined, false, undefined, undefined, undefined, message.messageId, undefined, message.systemNotice ?? undefined);
    await steers.markDelivered(message.messageId);
  } };
  const steer = new TurnSteerService(steers, runtime, new FileService(f.workspaces, f.threads, f.worktrees, f.executor, f.host));
  const sendMessage = async (command: SendMessageCommand) => {
    state.sends += 1;
    if (state.sendGate) await state.sendGate;
    if (state.busyNext) {
      state.busyNext = false;
      await startCoordinator(f);
      throw new Error("busy");
    }
    const result = await f.admission.admit(command, f.authority);
    if (result.kind === "dispatch") {
      f.active.add(command.threadId);
      state.directives.push(result.threadControl);
    }
  };
  const deps = { tasks: f.service, threads: f.threads, canonical: f.canonical, messages: f.messages,
    steers, steer, runtime: { runningTurn, isActive: (id: string) => f.active.has(id), sendMessage } };
  const wake = new CoordinatorWakeService(deps, clock);
  disposables.push(() => wake.dispose());
  const tick = async () => {
    const current = [...timers.entries()];
    for (const [id, timer] of current) { timers.delete(id); await timer.callback(); }
  };
  const messages = () => f.runtime.database.query<{ content: string; system_notice: string }, [string]>(
    "SELECT content, system_notice FROM messages WHERE thread_id = ? AND json_extract(system_notice, '$.kind') = 'delegated-task' ORDER BY rowid",
  ).all(f.coordinator.id);
  return { wake, state, timers, tick, messages, deps, clock, steers, sendMessage };
}

describe("Coordinator task notices", { timeout: 30_000 }, () => {
  it("grants full thread-control on a wake with default permission and preserves saved selections", async () => {
    const f = await harness();
    await f.threads.updateSettings(f.coordinator.id, { permission_mode: "full", model: "gpt-test", reasoning_level: "high" });
    const admitted = await f.admission.admit({ threadId: f.coordinator.id, content: "Review complete.",
      permissionMode: "default", delegationWake: true }, f.authority);
    if (admitted.kind !== "dispatch") throw new Error("Expected wake admission");
    expect(admitted.threadControl).toMatchObject({ permissionMode: "full" });
    expect(f.canonical.loadLatestTurn(f.coordinator.id)?.permissionMode).toBe("full");
    expect(f.threads.findById(f.coordinator.id)).toMatchObject({ model: "gpt-test", reasoning_level: "high", permission_mode: "full" });
  });

  it("bounds summary detail and the whole message while keeping the task_status footer", async () => {
    const f = await harness();
    const w = await wakeHarness(f);
    for (let index = 0; index < 4; index += 1) {
      const task = requireTask(await f.service.delegate(f.source, { ...f.input, clientRequestId: `verbose-${index}`, isolation: "shared" }));
      if (!task.threadId) throw new Error("Expected child");
      await finish(f, task.threadId, task.taskId, "completed", { by: "user" }, "A".repeat(4_000) + "B".repeat(4_000));
    }
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(w.messages()).toHaveLength(1);
    expect(w.messages()[0]?.content.length).toBe(16_000);
    expect(w.messages()[0]?.content).not.toContain("B".repeat(20));
    expect(w.messages()[0]?.content.endsWith("Use task_status for detail.")).toBe(true);
  });

  it("reruns once for task changes during an in-flight admission", async () => {
    const f = await harness();
    const w = await wakeHarness(f);
    const first = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    const second = requireTask(await f.service.delegate(f.source, { ...f.input, clientRequestId: "second", isolation: "shared" }));
    if (!first.threadId || !second.threadId) throw new Error("Expected children");
    await finish(f, first.threadId, first.taskId);
    let release = () => {};
    w.state.sendGate = new Promise<void>((resolve) => { release = resolve; });
    w.wake.nudge(f.coordinator.id);
    const inFlight = w.tick();
    await vi.waitFor(() => expect(w.state.sends).toBe(1));
    await finish(f, second.threadId, second.taskId);
    w.wake.nudge(f.coordinator.id);
    w.wake.nudge(f.coordinator.id);
    expect(w.timers.size).toBe(0);
    release();
    await inFlight;
    expect(w.timers.size).toBe(1);
    await w.tick();
    expect(w.messages()).toHaveLength(2);
    expect(w.state.sends).toBe(1);
    expect(w.timers.size).toBe(0);
  });

  it("reports an interrupted attempt at boot, then reports its completed replacement", async () => {
    const f = await harness();
    const w = await wakeHarness(f);
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    if (!task.threadId) throw new Error("Expected child");
    await finish(f, task.threadId, task.taskId, "interrupted");
    await w.wake.recoverAtStartup();
    await w.tick();
    expect(w.messages().map((row) => SystemNoticeMetadataSchema().parse(JSON.parse(row.system_notice)).delegatedTasks?.[0]?.status)).toEqual(["interrupted"]);
    const original = f.canonical.loadTurn(task.taskId);
    if (!original?.executionId) throw new Error("Expected original execution");
    const attemptId = NodeCrypto.randomUUID();
    await f.canonical.startParentTurn({
      thread: { id: task.threadId, workspaceId: f.workspace.id, providerId: "codex", createdAt: new Date().toISOString() },
      turnId: attemptId, executionId: NodeCrypto.randomUUID(), retryOfExecutionId: original.executionId,
      permissionMode: "full", providerIdentities: [],
      userMessage: { kind: "create", messageId: NodeCrypto.randomUUID(), content: "Resume", sequence: 3 },
    });
    await finish(f, task.threadId, attemptId, "completed", { by: "user" }, "Replacement complete");
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(w.messages().map((row) => SystemNoticeMetadataSchema().parse(JSON.parse(row.system_notice)).delegatedTasks?.[0]?.status)).toEqual(["interrupted", "completed"]);
    expect(w.messages()[1]?.content).toContain("Replacement complete");
    expect(f.tasks.get(task.taskId)?.noticeDelivered).toBe(`finished:completed:${attemptId}`);
  });

  it("holds a usage-limit interruption while its auto-resume is scheduled", async () => {
    const f = await harness();
    const w = await wakeHarness(f);
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    const turn = f.canonical.loadTurn(task.taskId);
    if (!task.threadId || !turn?.executionId) throw new Error("Expected admitted child");
    await f.canonical.finishParentTurnBatched({ threadId: task.threadId, turnId: task.taskId, executionId: turn.executionId,
      providerId: "codex", providerIdentities: [], outcome: "interrupted",
      ending: { cause: "usage_limit", usageLimit: { resetsAt: "2030-01-01T00:00:00.000Z" } },
      projection: { message: null, narrative: [] } });
    await f.resumes.upsert({ threadId: task.threadId, turnId: task.taskId, executionId: turn.executionId,
      runAt: "2030-01-01T00:00:00.000Z", createdAt: new Date().toISOString() });
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(w.messages()).toEqual([]);
    await f.resumes.delete(task.threadId);
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(w.messages()).toHaveLength(1);
    expect(w.messages()[0]?.content).toContain("interrupted");
  });

  it("wakes an idle Coordinator once with summary, attribution, full mode and task tool eligibility", async () => {
    const f = await harness();
    const w = await wakeHarness(f);
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    if (!task.threadId) throw new Error("Expected child");
    await finish(f, task.threadId, task.taskId);
    const before = f.threads.findById(f.coordinator.id);
    w.wake.nudge(f.coordinator.id);
    w.wake.nudge(f.coordinator.id);
    expect([...w.timers.keys()]).toEqual([1]);
    expect([...w.timers.values()].map((timer) => timer.delay)).toEqual([1_000]);
    await w.tick();
    expect(w.messages()).toEqual([{ content: `Review | child ${task.threadId} | completed\nReview complete\n\nUse task_status for detail.`,
      system_notice: JSON.stringify({ kind: "delegated-task", presentation: "timeline", delegatedTasks: [
        { taskId: task.taskId, threadId: task.threadId, title: "Review", providerId: "codex", status: "completed" },
      ] }) }]);
    expect(f.canonical.loadLatestTurn(f.coordinator.id)?.permissionMode).toBe("full");
    expect(w.state.directives).toEqual([expect.objectContaining({ permissionMode: "full" })]);
    expect(f.threads.findById(f.coordinator.id)?.model).toBe(before?.model);
    expect(f.threads.findById(f.coordinator.id)?.permission_mode).toBe("full");
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(w.messages()).toHaveLength(1);
  });

  it.each([true, false])("routes a running Coordinator with steering %s and retries after its turn ends", async (steerable) => {
    const f = await harness();
    const w = await wakeHarness(f);
    w.state.steerable = steerable;
    const coordinatorTurn = await startCoordinator(f);
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    if (!task.threadId) throw new Error("Expected child");
    await finish(f, task.threadId, task.taskId);
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(w.messages()).toHaveLength(steerable ? 1 : 0);
    expect(f.canonical.loadLatestTurn(f.coordinator.id)?.id).toBe(coordinatorTurn);
    expect(w.state.sends).toBe(0);
    await finish(f, f.coordinator.id, coordinatorTurn);
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(w.messages()).toHaveLength(1);
    expect(w.state.sends).toBe(steerable ? 0 : 1);
  });

  it("does not wake for a result already read with task_status", async () => {
    const f = await harness();
    const w = await wakeHarness(f);
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    if (!task.threadId) throw new Error("Expected child");
    await finish(f, task.threadId, task.taskId);
    expect(requireTask(await f.service.status(f.source, { taskId: task.taskId })).state)
      .toEqual({ status: "finished", outcome: "completed", summary: "Review complete" });
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(w.messages()).toEqual([]);
    expect(w.state.sends).toBe(0);
  });

  it.each(["user", "thread_control"])("parks only after %s cancellation, then delivers on the next human turn", async (by) => {
    const f = await harness();
    const w = await wakeHarness(f);
    const coordinatorTurn = await startCoordinator(f);
    await finish(f, f.coordinator.id, coordinatorTurn, "cancelled", by === "user" ? { by: "user" } : { by: "mcode", reason: "thread_control" });
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    if (!task.threadId) throw new Error("Expected child");
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(f.canonical.loadTurn(task.taskId)?.status).toBe("Running");
    await finish(f, task.threadId, task.taskId);
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(w.messages()).toHaveLength(by === "user" ? 0 : 1);
    if (by === "user") {
      await startCoordinator(f);
      w.wake.nudge(f.coordinator.id);
      await w.tick();
      expect(w.messages()).toHaveLength(1);
    }
  });

  it.each([true, false])("recovers a crash with committed message %s without losing or duplicating the result", async (committed) => {
    const f = await harness();
    const w = await wakeHarness(f);
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    if (!task.threadId) throw new Error("Expected child");
    await finish(f, task.threadId, task.taskId, "interrupted");
    const batch = await f.service.claimNotices(f.coordinator.id, NodeCrypto.randomUUID());
    if (!batch) throw new Error("Expected claim");
    if (committed) await w.sendMessage({ threadId: f.coordinator.id, content: batch.content,
      messageId: batch.wakeId, permissionMode: "full", model: "gpt-test", provider: "codex",
      delegationWake: true, systemNotice: batch.systemNotice });
    await w.wake.recoverAtStartup();
    await w.tick();
    expect(w.messages()).toHaveLength(1);
    expect(f.tasks.get(task.taskId)?.noticeClaim).toBeNull();
    await w.wake.recoverAtStartup();
    await w.tick();
    expect(w.messages()).toHaveLength(1);
  });

  it.each(["rejected", "unknown"])("handles a %s steer without replaying its message identity", async (outcome) => {
    const f = await harness();
    const w = await wakeHarness(f);
    const coordinatorTurn = await startCoordinator(f);
    w.state.response = outcome === "rejected" ? { outcome: "rejected", reason: "provider", detail: "No" }
      : { outcome: "unknown", detail: "Lost response" };
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    if (!task.threadId) throw new Error("Expected child");
    await finish(f, task.threadId, task.taskId);
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    const attempts = () => f.runtime.database.query<{ message_id: string; state: string }, []>("SELECT message_id, state FROM turn_steers").all();
    const first = attempts();
    expect(first.map((row) => row.state)).toEqual([outcome === "rejected" ? "rejected" : "delivery_unknown"]);
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(attempts()).toEqual(first);
    await finish(f, f.coordinator.id, coordinatorTurn);
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(w.messages()).toHaveLength(outcome === "rejected" ? 1 : 0);
    if (outcome === "rejected") {
      const row = f.tasks.get(task.taskId);
      expect(row?.noticeDelivered).toBe(`finished:completed:${task.taskId}`);
      expect(w.messages()[0]?.content).toContain("Review complete");
    }
  });

  it("returns a lost admission claim and delivers after the winning turn ends", async () => {
    const f = await harness();
    const w = await wakeHarness(f);
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    if (!task.threadId) throw new Error("Expected child");
    await finish(f, task.threadId, task.taskId);
    w.state.busyNext = true;
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(w.messages()).toEqual([]);
    expect(f.tasks.get(task.taskId)?.noticeClaim).toBeNull();
    const winning = f.canonical.loadLatestTurn(f.coordinator.id);
    if (!winning) throw new Error("Expected winning turn");
    await finish(f, f.coordinator.id, winning.id);
    w.wake.nudge(f.coordinator.id);
    await w.tick();
    expect(w.messages()).toHaveLength(1);
    expect(w.state.sends).toBe(2);
  });
});

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

  it("covers answered questions but delivers a newly pending question", async () => {
    const f = await harness();
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    if (!task.threadId) throw new Error("Expected child");
    const question = (requestId: string, prompt: string): ApprovalRequestEnvelope => ({
      requestId, threadId: task.threadId ?? "", body: {
        requestedAt: new Date().toISOString(), origin: { kind: "agent" },
        subject: { kind: "question", questions: [{ header: "Choose", question: prompt, options: [], multiple: false, custom: true }] },
        choices: [{ id: "answer", intent: "provider", label: "Answer" }],
      },
    });
    f.pendingApprovals.push(question("first", "Which environment?"), question("second", "Which branch?"));
    const first = await f.service.claimNotices(f.coordinator.id, NodeCrypto.randomUUID());
    expect(first?.content).toContain("Which environment?\nWhich branch?");
    expect(first?.content).toContain("The user answers this in the composer. Do not answer it yourself.");
    if (!first) throw new Error("Expected question notice");
    await f.service.settleNotices(first.wakeId);
    f.pendingApprovals.shift();
    expect(await f.service.claimNotices(f.coordinator.id, NodeCrypto.randomUUID())).toBeNull();
    f.pendingApprovals.push(question("third", "Which region?"));
    expect((await f.service.claimNotices(f.coordinator.id, NodeCrypto.randomUUID()))?.content).toContain("Which region?");
  });

  it("backfills finished tasks while leaving in-flight tasks eligible after migration", async () => {
    const f = await harness();
    const finished = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    const running = requireTask(await f.service.delegate(f.source, { ...f.input, clientRequestId: "running", isolation: "shared" }));
    const turn = f.canonical.loadTurn(finished.taskId);
    if (!finished.threadId || !turn?.executionId) throw new Error("Expected admitted child");
    await f.canonical.finishParentTurnBatched({
      threadId: finished.threadId, turnId: finished.taskId, executionId: turn.executionId,
      providerId: "codex", providerIdentities: [], outcome: "completed", projection: { message: null, narrative: [] },
    });
    f.runtime.database.exec("ALTER TABLE delegated_tasks DROP COLUMN notice_delivered; ALTER TABLE delegated_tasks DROP COLUMN notice_claim;");
    f.runtime.database.exec(NodeFS.readFileSync(new URL("../../../../drizzle/0097_parallel_madelyne_pryor.sql", import.meta.url), "utf8"));
    expect(await f.service.claimNotices(f.coordinator.id, NodeCrypto.randomUUID())).toBeNull();
    const active = f.canonical.loadTurn(running.taskId);
    if (!running.threadId || !active?.executionId) throw new Error("Expected running child");
    await f.canonical.finishParentTurnBatched({
      threadId: running.threadId, turnId: running.taskId, executionId: active.executionId,
      providerId: "codex", providerIdentities: [], outcome: "completed", projection: { message: null, narrative: [] },
    });
    const batch = await f.service.claimNotices(f.coordinator.id, NodeCrypto.randomUUID());
    expect(batch?.systemNotice.delegatedTasks?.map((notice) => notice.taskId)).toEqual([running.taskId]);
  });

  it("acknowledges task_status and thread_wait without letting roster reads consume results", async () => {
    const f = await harness();
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    const turn = f.canonical.loadTurn(task.taskId);
    if (!task.threadId || !turn?.executionId) throw new Error("Expected admitted child");
    await f.canonical.finishParentTurnBatched({
      threadId: task.threadId, turnId: task.taskId, executionId: turn.executionId,
      providerId: "codex", providerIdentities: [], outcome: "completed", projection: { message: null, narrative: [] },
    });
    f.service.rosterEntries(f.coordinator.id);
    const batch = await f.service.claimNotices(f.coordinator.id, NodeCrypto.randomUUID());
    expect(batch?.systemNotice.delegatedTasks?.map((notice) => notice.status)).toEqual(["completed"]);
    if (!batch) throw new Error("Expected notice");
    await f.service.returnNotices(batch.wakeId);
    f.active.delete(task.threadId);
    await f.control.threadWait(f.source, { threadIds: [task.threadId], until: "terminal", timeoutSeconds: 1 });
    expect(await f.service.claimNotices(f.coordinator.id, NodeCrypto.randomUUID())).toBeNull();
  });

  it.each(["ack-first", "settle-first"])("preserves an acknowledgement racing a claim in %s order", async (order) => {
    const f = await harness();
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    const turn = f.canonical.loadTurn(task.taskId);
    if (!task.threadId || !turn?.executionId) throw new Error("Expected admitted child");
    await f.canonical.finishParentTurnBatched({
      threadId: task.threadId, turnId: task.taskId, executionId: turn.executionId,
      providerId: "codex", providerIdentities: [], outcome: "completed", projection: { message: null, narrative: [] },
    });
    const batch = await f.service.claimNotices(f.coordinator.id, NodeCrypto.randomUUID());
    expect(batch?.systemNotice.delegatedTasks?.map((notice) => notice.status)).toEqual(["completed"]);
    if (!batch) throw new Error("Expected notice");
    if (order === "ack-first") await f.service.status(f.source, { taskId: task.taskId });
    await f.service.settleNotices(batch.wakeId);
    if (order === "settle-first") await f.service.status(f.source, { taskId: task.taskId });
    expect(await f.service.claimNotices(f.coordinator.id, NodeCrypto.randomUUID())).toBeNull();
  });

  it("reports and stops the latest resumed attempt on the bound child", async () => {
    const f = await harness();
    const task = requireTask(await f.service.delegate(f.source, { ...f.input, isolation: "shared" }));
    const original = f.canonical.loadTurn(task.taskId);
    if (!task.threadId || !original?.executionId) throw new Error("Expected admitted child");
    await f.canonical.finishParentTurnBatched({
      threadId: task.threadId, turnId: task.taskId, executionId: original.executionId,
      providerId: "codex", providerIdentities: [], outcome: "interrupted", projection: { message: null, narrative: [] },
    });
    const attemptId = NodeCrypto.randomUUID();
    await f.canonical.startParentTurn({
      thread: { id: task.threadId, workspaceId: f.workspace.id, providerId: "codex", createdAt: new Date().toISOString() },
      turnId: attemptId, executionId: NodeCrypto.randomUUID(), retryOfExecutionId: original.executionId,
      permissionMode: "full", providerIdentities: [],
      userMessage: { kind: "create", messageId: NodeCrypto.randomUUID(), content: "Continue", sequence: 2 },
    });
    expect(requireTask(await f.service.status(f.source, { taskId: task.taskId })).state)
      .toEqual({ status: "working", phase: "running" });
    expect(await f.service.stopForUser(f.coordinator.id, task.threadId)).toBe(true);
    expect(f.canonical.loadTurn(attemptId)?.status).toBe("Interrupted");
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
