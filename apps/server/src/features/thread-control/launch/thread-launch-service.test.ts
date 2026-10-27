import "reflect-metadata";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAgentProvider, IProviderRegistry } from "@mcode/contracts/providers/interfaces";
import type { ThreadLaunchResult } from "@mcode/contracts/thread-control";
import type { InternalThreadControlAuthority } from "@mcode/thread-orchestration";
import { createOriginFixture, git } from "../../projects/git/__tests__/start-from-origin-fixture.js";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { ThreadService } from "../lifecycle/thread-service.js";
import { MessageRepo } from "../../agents/conversation/persistence/message-repo.js";
import { ThreadStartupService } from "../../thread-startup/thread-startup-service.js";
import { ThreadStartupRepo } from "../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadStartupFetchDecisions } from "../../thread-startup/thread-startup-fetch-decisions.js";
import { SettingsService } from "../../settings/settings-service.js";
import { ModelCacheService } from "../../providers/models/model-cache-service.js";
import { ModelCacheRepo } from "../../providers/models/persistence/model-cache-repo.js";
import { ModelSightingsRepo } from "../../providers/status/model-sightings-repo.js";
import { DelegationTargetResolver } from "../../agents/collaboration/delegation-target-resolver.js";
import { CanonicalAgentBoundary } from "../../agents/canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../agents/canonical/canonical-agent-writer-client.js";
import { notifyCommittedCanonicalEvents } from "../../agents/canonical/committed-canonical-events.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../../agents/orchestration/agent-turn-command-port.js";
import { PlanTurnService } from "../../agents/planning/plan-turn-service.js";
import { PlanQuestionService } from "../../agents/planning/plan-question-service.js";
import { PlanRepo } from "../../agents/planning/persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../../agents/planning/persistence/plan-question-answers-repo.js";
import { startupEnvironmentFixture } from "../../projects/environment/testing/startup-environment-fixture.js";
import { TurnAdmissionDispatchCoordinator, type TurnRuntimeAdmissionAuthority } from "../../agents/turns/turn-admission-dispatch-coordinator.js";
import { ThreadCreationCoordinator } from "../../agents/turns/thread-creation-coordinator.js";
import { TurnRevertStore } from "../../agents/turns/persistence/turn-revert-store.js";
import { ProviderAvailabilityService } from "../../providers/availability/provider-availability-service.js";
import { GoalLifecycleService } from "../../agents/goals/goal-lifecycle-service.js";
import { FileService } from "../../projects/files/file-service.js";
import { ProjectWorktreeService } from "../../projects/worktrees/project-worktree-service.js";
import { SandboxWorktreeCleanupPolicy } from "../../projects/worktrees/sandbox-worktree-cleanup-policy.js";
import { WorktreeSafetyService } from "../../projects/git/worktree-safety-service.js";
import { HandoffStorage } from "../../handoff/index.js";
import type { TerminalCommandCompletion } from "../../terminal/commands/terminal-command-service.js";
import { ThreadLaunchService } from "./thread-launch-service.js";

// No catalog model declares Fast, so these turns never carry `fastMode`.
const noModels = { listModels: async () => [] };

vi.mock("../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));
const disposables: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of disposables.splice(0)) await dispose();
  vi.restoreAllMocks();
});

async function harness(coordinatorMode: "direct" | "worktree" = "direct", setup = false) {
  const fixture = await createOriginFixture();
  const { runtime, workspace, workspaces, repository, worktrees, executor, host } = fixture;
  const threads = new ThreadRepo(runtime.reader, runtime.writer);
  const messages = new MessageRepo(runtime.reader, runtime.writer);
  const startups = new ThreadStartupService(new ThreadStartupRepo(runtime.reader, runtime.writer), runtime.writer);
  const settings = new SettingsService();
  disposables.push(() => settings.dispose());
  const sendTurn = vi.fn<IAgentProvider["sendTurn"]>(async () => {});
  const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
    id: "codex" as const, descriptor: { id: "codex" as const, capabilities: [] }, subagentReporting: null,
    supportsCompletion: false, sessionForkOnResume: "unsupported" as const, maxInputCharactersPerTurn: 100_000,
    forker: { fork: async () => { throw new Error("Launch starts a new session"); } },
    sendTurn, stopSession: () => {}, shutdown: () => {},
    listModels: async () => [{ id: "gpt-test", name: "Test" }],
  });
  const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
  const models = new ModelCacheService(new ModelCacheRepo(runtime.reader, runtime.writer), providers,
    new ModelSightingsRepo(runtime.reader, runtime.writer));
  disposables.push(() => models.close());
  const targets = new DelegationTargetResolver(providers, models, settings);
  const canonical = new CanonicalAgentBoundary(runtime.reader, runtime.writer, new CanonicalAgentWriterClient(runtime.writer), notifyCommittedCanonicalEvents);
  const attachments = new AttachmentService();
  const commands = new AgentRuntimeCommandPort();
  const plans = new PlanTurnService(threads, providers, new PlanQuestionService(messages, new PlanQuestionAnswersRepo(runtime.reader, runtime.writer)),
    new PlanRepo(runtime.reader, runtime.writer), new AgentTurnCommandPort(commands));
  let finishSetup: (result: TerminalCommandCompletion) => void = () => { throw new Error("Setup not prepared"); };
  const completion = new Promise<TerminalCommandCompletion>((resolve) => { finishSetup = resolve; });
  const environment = startupEnvironmentFixture({
    mcodeDir: fixture.root, database: runtime.reader, databaseWriter: runtime.writer, threads, workspaces,
    threadStartups: startups, platform: "windows",
    terminalCommands: { prepare: async () => ({ kind: "ready", command: {
      snapshot: { checkoutPath: fixture.repoPath, terminal: { executable: "sh", arguments: [] } },
      start: () => completion, close: async () => ({ kind: "contained" }), waitForRelease: () => new Promise(() => {}),
    } }) },
  });
  disposables.push(() => environment.dispose());
  if (setup) await environment.save({ workspaceId: workspace.id, sourceRevision: null,
    document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { default: "setup" }, runOnStartup: true }] } });
  const admission = new TurnAdmissionDispatchCoordinator(threads, workspaces, messages, new TurnRevertStore(runtime.reader), worktrees,
    attachments, providers, new ProviderAvailabilityService(settings, providers), canonical, settings, plans,
    new GoalLifecycleService(threads, providers, runtime.writer, commands, canonical), environment,
    new FileService(workspaces, threads, worktrees, executor, host), host.platform, noModels,
    { start: async ({ parentTurn }) => { await canonical.startParentTurn(parentTurn); } });
  const projects = new ProjectWorktreeService(threads, workspaces, runtime.writer, worktrees,
    new SandboxWorktreeCleanupPolicy(new WorktreeSafetyService(executor, host), repository, host));
  const threadService = new ThreadService(threads, projects, attachments, new HandoffStorage(), {
    teardownThread: async () => {}, deletePersistentData: async (_ids, remove) => remove(),
  });
  const creation = new ThreadCreationCoordinator(threads, () => threadService, admission, repository, workspaces,
    new ThreadStartupFetchDecisions(), undefined, undefined, () => startups);
  const authority: TurnRuntimeAdmissionAuthority = {
    reserve: (command) => ({ threadId: command.threadId, turnExecutionId: NodeCrypto.randomUUID(), mutationReservationToken: NodeCrypto.randomUUID(), generation: 1 }),
    activate: () => {}, abort: async () => {}, release: () => {}, owns: () => true,
  };
  const dispatch = async (command: Parameters<typeof admission.admit>[0]) => {
    const admitted = await admission.admit(command, authority);
    if (admitted.kind === "dispatch") await admitted.provider.sendTurn(admitted.request);
  };
  environment.setAutomaticSetupDispatcher({ dispatch: async (submission) => {
    await dispatch(admission.queuedCommand(submission));
    return { completion: Promise.resolve() };
  } });
  const service = new ThreadLaunchService({ threads, workspaces, targets, repository,
    commands: { createAndSend: async (command, options) => {
      const created = await creation.createInitialTurn(command, options);
      if (created.kind === "dispatch") await dispatch(created.command);
      return created.thread;
    } },
  });
  const coordinator = coordinatorMode === "worktree"
    ? await threadService.create(workspace.id, "Coordinator", "worktree", "main", { provider: "codex", branchless: true })
    : await threads.create(workspace.id, "Coordinator", "direct", "main", false, "codex");
  await threads.updateModel(coordinator.id, "gpt-test");
  const source: InternalThreadControlAuthority = { type: "internal", userId: "local-user", sourceThreadId: coordinator.id,
    sourceTurnId: NodeCrypto.randomUUID(), sourceToolCallId: "launch-call", sourceProviderId: "codex", permissionMode: "full" };
  return { ...fixture, threads, service, threadService, environment, canonical, messages, coordinator, source, sendTurn, finishSetup };
}

function requireLaunch(result: ThreadLaunchResult) {
  if (result.status === "rejected") throw new Error(`Launch rejected: ${result.error.code}: ${result.error.message}`);
  return result;
}

const input = { title: "Independent work", prompt: "Implement the requested work" };

describe("thread launch", { timeout: 30_000 }, () => {
  it("starts at the local branch and dispatches the first turn only after setup completes", async () => {
    const f = await harness("direct", true);
    const launched = requireLaunch(await f.service.launch(f.source, { ...input,
      workspace: { type: "new_worktree", baseRef: "main", startFromOrigin: false } }));
    const thread = f.threads.findById(launched.threadId);
    expect(git(thread?.worktree_path ?? "", "rev-parse", "HEAD")).toBe(f.localSha);
    await vi.waitFor(() => expect(f.environment.getAutomaticSetup({ threadId: launched.threadId }).attempt?.state).toBe("running"));
    expect(f.canonical.loadLatestTurn(launched.threadId)).toBeNull();
    expect(f.sendTurn).not.toHaveBeenCalled();
    f.finishSetup({ kind: "exited", exitCode: 0, output: "Ready", outputTruncated: false });
    await vi.waitFor(() => expect(f.canonical.loadLatestTurn(launched.threadId)?.status).toBe("Running"));
    await vi.waitFor(() => expect(f.sendTurn).toHaveBeenCalledTimes(1));
    expect(f.messages.listByThreadForThreadControl(launched.threadId, 10).messages.find((message) => message.role === "user"))
      .toMatchObject({ content: input.prompt, originType: "thread", sourceThreadId: f.coordinator.id,
        sourceTurnId: f.source.sourceTurnId, sourceProviderId: "codex" });
  });

  it("starts at fetched origin instead of the differing local branch", async () => {
    const f = await harness();
    const launched = requireLaunch(await f.service.launch(f.source, { ...input,
      workspace: { type: "new_worktree", baseRef: "main", startFromOrigin: true } }));
    const thread = f.threads.findById(launched.threadId);
    expect(git(thread?.worktree_path ?? "", "rev-parse", "HEAD")).toBe(f.originSha);
    expect(git(thread?.worktree_path ?? "", "rev-parse", "HEAD")).not.toBe(f.localSha);
  });

  it("rejects a branch missing on origin as a non-retryable placement without inserting a thread", async () => {
    const f = await harness();
    expect(await f.service.launch(f.source, { ...input,
      workspace: { type: "new_worktree", baseRef: "missing", startFromOrigin: true } }))
      .toMatchObject({ status: "rejected", error: { code: "invalid_placement", retryable: false } });
    expect(f.runtime.database.query("SELECT id FROM threads").all()).toEqual([{ id: f.coordinator.id }]);
  });

  it("rejects an unknown local branch without inserting a thread", async () => {
    const f = await harness();
    expect(await f.service.launch(f.source, { ...input,
      workspace: { type: "new_worktree", baseRef: "missing", startFromOrigin: false } }))
      .toMatchObject({ status: "rejected", error: { code: "invalid_placement", retryable: false } });
    expect(f.runtime.database.query("SELECT id FROM threads").all()).toEqual([{ id: f.coordinator.id }]);
  });

  it("attaches a registered worktree", async () => {
    const f = await harness("worktree");
    const path = f.coordinator.worktree_path;
    if (!path) throw new Error("Expected coordinator worktree");
    const launched = requireLaunch(await f.service.launch(f.source, { ...input,
      workspace: { type: "existing_worktree", worktreePath: path, baseBranch: "main" } }));
    expect(NodePath.resolve(f.threads.findById(launched.threadId)?.worktree_path ?? "")).toBe(NodePath.resolve(path));
  });

  it.each(["arbitrary directory", "repository root"])("rejects %s as an existing worktree without inserting a thread", async (placement) => {
    const f = await harness();
    const path = placement === "repository root" ? f.repoPath : f.root;
    expect(await f.service.launch(f.source, { ...input, workspace: { type: "existing_worktree", worktreePath: path } }))
      .toMatchObject({ status: "rejected", error: { code: "invalid_placement", retryable: false } });
    expect(f.runtime.database.query("SELECT id FROM threads").all()).toEqual([{ id: f.coordinator.id }]);
  });

  it("rejects broader modes and inherits supervised and plan when omitted", async () => {
    const f = await harness();
    const source = { ...f.source, permissionMode: "supervised" as const };
    await f.threads.updateSettings(f.coordinator.id, { permission_mode: "supervised", interaction_mode: "plan" });
    expect(await f.service.launch(source, { ...input, permissionMode: "full" }))
      .toMatchObject({ status: "rejected", error: { code: "forbidden", retryable: false } });
    expect(await f.service.launch(source, { ...input, interactionMode: "build" }))
      .toMatchObject({ status: "rejected", error: { code: "forbidden", retryable: false } });
    expect(await f.service.launch(source, { ...input, workspace: { type: "new_worktree", baseRef: "main" } }))
      .toMatchObject({ status: "rejected", error: { code: "forbidden", retryable: false } });
    expect(f.threads.listByWorkspace(f.workspace.id).map((thread) => thread.id)).toEqual([f.coordinator.id]);
    const launched = requireLaunch(await f.service.launch(source, input));
    expect(f.threads.findById(launched.threadId)).toMatchObject({ permission_mode: "supervised", interaction_mode: "plan" });
  });

  it("defaults to the project root when the caller runs in a worktree", async () => {
    const f = await harness("worktree");
    const launched = requireLaunch(await f.service.launch(f.source, input));
    expect(f.threads.findById(launched.threadId)).toMatchObject({ mode: "direct", worktree_path: null, branch: "main" });
  });

  it("returns a visible ordinary thread without delegation lineage", async () => {
    const f = await harness();
    const launched = requireLaunch(await f.service.launch(f.source, input));
    expect(f.threads.findById(launched.threadId)).toMatchObject({
      id: launched.threadId, delegation_coordinator_thread_id: null, parent_thread_id: null,
    });
    expect(f.threads.listByWorkspace(f.workspace.id).map((thread) => thread.id)).toContain(launched.threadId);
  });
});
