import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeChildProcess from "node:child_process";
import { Database } from "bun:sqlite";
import { container } from "tsyringe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventSchema, type AgentEvent, type IAgentProvider, type IProviderRegistry, type PlanImplement, type PlanVersion, type TurnRequest } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { PlanTurnService } from "../../planning/plan-turn-service.js";
import { PlanQuestionService } from "../../planning/plan-question-service.js";
import { setupContainer } from "../../../../application/composition/container.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { WorkerOwnedTurnRuntime } from "../../execution/worker-owned-turn-runtime.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { SnapshotRefPins } from "../../../projects/diffs/snapshots/snapshot-ref-pins.js";
import { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { WorkspaceEnvironmentService } from "../../../projects/environment/workspace-environment-service.js";
import { ThreadCreationCoordinator } from "../../turns/thread-creation-coordinator.js";
import { routeThreadStartupRpc } from "../../../thread-startup/transport/thread-startup-rpc.js";
import { ThreadStartupFetchDecisions } from "../../../thread-startup/thread-startup-fetch-decisions.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { ThreadService } from "../../../thread-control/lifecycle/thread-service.js";
import { ThreadDeletionTeardownService } from "../../../thread-control/lifecycle/thread-deletion-teardown-service.js";
import { CiWatcherService, GithubService } from "../../../pull-requests/index.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";
import { ThreadControlMutationReservationService } from "../../../thread-control/authority/thread-control-mutation-reservation-service.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { PlanRepo } from "../../planning/persistence/plan-repo.js";
import { PlanImplementStore } from "../../planning/persistence/plan-implement-store.js";
import { planImplementWriteOperations } from "../../planning/persistence/plan-implement-write-operations.js";
import { PlanFileWriter } from "../../planning/plan-file-writer.js";
import { PlanService, type PlanImplementRuntime } from "../../planning/plan-service.js";
import { PlanImplementStartupObserver } from "../../planning/plan-implement-startup-observer.js";
import { CleanupWorker } from "../../../thread-control/cleanup/cleanup-worker.js";
import { ScopedPreGrantService } from "../../permissions/scoped-pre-grant.js";
import { AgentService } from "../agent-service.js";
import { AGENT_TURN_COMMAND_PORT } from "../agent-turn-command-port.js";
import { AgentEventPublicationRegistry } from "../agent-event-publication-registry.js";

const pushes = vi.hoisted((): {
  versions: Array<{ threadId: string; version: PlanVersion }>;
  events: Array<{ channel: string; payload: unknown }>;
} => ({ versions: [], events: [] }));
vi.mock("../../../../runtime/process/containment/process-kill.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../runtime/process/containment/process-kill.js")>(),
  killDescendantsByName: async () => undefined,
}));
vi.mock("../../../../application/transport/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../application/transport/push.js")>();
  return { ...actual, broadcast: (...args: Parameters<typeof actual.broadcast>) => {
    if (args[0] === "plan.versionUpserted" || args[0] === "plan.implementPending") {
      pushes.events.push({ channel: args[0], payload: args[1] });
    }
    if (args[0] === "plan.versionUpserted") pushes.versions.push(args[1] as { threadId: string; version: PlanVersion });
    actual.broadcast(...args);
  } };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Plan Implement through production worker-owned admission", { timeout: 30_000 }, () => {
  let directory: string;
  let database: Database;
  let writer: ApplicationDatabaseWriter;
  let workers: WorkerOwnedTurnRuntime;
  let agent: AgentService;
  let plans: PlanRepo;
  let service: PlanService;
  let files: PlanFileWriter;
  let runtime: PlanImplementRuntime;
  let observer: PlanImplementStartupObserver;
  let provider: IAgentProvider;
  let workspaceId: string;
  let threadId: string;
  let ready: PlanVersion;
  let sent: TurnRequest[];
  let atDispatch: Array<{ text: string; status: string | undefined }>;
  const oldDbPath = process.env.MCODE_DB_PATH;
  const oldDataDir = process.env.MCODE_DATA_DIR;

  beforeAll(async () => {
    container.reset();
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-implement-"));
    process.env.MCODE_DB_PATH = NodePath.join(directory, "app.sqlite");
    process.env.MCODE_DATA_DIR = NodePath.join(directory, "data");
    await openServiceSet();
    database = new Database(process.env.MCODE_DB_PATH);
    workspaceId = (await container.resolve(WorkspaceRepo).create("Implement fixture", directory, false)).id;
  });

  async function openServiceSet() {
    await setupContainer(directory);
    writer = container.resolve(ApplicationDatabaseWriter);
    workers = container.resolve(WorkerOwnedTurnRuntime);
    await workers.whenReady();
    provider = Object.assign(new NodeEvents.EventEmitter(), {
      id: "codex" as const, descriptor: { id: "codex" as const, capabilities: [] },
      supportsCompletion: false, sessionForkOnResume: "unsupported" as const, maxInputCharactersPerTurn: 100_000,
      forker: { fork: async () => { throw new Error("No session fork in this fixture"); } },
      sendTurn: async (request: TurnRequest) => {
        sent.push(request);
        atDispatch.push({ text: NodeFS.readFileSync(files.path(threadId), "utf8"), status: plans.getById(ready.id)?.status });
      },
      stopSession: async () => undefined, shutdown: () => undefined, listModels: async () => [],
      setCanonicalTurnEventDeliveryEnabled: () => undefined, setCanonicalTurnDeliveryFailureHandler: () => undefined,
      fenceCanonicalTurnEvents: async () => undefined, retireCanonicalTurnEvents: async () => undefined,
    });
    const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => undefined };
    container.registerInstance("IProviderRegistry", providers);
    vi.spyOn(container.resolve(ProviderAvailabilityService), "assertUsable").mockReturnValue(undefined);
    agent = container.resolve(AgentService);
    container.registerInstance(CiWatcherService, new CiWatcherService(container.resolve(GithubService), () => {}));
    container.resolve(ThreadDeletionTeardownService).bindAcceptedProgress(workers.progress);
    const publications = container.resolve(AgentEventPublicationRegistry);
    publications.bind(() => undefined);
    publications.start();
    plans = container.resolve(PlanRepo);
    files = new PlanFileWriter(id => plans.listByThread(id), () => directory);
    container.resolve(PlanTurnService).bindPlanProjection(workers.progress, files);
    if (workers.progress) container.resolve(PlanQuestionService).bindAcceptedProgress(workers.progress);
    workers.bindPlanPhaseChanged(id => container.resolve(ThreadRepo).publishPlanPhase(id));
    runtime = { threads: container.resolve(ThreadRepo), providers,
      startups: container.resolve(ThreadStartupService), messages: container.resolve(MessageRepo),
      threadService: container.resolve(ThreadService),
      reservations: container.resolve(ThreadControlMutationReservationService),
      commands: container.resolve(AGENT_TURN_COMMAND_PORT), grants: container.resolve(ScopedPreGrantService),
      git: container.resolve(GitWorktreeService) };
    container.resolve(WorkspaceEnvironmentService).setAutomaticSetupDispatcher({
      dispatch: submission => agent.dispatchQueuedAutomaticTurn(submission),
    });
    container.registerInstance("CleanupHandleReleaseDelayMs", 0);
  }

  beforeEach(async () => {
    sent = [];
    atDispatch = [];
    provider.prepareImplement = undefined;
    Object.assign(provider, { fenceCanonicalTurnEvents: async () => undefined });
    threadId = (await container.resolve(ThreadRepo).create(workspaceId, "Plan", "direct", "main", false, "codex")).id;
    await container.resolve(ThreadRepo).updateSettings(threadId, { interaction_mode: "plan", model: "gpt-5.6-luna" });
    const message = await container.resolve(MessageRepo).create(threadId, "assistant", "Plan summary", 1);
    ready = await plans.create(threadId, message.id, { title: "Original", contentMd: "# Original\nExact plan text.", captureSource: "fence" }, "codex");
    await files.write(threadId);
    service = new PlanService(writer, workers.progress, files, runtime);
    observer = new PlanImplementStartupObserver(service, container.resolve(ThreadStartupService));
    observer.start();
  });

  afterEach(async () => {
    database.run("DROP TRIGGER IF EXISTS fail_implement");
    database.run("DROP TRIGGER IF EXISTS fail_admission");
    database.run("DROP TRIGGER IF EXISTS cancel_before_admission");
    await agent.stopSession(threadId, { by: "user" });
    await agent.stopAll();
    await observer.stop();
  });

  afterAll(async () => {
    await container.resolve(SnapshotRefPins).drain();
    await workers.close();
    await writer.close();
    database.close(true);
    container.resolve<Database>("Database").close(true);
    container.reset();
    if (oldDbPath === undefined) delete process.env.MCODE_DB_PATH;
    else process.env.MCODE_DB_PATH = oldDbPath;
    if (oldDataDir === undefined) delete process.env.MCODE_DATA_DIR;
    else process.env.MCODE_DATA_DIR = oldDataDir;
    NodeFS.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function request(version = ready): PlanImplement {
    return { requestId: NodeCrypto.randomUUID(), threadId, versionId: version.id, expectedRevision: version.revision, target: "thread" };
  }

  function git(cwd: string, ...args: string[]): string {
    return NodeChildProcess.execFileSync("git", ["-C", cwd, "-c", "commit.gpgSign=false", "-c", "core.hooksPath=", ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
      env: { ...process.env, GIT_AUTHOR_NAME: "Plan Test", GIT_AUTHOR_EMAIL: "plan@example.invalid",
        GIT_COMMITTER_NAME: "Plan Test", GIT_COMMITTER_EMAIL: "plan@example.invalid" },
    }).trim();
  }

  async function gitSource(setup: boolean, worktreeSource = false) {
    const repo = NodePath.join(directory, NodeCrypto.randomUUID());
    NodeFS.mkdirSync(repo);
    git(repo, "init", "-b", "main");
    git(repo, "config", "core.autocrlf", "false");
    NodeFS.writeFileSync(NodePath.join(repo, "source.txt"), "committed main\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "Base");
    let source = repo;
    if (worktreeSource) {
      source = NodePath.join(directory, NodeCrypto.randomUUID());
      git(repo, "worktree", "add", "-b", "source-feature", source);
    }
    NodeFS.writeFileSync(NodePath.join(source, "source.txt"), "committed source\n");
    git(source, "commit", "-am", "Source tip");
    NodeFS.writeFileSync(NodePath.join(source, "source.txt"), "uncommitted source\n");
    const workspace = await container.resolve(WorkspaceRepo).create("Worktree plans", repo, false);
    database.prepare("UPDATE threads SET workspace_id = ?, mode = ?, branch = ?, worktree_path = ? WHERE id = ?")
      .run(workspace.id, worktreeSource ? "worktree" : "direct", worktreeSource ? "source-feature" : "main",
        worktreeSource ? source : null, threadId);
    if (setup) {
      const environment = container.resolve(WorkspaceEnvironmentService);
      await environment.setStorageMode({ workspaceId: workspace.id, storageMode: "shared" });
      await environment.save({ workspaceId: workspace.id, threadId, sourceRevision: null,
        document: { version: "0.0.1", setup: { windows: "exit 7", linux: "exit 7" }, actions: [] } });
      git(source, "add", ".mcode/environment.json");
      git(source, "commit", "-m", "Shared setup");
    }
    return { repo, source, head: git(source, "rev-parse", "HEAD"), branches: git(repo, "branch", "--list"),
      status: git(source, "status", "--porcelain"), branch: git(source, "branch", "--show-current") };
  }

  async function waitingWorktree() {
    const source = await gitSource(true, true);
    const input: PlanImplement = { ...request(), target: "new-worktree" };
    const receipt = await service.implement(input);
    const target = runtime.threads.findById(receipt.targetThreadId);
    if (!target?.worktree_path) throw new Error("Expected managed checkout");
    const environment = container.resolve(WorkspaceEnvironmentService);
    await expect.poll(() => environment.getAutomaticSetup({ threadId: target.id }).attempt?.state).toBe("awaiting-approval");
    expect((await service.snapshot({ threadId })).pendingImplement).toEqual({ targetThreadId: target.id, version: 1 });
    expect(pushes.events.filter(event => event.channel === "plan.implementPending")).toContainEqual({
      channel: "plan.implementPending", payload: { threadId, pending: { targetThreadId: target.id, version: 1 } },
    });
    return { ...source, input, receipt, target, checkout: target.worktree_path, environment };
  }

  async function expectPendingCleared() {
    expect((await service.snapshot({ threadId })).pendingImplement).toBeNull();
    expect(pushes.events.filter(event => event.channel === "plan.implementPending").at(-1)).toEqual({
      channel: "plan.implementPending", payload: { threadId, pending: null },
    });
  }

  async function cleanTarget(thread: string, checkout: string) {
    await container.resolve(CleanupWorker).poll();
    expect(runtime.threads.findById(thread)).toBeNull();
    expect(NodeFS.existsSync(checkout)).toBe(false);
  }

  it("creates one detached checkout at the direct source commit and preserves dirty files and branches", async () => {
    const source = await gitSource(false);
    const worktrees = container.resolve(GitWorktreeService);
    const entered = deferred();
    const release = deferred();
    const create = worktrees.createWorktree.bind(worktrees);
    const paused = vi.spyOn(worktrees, "createWorktree").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return create(...args);
    });
    const input: PlanImplement = { ...request(), target: "new-worktree" };
    const first = service.implement(input);
    await entered.promise;
    const second = service.implement(input);
    expect(second).toBe(first);
    release.resolve();
    const receipt = await first;
    paused.mockRestore();
    expect(receipt.state).toBe("admitted");
    expect(await second).toEqual(receipt);
    expect(await service.implement(input)).toEqual(receipt);
    const target = runtime.threads.findById(receipt.targetThreadId);
    if (!target?.worktree_path) throw new Error("Expected managed checkout");
    expect(git(target.worktree_path, "rev-parse", "HEAD")).toBe(source.head);
    expect(git(target.worktree_path, "branch", "--show-current")).toBe("");
    expect(NodeFS.readFileSync(NodePath.join(target.worktree_path, "source.txt"), "utf8")).toBe("committed source\n");
    expect(NodeFS.readFileSync(NodePath.join(source.source, "source.txt"), "utf8")).toBe("uncommitted source\n");
    expect(git(source.source, "status", "--porcelain")).toBe(source.status);
    expect(git(source.source, "rev-parse", "HEAD")).toBe(source.head);
    expect(git(source.source, "branch", "--show-current")).toBe(source.branch);
    expect(git(source.repo, "branch", "--list")).toBe(source.branches);
    expect(new PlanImplementStore(database).read(input.requestId)?.sourceCommit).toBe(source.head);
    expect(git(source.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
    await untilDispatched();
    await agent.stopSession(target.id, { by: "user" });
  });

  it("retains the reservation through failed Setup, then Skip admits the original queued Implement exactly once", async () => {
    const { input, receipt, target, checkout, source, head, repo, branches, environment } = await waitingWorktree();
    expect(receipt.state).toBe("waiting-for-setup");
    expect(await service.implement(input)).toEqual(receipt);
    await expect(service.implement({ ...input, target: "new-thread" })).rejects.toMatchObject({ code: "implement_request_conflict" });
    expect(git(checkout, "rev-parse", "HEAD")).toBe(head);
    expect(git(checkout, "branch", "--show-current")).toBe("");
    expect(NodePath.basename(checkout)).toBe(`source-feature-${target.id.slice(0, 8)}`);
    expect(NodeFS.readFileSync(NodePath.join(source, "source.txt"), "utf8")).toBe("uncommitted source\n");
    expect(plans.getById(ready.id)?.status).toBe("ready");
    expect(runtime.messages.hasMessages(target.id)).toBe(false);
    expect(runtime.reservations.get(threadId)?.state).toBe("planImplement");
    await expect(service.saveVersion({ threadId, versionId: NodeCrypto.randomUUID(), baseVersionId: ready.id,
      baseRevision: 0, contentMd: "Blocked edit" })).rejects.toMatchObject({ code: "plan_busy" });
    const queued = environment.getAutomaticSetup({ threadId: target.id });
    const approval = queued.attempt?.snapshot?.approval;
    if (!approval) throw new Error("Expected setup approval");
    await environment.approveCommand({ threadId: target.id, ...approval });
    await expect.poll(() => environment.getAutomaticSetup({ threadId: target.id }).attempt?.state).toBe("failed");
    await environment.continueAutomaticSetup({ threadId: target.id });
    await expect.poll(() => runtime.reservations.get(threadId)).toBeUndefined();
    expect(await service.implement(input)).toEqual({ ...receipt, state: "admitted" });
    expect(plans.getById(ready.id)?.status).toBe("accepted");
    expect(plans.listByThread(target.id)).toMatchObject([{ status: "accepted", contentMd: ready.contentMd,
      captureSource: "copy", baseVersionId: ready.id, acceptedMessageId: receipt.messageId }]);
    expect(database.prepare("SELECT id, content FROM messages WHERE thread_id = ? AND role = 'user'").all(target.id))
      .toEqual([{ id: receipt.messageId, content: "Implement plan v1" }]);
    await untilDispatched();
    expect(sent[0]?.message).toBe(`Implement plan v1: "Original".\n\nThis is the plan the user approved. It supersedes any earlier plan or plan file, including your own. Mcode keeps this text at ${files.path(threadId)}.\n\n# Original\nExact plan text.`);
    expect(pushes.versions.filter(row => row.version.status === "accepted").map(row => row.threadId))
      .toEqual(expect.arrayContaining([threadId, target.id]));
    await observer.stop();
    await expectPendingCleared();
    const clearIndex = pushes.events.findLastIndex(event => event.channel === "plan.implementPending");
    expect(pushes.events.slice(0, clearIndex)).toEqual(expect.arrayContaining([
      { channel: "plan.versionUpserted", payload: { threadId, version: expect.objectContaining({ status: "accepted" }) } },
      { channel: "plan.versionUpserted", payload: { threadId: target.id, version: expect.objectContaining({ status: "accepted" }) } },
    ]));
    expect(git(repo, "branch", "--list")).toBe(branches);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(3);
    await agent.stopSession(target.id, { by: "user" });
  });

  it("settles an admission rejection after Setup dispatch and releases the source", async () => {
    const { input, target, checkout, environment } = await waitingWorktree();
    database.run("CREATE TRIGGER fail_admission BEFORE INSERT ON canonical_agent_turns BEGIN SELECT RAISE(ABORT, 'injected admission failure'); END");
    await environment.continueAutomaticSetup({ threadId: target.id });
    await expect.poll(() => new PlanImplementStore(database).read(input.requestId)?.status).toBe("failed");
    await observer.stop();
    expect(runtime.reservations.get(threadId)).toBeUndefined();
    expect(runtime.messages.hasMessages(target.id)).toBe(false);
    await cleanTarget(target.id, checkout);
    await expect(service.implement(input)).rejects.toMatchObject({ code: "implement_failed" });
    expect(plans.getById(ready.id)?.status).toBe("ready");
    await expectPendingCleared();
  });

  it("Stop during Setup fails and compensates the empty target without creating or removing a branch", async () => {
    const { input, receipt, target, checkout, repo, branches, environment } = await waitingWorktree();
    await routeThreadStartupRpc("thread.startup.cancel", { startupId: input.requestId }, {
      threadStartupService: container.resolve(ThreadStartupService),
      threadStartupFetchDecisions: container.resolve(ThreadStartupFetchDecisions), workspaceEnvironmentService: environment, agentService: agent,
    });
    await expect.poll(() => runtime.reservations.get(threadId)).toBeUndefined();
    await expect(service.implement(input)).rejects.toMatchObject({ code: "startup_cancelled" });
    expect(new PlanImplementStore(database).read(input.requestId)).toMatchObject({ status: "failed", failureCode: "startup_cancelled", messageId: receipt.messageId });
    await observer.stop();
    await cleanTarget(target.id, checkout);
    await expectPendingCleared();
    expect(plans.getById(ready.id)?.status).toBe("ready");
    expect(git(repo, "branch", "--list")).toBe(branches);
  });

  it("recovers a crash while waiting for Setup and removes the abandoned checkout", async () => {
    const { input, target, checkout, repo, branches } = await waitingWorktree();
    await observer.stop();
    await container.resolve(ThreadStartupService).interruptNonterminalOnStartup();
    const restarted = new PlanService(writer, workers.progress, files, { ...runtime, reservations: new ThreadControlMutationReservationService() });
    await restarted.recoverInterrupted();
    await expect(restarted.implement(input)).rejects.toMatchObject({ code: "implement_interrupted" });
    expect(new PlanImplementStore(database).read(input.requestId)).toMatchObject({ status: "failed", failureCode: "interrupted" });
    await cleanTarget(target.id, checkout);
    expect(plans.getById(ready.id)?.status).toBe("ready");
    expect(git(repo, "branch", "--list")).toBe(branches);
  });

  it.each(["failed", "deleted"])("settles a waiting request when its startup is %s", async outcome => {
    const { input, target, checkout } = await waitingWorktree();
    if (outcome === "failed") {
      await container.resolve(ThreadStartupService).fail(input.requestId, {
        code: "startup_failed", message: "Cannot continue", retryable: false,
      });
      await observer.stop();
    } else {
      await runtime.threadService.delete(target.id, true);
    }
    await cleanTarget(target.id, checkout);
    await observer.stop();
    await expect(service.implement(input)).rejects.toMatchObject({ code: "implement_failed" });
    expect(runtime.reservations.get(threadId)).toBeUndefined();
    expect(plans.getById(ready.id)?.status).toBe("ready");
    await expectPendingCleared();
  });

  it("preserves a worktree target that gained a message before cancellation", async () => {
    const { input, target, checkout, environment } = await waitingWorktree();
    await container.resolve(MessageRepo).create(target.id, "user", "Keep this conversation", 1);
    await routeThreadStartupRpc("thread.startup.cancel", { startupId: input.requestId }, {
      threadStartupService: container.resolve(ThreadStartupService),
      threadStartupFetchDecisions: container.resolve(ThreadStartupFetchDecisions), workspaceEnvironmentService: environment, agentService: agent,
    });
    await observer.stop();
    await expect(service.implement(input)).rejects.toMatchObject({ code: "startup_cancelled" });
    expect(runtime.threads.findById(target.id)?.deleted_at).toBeNull();
    expect(NodeFS.existsSync(checkout)).toBe(true);
    expect(database.prepare("SELECT content FROM messages WHERE thread_id = ?").all(target.id)).toEqual([{ content: "Keep this conversation" }]);
    await expectPendingCleared();
    await runtime.threadService.delete(target.id, true);
    await cleanTarget(target.id, checkout);
  });

  it("publishes the clear when recovering a waiting request in the same service", async () => {
    const { input, target, checkout } = await waitingWorktree();
    await observer.stop();
    await service.recoverInterrupted();
    await expectPendingCleared();
    expect(runtime.reservations.get(threadId)).toBeUndefined();
    await expect(service.implement(input)).rejects.toMatchObject({ code: "implement_interrupted" });
    await cleanTarget(target.id, checkout);
  });

  it.each([false, true])("refuses a source without a commit before creating anything, initialized: %s", async initialized => {
    const repo = NodePath.join(directory, NodeCrypto.randomUUID());
    NodeFS.mkdirSync(repo);
    if (initialized) git(repo, "init", "-b", "main");
    const workspace = await container.resolve(WorkspaceRepo).create("No commit", repo, false);
    database.prepare("UPDATE threads SET workspace_id = ? WHERE id = ?").run(workspace.id, threadId);
    const input: PlanImplement = { ...request(), target: "new-worktree" };
    await expect(service.implement(input)).rejects.toMatchObject({ code: "implement_failed" });
    expect(new PlanImplementStore(database).read(input.requestId)).toBeNull();
    expect(runtime.startups.get(input.requestId)).toBeNull();
    expect(container.resolve(ThreadRepo).listByWorkspace(workspace.id).map(thread => thread.id)).toEqual([threadId]);
    expect(runtime.reservations.get(threadId)).toBeUndefined();
  });

  async function providerEvent(request: TurnRequest, type: AgentEvent["type"], fields: Record<string, unknown> = {}) {
    const execution = { threadId, turnId: request.turnId, executionId: request.turnExecutionId };
    const route = workers.providerEvents.resolve(execution.executionId, "codex");
    if (route.kind !== "worker") throw new Error("Expected worker event route");
    const event = AgentEventSchema().parse({ type, threadId, turnExecutionId: execution.executionId,
      ...(type === "turnComplete" ? { reason: "completed", costUsd: 0, tokensIn: 0, tokensOut: 0 } : {}), ...fields });
    const itemId = NodeCrypto.randomUUID();
    const now = new Date().toISOString();
    return route.submit({ ...execution, batchId: itemId, deliveryAttempt: 1, phase: "running", events: [{
      eventId: itemId, routing: { ...execution, itemId }, sourceProviderId: "codex", sourceIdentities: [],
      payload: { type: "item.recorded", item: { id: itemId, threadId, turnId: execution.turnId, kind: "system",
        providerIdentities: [], payload: { projection: "providerRuntimeEvent", runtimeEvent: { event } }, createdAt: now, updatedAt: now } },
    }] });
  }

  it("arms an answer after the previous worker release and saves its plan without a missing-capture warning", async () => {
    database.prepare("DELETE FROM plans WHERE thread_id = ?").run(threadId);
    await container.resolve(ThreadRepo).updatePlanPhase(threadId, null);
    const planTurns = container.resolve(PlanTurnService);
    const warnings = vi.spyOn(logger, "warn");
    const releasing = deferred();
    const release = deferred();
    Object.assign(provider, { fenceCanonicalTurnEvents: async () => { releasing.resolve(); await release.promise; } });
    await agent.sendMessage({ threadId, content: "Plan storage", interactionMode: "plan", provider: "codex" });
    const first = sent[0]!;
    const questions = "```plan-questions\n" + JSON.stringify([{ id: "q1", category: "Storage", question: "Where?", options: [
      { id: "local", title: "Local", description: "SQLite" }, { id: "remote", title: "Remote", description: "Cloud" },
    ] }]) + "\n```";
    await providerEvent(first, "textDelta", { delta: questions, isFinalResponse: true });
    await providerEvent(first, "message", { content: questions, tokens: null });
    await providerEvent(first, "turnComplete");
    await providerEvent(first, "ended", { outcome: "completed" });
    await releasing.promise;
    const answer = planTurns.answerQuestions(threadId, [{ questionId: "q1", selectedOptionId: "local", freeText: null }]);
    try {
      await workers.progress?.waitForTerminalSaves(threadId);
      expect(sent).toHaveLength(1);
      expect((await service.snapshot({ threadId })).phase).toBe("questions");
    } finally {
      release.resolve();
    }
    await answer;
    const second = sent[1]!;
    expect(second.planTurn).toEqual({ kind: "planning", planFilePath: files.path(threadId) });
    expect(second.message).toContain("**Where?**: Local");
    const content = "````mcode-plan\n# Storage plan\nUse SQLite.\n````";
    expect(planTurns.needsAssistantMaterialization({ type: "message", threadId, messageId: "pending", content })).toBe(true);
    await providerEvent(second, "textDelta", { delta: content, isFinalResponse: true });
    await providerEvent(second, "message", { content, tokens: null });
    await providerEvent(second, "turnComplete");
    await providerEvent(second, "ended", { outcome: "completed" });
    await workers.progress?.waitForTerminalSaves(threadId);
    expect((await service.snapshot({ threadId })).phase).toBe("ready");
    expect(plans.listByThread(threadId).map(plan => plan.contentMd)).toEqual(["# Storage plan\nUse SQLite."]);
    expect(warnings.mock.calls.filter(([message]) => /Plan capture missing|Planning turn produced no plan/.test(String(message)))).toEqual([]);
    warnings.mockRestore();
  });

  function userMessages() {
    return database.prepare("SELECT id, content FROM messages WHERE thread_id = ? AND role = 'user'").all(threadId);
  }

  function turns() {
    return database.prepare("SELECT status FROM canonical_agent_turns WHERE thread_id = ?").all(threadId);
  }

  function assertUnaccepted() {
    expect(plans.getById(ready.id)?.status).toBe("ready");
    expect(userMessages()).toEqual([]);
    expect(turns()).toEqual([]);
  }

  it("replays a new direct thread while starting and after admission, retaining Accepted after startup cancellation", async () => {
    const starting = deferred();
    provider.prepareImplement = async () => {
      await starting.promise;
      return { outcome: "skipped", reason: "no-file" };
    };
    const input: PlanImplement = { ...request(), target: "new-thread" };
    const first = service.implement(input);
    await expect.poll(() => runtime.reservations.get(threadId)?.state).toBe("planImplement");
    const reconnect = service.implement(input);
    await expect(agent.sendMessage({ threadId, content: "Competing Send", attachments: [] })).rejects.toThrow("pending mutation");
    starting.resolve();
    const receipt = await first;
    expect(await reconnect).toEqual(receipt);
    expect(await new PlanService(writer, workers.progress, files, runtime).implement(input)).toEqual(receipt);
    expect(runtime.threads.findById(receipt.targetThreadId)).toMatchObject({ mode: "direct", worktree_path: null });
    expect(database.prepare("SELECT id, content FROM messages WHERE thread_id = ? AND role = 'user'").all(receipt.targetThreadId))
      .toEqual([{ id: receipt.messageId, content: "Implement plan v1" }]);
    expect(plans.listByThread(receipt.targetThreadId)).toMatchObject([{ status: "accepted", captureSource: "copy",
      baseVersionId: ready.id, acceptedMessageId: receipt.messageId }]);
    expect(database.prepare("SELECT target_thread_id FROM plan_implement_requests WHERE request_id = ?").all(input.requestId))
      .toEqual([{ target_thread_id: receipt.targetThreadId }]);
    expect(runtime.reservations.get(threadId)).toBeUndefined();
    await routeThreadStartupRpc("thread.startup.cancel", { startupId: input.requestId }, {
      threadStartupService: container.resolve(ThreadStartupService),
      threadStartupFetchDecisions: container.resolve(ThreadStartupFetchDecisions),
      workspaceEnvironmentService: container.resolve(WorkspaceEnvironmentService), agentService: agent,
    });
    expect(runtime.startups.get(input.requestId)).toMatchObject({ state: "cancelled", cancellation: "requested" });
    expect(plans.getById(ready.id)?.status).toBe("accepted");
    expect(database.prepare("SELECT content FROM messages WHERE id = ?").get(receipt.messageId)).toEqual({ content: "Implement plan v1" });
  });

  it("refuses a busy source before creating a new thread", async () => {
    const before = database.prepare("SELECT id FROM threads ORDER BY id").all();
    runtime.reservations.reserve(threadId, "activeTurn");
    const input: PlanImplement = { ...request(), target: "new-thread" };
    await expect(service.implement(input)).rejects.toMatchObject({ code: "thread_busy" });
    expect(runtime.startups.get(input.requestId)).toBeNull();
    expect(new PlanImplementStore(database).read(input.requestId)).toBeNull();
    expect(database.prepare("SELECT id FROM threads ORDER BY id").all()).toEqual(before);
    assertUnaccepted();
  });

  it("removes an empty new thread after admission fails", async () => {
    const before = database.prepare("SELECT id FROM threads ORDER BY id").all();
    database.run("CREATE TRIGGER fail_admission BEFORE INSERT ON canonical_agent_turns BEGIN SELECT RAISE(ABORT, 'admission fault'); END");
    const input: PlanImplement = { ...request(), target: "new-thread" };
    await expect(service.implement(input)).rejects.toMatchObject({ code: "implement_failed" });
    const startup = runtime.startups.get(input.requestId);
    expect(startup?.state).toBe("failed");
    expect(database.prepare("SELECT id FROM threads ORDER BY id").all()).toEqual(before);
    expect(plans.getById(ready.id)?.status).toBe("ready");
    expect(runtime.reservations.get(threadId)).toBeUndefined();
    expect(NodeFS.readFileSync(files.path(threadId), "utf8")).toBe("# Original\nExact plan text.");
  });

  it("refuses a worktree source without a checkout before creating a thread", async () => {
    database.prepare("UPDATE threads SET mode = 'worktree', worktree_path = NULL WHERE id = ?").run(threadId);
    const before = database.prepare("SELECT id FROM threads ORDER BY id").all();
    const input: PlanImplement = { ...request(), target: "new-thread" };
    await expect(service.implement(input)).rejects.toMatchObject({ code: "implement_failed" });
    expect(database.prepare("SELECT id FROM threads ORDER BY id").all()).toEqual(before);
    expect(runtime.startups.get(input.requestId)).toBeNull();
    expect(new PlanImplementStore(database).read(input.requestId)).toMatchObject({ status: "failed", failureCode: "implement_failed" });
    expect(runtime.reservations.get(threadId)).toBeUndefined();
    assertUnaccepted();
  });

  async function worktreeSource() {
    database.prepare("UPDATE threads SET mode = 'worktree', worktree_path = ? WHERE id = ?").run(directory, threadId);
    const worktrees = container.resolve(GitWorktreeService);
    const listed = vi.spyOn(worktrees, "listWorktrees").mockResolvedValue([
      { path: directory, branch: "main", name: "fixture", managed: false },
    ]);
    return listed;
  }

  it.each(["thread", "new-direct-thread", "new-worktree-thread"] as const)(
    "stops %s during initial snapshot preparation without losing Accepted",
    async (target) => {
      const listed = target === "new-worktree-thread" ? await worktreeSource() : undefined;
      const entered = deferred();
      const resume = deferred();
      const snapshot = vi.spyOn(container.resolve(SnapshotService), "captureRef").mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        throw new Error("Fixture checkout has no Git snapshot");
      });
      try {
        const receipt = await service.implement({ ...request(), target: target === "thread" ? "thread" : "new-thread" });
        await entered.promise;
        const stopped = agent.stopSession(receipt.targetThreadId, { by: "user" });
        resume.resolve();
        expect(await stopped).toMatchObject({ status: "cancelled", dispatchState: "not-dispatched" });
        expect(plans.getById(ready.id)?.status).toBe("accepted");
        expect(database.prepare("SELECT id, content FROM messages WHERE thread_id = ? AND role = 'user'").all(receipt.targetThreadId))
          .toEqual([{ id: receipt.messageId, content: "Implement plan v1" }]);
        await expect.poll(() => database.prepare("SELECT status FROM canonical_agent_turns WHERE thread_id = ?").all(receipt.targetThreadId))
          .toEqual([{ status: "Cancelled" }]);
        expect(workers.owner.current(receipt.targetThreadId)).toBeUndefined();
        expect(sent).toEqual([]);
      } finally {
        resume.resolve();
        snapshot.mockRestore();
        listed?.mockRestore();
      }
    },
  );

  it("admits in the source checkout with configured Setup skipped and no queued prompt", async () => {
    const listed = await worktreeSource();
    const environment = container.resolve(WorkspaceEnvironmentService);
    await environment.save({ workspaceId, sourceRevision: null,
      document: { version: "0.0.1", setup: { windows: "echo should-not-run", linux: "echo should-not-run" }, actions: [] } });
    const setup = vi.spyOn(environment, "admitAutomaticTurn");
    const input: PlanImplement = { ...request(), target: "new-thread" };
    const receipt = await service.implement(input);
    expect(receipt.state).toBe("admitted");
    expect(runtime.threads.findById(receipt.targetThreadId)).toMatchObject({ mode: "worktree", worktree_path: directory, worktree_managed: false });
    expect(runtime.startups.get(input.requestId)?.steps.find(step => step.phase === "setup"))
      .toMatchObject({ state: "skipped", detail: { skipReason: "plan-implement" } });
    expect(setup).not.toHaveBeenCalled();
    expect(environment.getAutomaticSetup({ threadId: receipt.targetThreadId }).queuedTurns).toEqual([]);
    expect(new PlanImplementStore(database).read(input.requestId)?.status).toBe("admitted");
    await agent.stopSession(receipt.targetThreadId, { by: "user" });
    setup.mockRestore();
    listed.mockRestore();
  });

  it("cancels during worktree preparation, compensates the empty target and releases the source", async () => {
    const listed = await worktreeSource();
    const startups = container.resolve(ThreadStartupService);
    const release = deferred();
    const reached = deferred();
    const advance = startups.advance.bind(startups);
    const pause = vi.spyOn(startups, "advance").mockImplementation(async (...args) => {
      const result = await advance(...args);
      if (args[1] === "worktree") {
        reached.resolve();
        await release.promise;
      }
      return result;
    });
    const input: PlanImplement = { ...request(), target: "new-thread" };
    const pending = service.implement(input);
    const rejected = expect(pending).rejects.toMatchObject({ code: "startup_cancelled" });
    await reached.promise;
    const targetId = startups.get(input.requestId)?.threadId;
    if (!targetId) throw new Error("Worktree startup must be bound before cancellation");
    await routeThreadStartupRpc("thread.startup.cancel", { startupId: input.requestId }, {
      threadStartupService: startups, threadStartupFetchDecisions: container.resolve(ThreadStartupFetchDecisions),
      workspaceEnvironmentService: container.resolve(WorkspaceEnvironmentService), agentService: agent,
    });
    release.resolve();
    await rejected;
    expect(runtime.threads.findById(targetId)).toBeNull();
    expect(runtime.reservations.get(threadId)).toBeUndefined();
    expect(plans.getById(ready.id)?.status).toBe("ready");
    expect(new PlanImplementStore(database).read(input.requestId)).toMatchObject({ status: "failed", failureCode: "startup_cancelled" });
    pause.mockRestore();
    listed.mockRestore();
  });

  it("settles cancellation that vetoes admission after the Setup skip checkpoint", async () => {
    const listed = await worktreeSource();
    database.run(`CREATE TRIGGER cancel_before_admission AFTER UPDATE OF phase ON thread_startups
      WHEN NEW.phase = 'agent' AND OLD.phase <> 'agent'
      BEGIN UPDATE thread_startups SET cancellation = 'requested' WHERE startup_id = NEW.startup_id; END`);
    const before = database.prepare("SELECT id FROM threads ORDER BY id").all();
    const input: PlanImplement = { ...request(), target: "new-thread" };
    try {
      await expect(service.implement(input)).rejects.toMatchObject({ code: "startup_cancelled" });
      expect(runtime.startups.get(input.requestId)).toMatchObject({ state: "cancelled", cancellation: "requested" });
      expect(database.prepare("SELECT id FROM threads ORDER BY id").all()).toEqual(before);
      expect(new PlanImplementStore(database).read(input.requestId))
        .toMatchObject({ status: "failed", failureCode: "startup_cancelled" });
      expect(runtime.reservations.get(threadId)).toBeUndefined();
      expect(sent).toEqual([]);
      assertUnaccepted();
    } finally {
      listed.mockRestore();
    }
  });

  it.each(["empty", "visible", "internal"])("recovers a crash after creation, preserving a target with %s messages", async (messageKind) => {
    const input: PlanImplement = { ...request(), target: "new-thread" };
    await writer.execute(planImplementWriteOperations.prepare, { input, fingerprint: "crashed", planFilePath: files.path(threadId) });
    const created = await container.resolve(ThreadCreationCoordinator).createInitialTurn({ workspaceId,
      startupId: input.requestId, content: "Implement plan v1", mode: "direct", provider: "codex" });
    if (messageKind !== "empty") {
      await container.resolve(MessageRepo).create(created.thread.id, "user", "Keep my message", 0,
        undefined, undefined, undefined, undefined, messageKind === "internal");
    }
    await container.resolve(ThreadStartupService).interruptNonterminalOnStartup();
    await service.recoverInterrupted();
    expect(new PlanImplementStore(database).read(input.requestId)).toMatchObject({ status: "failed", failureCode: "interrupted" });
    if (messageKind !== "empty") {
      expect(database.prepare("SELECT content FROM messages WHERE thread_id = ?").all(created.thread.id)).toEqual([{ content: "Keep my message" }]);
    } else {
      expect(runtime.threads.findById(created.thread.id)).toBeNull();
    }
    expect(plans.getById(ready.id)?.status).toBe("ready");
    expect(NodeFS.readFileSync(files.path(threadId), "utf8")).toBe("# Original\nExact plan text.");
  });

  async function draft() {
    return service.saveVersion({ threadId, versionId: NodeCrypto.randomUUID(), baseVersionId: ready.id,
      baseRevision: 0, contentMd: "# Edited\nDraft text." });
  }

  // Implement answers on admission. Stopping the session before the worker
  // hands the turn to the provider races its release, so tests that end
  // right after admission wait for dispatch first.
  async function untilDispatched() {
    await expect.poll(() => sent).toHaveLength(1);
  }

  function pauseFiles() {
    const entered = deferred();
    const release = deferred();
    provider.prepareImplement = async () => {
      entered.resolve();
      await release.promise;
      return { outcome: "skipped", reason: "unproven" };
    };
    return { entered: entered.promise, release: release.resolve };
  }

  it("joins double presses, replays the receipt and dispatches the exact text after worker acceptance", async () => {
    const input = request();
    const [first, second] = await Promise.all([service.implement(input), service.implement(input)]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ state: "admitted", nativePlanFile: { outcome: "skipped", reason: "no-file" } });
    expect(await new PlanService(writer, workers.progress, files, runtime).implement(input)).toEqual(first);
    expect(turns()).toEqual([{ status: "Running" }]);
    expect(userMessages()).toEqual([{ id: first.messageId, content: "Implement plan v1" }]);
    await expect.poll(() => sent.map(turn => turn.message)).toEqual([
      `Implement plan v1: "Original".\n\nThis is the plan the user approved. It supersedes any earlier plan or plan file, including your own. Mcode keeps this text at ${files.path(threadId)}.\n\n# Original\nExact plan text.`,
    ]);
    expect(atDispatch).toEqual([{ text: "# Original\nExact plan text.", status: "accepted" }]);
    expect(runtime.threads.findById(threadId)?.interaction_mode).toBe("build");
    expect(runtime.threads.findById(threadId)?.plan_phase).toBeNull();
    expect((await service.snapshot({ threadId })).versions).toMatchObject([{ id: ready.id, status: "accepted", acceptedMessageId: first.messageId }]);
    expect(new PlanImplementStore(database).read(input.requestId)).toMatchObject({ status: "admitted",
      turnId: sent[0]?.turnId, executionId: sent[0]?.turnExecutionId });
  });

  it("refuses an older displayed revision with no row, then implements the newer text on a second press", async () => {
    ready = await plans.create(threadId, ready.messageId!, { title: "Original", contentMd: "# Original", captureSource: "fence" }, "codex");
    let version = await draft();
    for (const contentMd of ["# Rev 2", "# Rev 3", "# Window A"]) {
      version = await service.saveVersion({ threadId, versionId: version.id, baseVersionId: ready.id, baseRevision: version.revision, contentMd });
    }
    const stale = request(version);
    expect(version).toMatchObject({ version: 3, revision: 4 });
    const newer = await service.saveVersion({ threadId, versionId: version.id, baseVersionId: ready.id, baseRevision: 4, contentMd: "# Window B\nRevision five." });
    await expect(service.implement(stale)).rejects.toMatchObject({ code: "plan_conflict", latestVersion: { revision: 5, contentMd: "# Window B\nRevision five." } });
    expect(new PlanImplementStore(database).read(stale.requestId)).toBeNull();
    assertUnaccepted();
    await service.implement(request(newer));
    await expect.poll(() => sent.map(turn => turn.message.endsWith("\n\n# Window B\nRevision five."))).toEqual([true]);
    expect(NodeFS.readFileSync(files.path(threadId), "utf8")).toBe("# Window B\nRevision five.");
  });

  it("rolls back a pending fork when expectedRevision differs from the saved revision", async () => {
    const versionId = NodeCrypto.randomUUID();
    const input = { ...request(), versionId, expectedRevision: 2,
      pending: { versionId, baseVersionId: ready.id, baseRevision: 0, contentMd: "# Unsaved" } };
    await expect(service.implement(input)).rejects.toMatchObject({ code: "plan_conflict", latestVersion: { id: ready.id } });
    expect(plans.listByThread(threadId)).toEqual([ready]);
    expect(new PlanImplementStore(database).read(input.requestId)).toBeNull();
    assertUnaccepted();
  });

  it("saves pending text once and accepts that exact revision", async () => {
    const versionId = NodeCrypto.randomUUID();
    const receipt = await service.implement({ ...request(), versionId, expectedRevision: 1,
      pending: { versionId, baseVersionId: ready.id, baseRevision: 0, contentMd: "# Unsaved\nLast keystroke." } });
    expect((await service.snapshot({ threadId })).versions.map(v => [v.status, v.revision, v.acceptedMessageId]))
      .toEqual([["superseded", 0, null], ["accepted", 1, receipt.messageId]]);
    await expect.poll(() => sent.map(turn => turn.message.endsWith("\n\n# Unsaved\nLast keystroke."))).toEqual([true]);
  });

  it("passes the newest agent file proof with draft text and durably returns the adapter outcome", async () => {
    const nativePlanFile = { path: NodePath.join(directory, "provider-plan.md"), sessionId: "provider-session", sha256: "a".repeat(64) };
    ready = await plans.create(threadId, ready.messageId!, { title: "Native", contentMd: "# Native", captureSource: "native", nativePlanFile }, "codex");
    const edited = await draft();
    provider.prepareImplement = async input => {
      expect(input).toEqual({ threadId, markdown: "# Edited\nDraft text.", nativePlanFile });
      expect(NodeFS.readFileSync(files.path(threadId), "utf8")).toBe("# Edited\nDraft text.");
      return { outcome: "skipped", reason: "changed" };
    };
    const input = request(edited);
    const receipt = await service.implement(input);
    expect(receipt.nativePlanFile).toEqual({ outcome: "skipped", reason: "changed" });
    expect(await service.implement(input)).toEqual(receipt);
    expect(JSON.stringify(await service.snapshot({ threadId }))).not.toContain("provider-plan.md");
    await untilDispatched();
  });

  it("rejects a reused request id with another expectedRevision both in flight and after admission", async () => {
    const input = request();
    const paused = pauseFiles();
    const first = service.implement(input);
    await paused.entered;
    await expect(service.implement({ ...input, expectedRevision: 1 })).rejects.toMatchObject({ code: "implement_request_conflict" });
    paused.release();
    await first;
    await expect(service.implement({ ...input, expectedRevision: 1 })).rejects.toMatchObject({ code: "implement_request_conflict" });
    expect(turns()).toEqual([{ status: "Running" }]);
    await untilDispatched();
  });

  it("keeps ordinary Send and autosave out while Implement owns the reservation", async () => {
    const paused = pauseFiles();
    const implementing = service.implement(request());
    await paused.entered;
    await expect(agent.sendMessage({ threadId, content: "Ordinary send", provider: "codex" })).rejects.toThrow(/pending mutation/);
    await expect(draft()).rejects.toMatchObject({ code: "plan_busy" });
    paused.release();
    await implementing;
    expect(turns()).toEqual([{ status: "Running" }]);
    expect(userMessages()).toHaveLength(1);
    await untilDispatched();
  });

  it("refuses Implement when ordinary Send wins admission", async () => {
    await agent.sendMessage({ threadId, content: "Ordinary send", provider: "codex", interactionMode: "build" });
    await expect(service.implement(request())).rejects.toMatchObject({ code: "thread_busy" });
    expect(turns()).toEqual([{ status: "Running" }]);
    expect(userMessages()).toMatchObject([{ content: "Ordinary send" }]);
    expect(plans.getById(ready.id)?.status).toBe("ready");
  });

  it("accepts a ready base, supersedes its draft and retains only the accepted message link", async () => {
    await draft();
    const receipt = await service.implement(request());
    expect((await service.snapshot({ threadId })).versions.map(v => [v.status, v.acceptedMessageId]))
      .toEqual([["accepted", receipt.messageId], ["superseded", null]]);
    await expect.poll(() => atDispatch).toEqual([{ text: "# Original\nExact plan text.", status: "accepted" }]);
    expect(NodeFS.readFileSync(files.path(threadId), "utf8")).toBe("# Original\nExact plan text.");
  });

  it("restores the draft projection when preparing its ready base fails after file preparation", async () => {
    await draft();
    provider.prepareImplement = async () => { throw new Error("Injected native file failure"); };
    const input = request();
    await expect(service.implement(input)).rejects.toMatchObject({ code: "implement_failed" });
    assertUnaccepted();
    expect(NodeFS.readFileSync(files.path(threadId), "utf8")).toBe("# Edited\nDraft text.");
    expect(new PlanImplementStore(database).read(input.requestId)?.status).toBe("failed");
    expect(runtime.reservations.get(threadId)).toBeUndefined();
  });

  it("publishes the pending edit it saved when Implement fails after preparation", async () => {
    provider.prepareImplement = async () => { throw new Error("Injected native file failure"); };
    const versionId = NodeCrypto.randomUUID();
    pushes.versions = [];
    await expect(service.implement({ ...request(), versionId, expectedRevision: 1,
      pending: { versionId, baseVersionId: ready.id, baseRevision: 0, contentMd: "# Pending" } }))
      .rejects.toMatchObject({ code: "implement_failed" });
    assertUnaccepted();
    expect(pushes.versions).toContainEqual({ threadId,
      version: expect.objectContaining({ id: versionId, revision: 1, contentMd: "# Pending", status: "draft" }) });
  });

  it("implements at the thread's reasoning level", async () => {
    await runtime.threads.updateSettings(threadId, { reasoning_level: "xhigh" });
    await service.implement(request());
    await expect.poll(() => sent.map(turn => turn.reasoningLevel)).toEqual(["xhigh"]);
  });

  it("rolls back pending edits when a fault occurs before the request row", async () => {
    database.run("CREATE TRIGGER fail_implement BEFORE INSERT ON plan_implement_requests BEGIN SELECT RAISE(ABORT, 'injected prepare failure'); END");
    const versionId = NodeCrypto.randomUUID();
    await expect(service.implement({ ...request(), versionId, expectedRevision: 1,
      pending: { versionId, baseVersionId: ready.id, baseRevision: 0, contentMd: "# Pending" } }))
      .rejects.toMatchObject({ code: "implement_failed" });
    expect(plans.listByThread(threadId)).toEqual([ready]);
    assertUnaccepted();
  });

  it("leaves no message when snapshot file preparation fails after the row", async () => {
    const path = files.path(threadId);
    NodeFS.rmSync(path);
    NodeFS.mkdirSync(path);
    const input = request();
    await expect(service.implement(input)).rejects.toMatchObject({ code: "implement_failed" });
    assertUnaccepted();
    expect(new PlanImplementStore(database).read(input.requestId)?.status).toBe("failed");
    NodeFS.rmdirSync(path);
  });

  it.each(["questions", "planning", "ready", "no_plan", null] as const)("rolls back phase %s, Accepted and the user message when admission fails", async (phase) => {
    await container.resolve(ThreadRepo).updatePlanPhase(threadId, phase);
    database.run("CREATE TRIGGER fail_admission BEFORE INSERT ON canonical_agent_turns BEGIN SELECT RAISE(ABORT, 'injected admission failure'); END");
    await expect(service.implement(request())).rejects.toMatchObject({ code: "implement_failed" });
    assertUnaccepted();
    expect(runtime.threads.findById(threadId)?.interaction_mode).toBe("plan");
    expect(runtime.threads.findById(threadId)?.plan_phase).toBe(phase);
  });

  it.each(["questions", "planning", "no_plan", null] as const)("clears phase %s with Implement admission", async (phase) => {
    await container.resolve(ThreadRepo).updatePlanPhase(threadId, phase);
    await service.implement(request());
    expect(runtime.threads.findById(threadId)?.plan_phase).toBeNull();
    expect(plans.getById(ready.id)?.status).toBe("accepted");
    expect(turns()).toEqual([{ status: "Running" }]);
    await untilDispatched();
  });

  it("rechecks the recorded revision inside worker admission", async () => {
    const version = await draft();
    provider.prepareImplement = async () => {
      database.prepare("UPDATE plans SET revision = revision + 1, content_md = ? WHERE id = ?").run("# Changed before start", version.id);
      return { outcome: "skipped", reason: "changed" };
    };
    await expect(service.implement(request(version))).rejects.toMatchObject({ code: "plan_conflict", latestVersion: { revision: 2 } });
    expect(plans.getById(version.id)?.status).toBe("draft");
    expect(userMessages()).toEqual([]);
    expect(turns()).toEqual([]);
  });

  it("keeps Accepted after provider dispatch fails and never lets late compensation overwrite admission", async () => {
    const send = vi.spyOn(provider, "sendTurn").mockRejectedValueOnce(new Error("Injected provider dispatch failure"));
    const input = request();
    const receipt = await service.implement(input);
    expect(receipt.state).toBe("admitted");
    await expect.poll(() => turns()).toEqual([{ status: "Errored" }]);
    expect(plans.getById(ready.id)?.status).toBe("accepted");
    expect(userMessages()).toEqual([{ id: receipt.messageId, content: "Implement plan v1" }]);
    await writer.execute(planImplementWriteOperations.fail, { requestId: input.requestId, code: "interrupted" });
    expect(await service.implement(input)).toEqual(receipt);
    send.mockRestore();
  });

  it("answers on admission while the provider is still starting the turn", async () => {
    const providerStarting = deferred();
    const send = vi.spyOn(provider, "sendTurn").mockImplementationOnce(() => providerStarting.promise);
    const receipt = await service.implement(request());
    expect(receipt.state).toBe("admitted");
    await expect.poll(() => send.mock.calls.length).toBe(1);
    providerStarting.resolve();
    send.mockRestore();
  });

  it("recovers an abandoned prepared request with a new service set on the same database", async () => {
    await draft();
    const paused = pauseFiles();
    const input = request();
    void service.implement(input);
    await paused.entered;
    await container.resolve(SnapshotRefPins).drain();
    await workers.close();
    await writer.close();
    container.resolve<Database>("Database").close(true);
    container.reset();
    await openServiceSet();
    service = new PlanService(writer, workers.progress, files, runtime);
    await service.recoverInterrupted();
    await expect(service.implement(input)).rejects.toMatchObject({ code: "implement_interrupted" });
    expect(NodeFS.readFileSync(files.path(threadId), "utf8")).toBe("# Edited\nDraft text.");
    assertUnaccepted();
    await service.implement(request());
    expect(turns()).toEqual([{ status: "Running" }]);
    await untilDispatched();
  });

  it("refuses superseded and accepted versions without a new request row", async () => {
    const next = await plans.create(threadId, ready.messageId!, { title: "New", contentMd: "# New", captureSource: "fence" }, "codex");
    await expect(service.implement(request())).rejects.toMatchObject({ code: "plan_conflict", latestVersion: { id: next.id } });
    expect(userMessages()).toEqual([]);
    await service.implement(request(next));
    await untilDispatched();
    await agent.stopSession(threadId, { by: "user" });
    await expect(service.implement(request(next))).rejects.toMatchObject({ code: "plan_read_only" });
  });
});
