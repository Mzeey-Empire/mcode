import "reflect-metadata";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@mcode/shared";
import type { IAgentProvider, IProviderRegistry, ScheduledTurnRetry } from "@mcode/contracts";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { SettingsService } from "../../../settings/settings-service.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import { GitRepositoryService } from "../../../projects/git/git-repository-service.js";
import { WorktreeSafetyService } from "../../../projects/git/worktree-safety-service.js";
import { SandboxWorktreeCleanupPolicy } from "../../../projects/worktrees/sandbox-worktree-cleanup-policy.js";
import { ProjectWorktreeService } from "../../../projects/worktrees/project-worktree-service.js";
import { FakeGitExecutor } from "../../../projects/git/execution/fake-git-executor.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { PlanTurnService } from "../../planning/plan-turn-service.js";
import { PlanQuestionService } from "../../planning/plan-question-service.js";
import { PlanRepo } from "../../planning/persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { GoalLifecycleService } from "../../goals/goal-lifecycle-service.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../../orchestration/agent-turn-command-port.js";
import { ThreadService } from "../../../thread-control/lifecycle/thread-service.js";
import { HandoffStorage } from "../../../handoff/persistence/handoff-storage.js";
import { agentStorageTestWriter, closeAgentStorageTestDatabases, openAgentStorageTestDatabase } from "../../__tests__/agent-storage-fixture.js";
import { CanonicalAgentStore } from "../../canonical/canonical-agent-store.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { MessageStore } from "../../conversation/persistence/message-store.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { TurnAdmissionDispatchCoordinator, type SendMessageCommand, type TurnRuntimeAdmissionAuthority } from "../../turns/turn-admission-dispatch-coordinator.js";
import { TurnRecoveryService } from "../turn-recovery-service.js";
import { TurnRetryScheduleStore } from "../turn-retry-schedule-store.js";
import { TurnRetryScheduler, type TurnRetrySchedulerClock } from "../turn-retry-scheduler.js";

const NOW = "2026-10-11T12:00:00.000Z";
const THREAD_ID = "scheduled-thread";
const TURN_ID = "failed-turn";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000015";
const DAY_MS = 86_400_000;

class FakeClock implements TurnRetrySchedulerClock {
  time = Date.parse(NOW);
  private nextId = 1;
  readonly timers = new Map<number, { at: number; callback: () => Promise<void> }>();
  now(): number { return this.time; }
  setTimeout(callback: () => Promise<void>, delay: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  }
  clearTimeout(id: ReturnType<TurnRetrySchedulerClock["setTimeout"]>): void {
    if (typeof id !== "number") throw new Error("Unexpected native timer in fake clock");
    this.timers.delete(id);
  }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      await next[1].callback();
    }
    this.time = end;
  }
}

describe("TurnRetryScheduler", () => {
  let db: Database;
  let sink: CanonicalAgentStore;
  let boundary: CanonicalAgentBoundary;
  let threads: ThreadRepo;
  let store: TurnRetryScheduleStore;
  let recovery: TurnRecoveryService;
  let scheduler: TurnRetryScheduler;
  let clock: FakeClock;
  let messages: MessageStore;
  let published: Array<{ threadId: string; retry: ScheduledTurnRetry | null }>;
  let dispatch: ReturnType<typeof vi.fn<(command: SendMessageCommand) => Promise<void>>>;
  let firedAt: number[];

  function startTurn(turnId: string, executionId: string): void {
    sink.startParentTurn({ thread: { id: THREAD_ID, workspaceId: "workspace-retry", providerId: "codex", createdAt: NOW },
      turnId, executionId, permissionMode: "supervised", providerIdentities: [],
      projectUserMessage: () => messages.create(THREAD_ID, "user", "Finish the task", 1) });
  }

  function finishTurn(turnId = TURN_ID, executionId = EXECUTION_ID, outcome: "errored" | "completed" = "errored"): void {
    sink.finishParentTurn({ threadId: THREAD_ID, turnId, executionId, providerId: "codex", providerIdentities: [],
      outcome, projectTurn: () => ({ message: null, narrative: [] }) });
  }

  const input = (at = "2026-10-11T12:01:00.000Z") => ({ threadId: THREAD_ID, turnId: TURN_ID, at });

  beforeEach(async () => {
    db = openAgentStorageTestDatabase();
    const writer = agentStorageTestWriter(db);
    await writer.whenReady();
    vi.stubEnv("MCODE_DATA_DIR", NodePath.dirname(db.filename));
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("workspace-retry", "Retry fixture", NodePath.dirname(db.filename), NOW, NOW);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(THREAD_ID, "workspace-retry", "Scheduled retry", "main", "codex", "errored", NOW, NOW);
    sink = new CanonicalAgentStore(db, () => {});
    boundary = new CanonicalAgentBoundary(db, writer, new CanonicalAgentWriterClient(writer), () => {});
    threads = new ThreadRepo(db, writer);
    store = new TurnRetryScheduleStore(db, writer);
    messages = new MessageStore(db);
    recovery = new TurnRecoveryService(boundary, threads, new AttachmentService(),
      new ParentAssistantTextCheckpointService(db, writer), new ThreadStartupRepo(db, writer));
    startTurn(TURN_ID, EXECUTION_ID);
    finishTurn();
    clock = new FakeClock();
    published = [];
    firedAt = [];
    dispatch = vi.fn(async (command) => {
      firedAt.push(clock.now());
      expect(store.get(THREAD_ID)).toBeNull();
      expect(published.at(-1)).toEqual({ threadId: THREAD_ID, retry: null });
      await scheduler.unschedule(command.threadId);
      if (!command.sourceTurnId) throw new Error("Retry requires an attempt identity");
      await boundary.startParentTurn({ thread: { id: THREAD_ID, workspaceId: "workspace-retry", providerId: "codex", createdAt: NOW },
        turnId: command.sourceTurnId, executionId: NodeCrypto.randomUUID(), permissionMode: "supervised", providerIdentities: [],
        retryOfExecutionId: command.retryOfExecutionId, userMessage: { kind: "create", content: command.content, sequence: 2 } });
    });
    scheduler = new TurnRetryScheduler(store, recovery, dispatch, (event) => published.push(event), clock);
  });

  afterEach(async () => {
    await scheduler.shutdown();
    await closeAgentStorageTestDatabases();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("persists the notice on every thread read and fires at the requested deadline", async () => {
    const retry = { turnId: TURN_ID, at: "2026-10-11T12:01:00.000Z" };
    expect(await scheduler.schedule(input())).toEqual(retry);
    expect(store.listAll()).toEqual([{ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
      runAt: "2026-10-11T12:01:00.000Z", createdAt: NOW }]);
    expect(threads.findById(THREAD_ID)?.scheduled_retry).toEqual(retry);
    expect(threads.listByWorkspace("workspace-retry")[0]?.scheduled_retry).toEqual(retry);
    expect(threads.listRecent()[0]?.scheduled_retry).toEqual(retry);
    expect(threads.search({ query: "Scheduled" }).threads[0]?.scheduled_retry).toEqual(retry);
    expect(threads.listAllByWorkspace("workspace-retry")[0]?.scheduled_retry).toEqual(retry);
    expect(published).toEqual([{ threadId: THREAD_ID, retry }]);
    await clock.advance(59_999);
    expect(dispatch).toHaveBeenCalledTimes(0);
    await clock.advance(1);
    expect(firedAt).toEqual([Date.parse("2026-10-11T12:01:00.000Z")]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ content: "Finish the task", retryOfExecutionId: EXECUTION_ID });
    expect(threads.findById(THREAD_ID)?.scheduled_retry).toBeNull();
  });

  it("does not write or publish when no retry is scheduled", async () => {
    const writer = vi.spyOn(agentStorageTestWriter(db), "execute");
    await scheduler.unschedule(THREAD_ID);
    expect(writer).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("loads scheduled and unscheduled threads together in one query per list", async () => {
    const second = await threads.create("workspace-retry", "Second", "worktree", "second");
    const unscheduled = await threads.create("workspace-retry", "Unscheduled", "worktree", "third");
    db.prepare("UPDATE threads SET worktree_path = ?").run(NodePath.dirname(db.filename));
    const retry = await scheduler.schedule(input());
    const secondRetry = { turnId: "second-turn", at: "2026-10-11T12:02:00.000Z" };
    await store.upsert({ threadId: second.id, turnId: secondRetry.turnId, executionId: EXECUTION_ID,
      runAt: secondRetry.at, createdAt: NOW });
    const prepare = vi.spyOn(db, "prepare");
    const reads = [
      () => threads.listByWorkspace("workspace-retry"),
      () => threads.listRecent(),
      () => threads.search({ query: "" }).threads,
      () => threads.listAllByWorkspace("workspace-retry"),
      () => threads.findWorktreeThreadsByWorkspace("workspace-retry"),
    ];
    for (const read of reads) {
      prepare.mockClear();
      expect(Object.fromEntries(read().map((thread) => [thread.id, thread.scheduled_retry])))
        .toEqual({ [THREAD_ID]: retry, [second.id]: secondRetry, [unscheduled.id]: null });
      expect(prepare).toHaveBeenCalledTimes(1);
    }
  });

  it("cancels a stored retry even when no timer is armed", async () => {
    await scheduler.schedule(input());
    await scheduler.shutdown();
    await scheduler.unschedule(THREAD_ID);
    expect(store.get(THREAD_ID)).toBeNull();
    expect(published.at(-1)).toEqual({ threadId: THREAD_ID, retry: null });
  });

  it("cancels durably, publishes null and remains idempotent", async () => {
    await scheduler.schedule(input());
    await scheduler.unschedule(THREAD_ID);
    await scheduler.unschedule(THREAD_ID);
    expect(store.listAll()).toEqual([]);
    expect(clock.timers.size).toBe(0);
    expect(published.slice(1)).toEqual([{ threadId: THREAD_ID, retry: null }]);
    await clock.advance(120_000);
    expect(dispatch).toHaveBeenCalledTimes(0);
  });

  it.each([false, true])("clears a new send even with a schedule requested during preparation: %s", async (reschedule) => {
    await scheduler.schedule(input());
    const writer = agentStorageTestWriter(db);
    const workspaces = new WorkspaceRepo(db, writer);
    const messageRepo = new MessageRepo(db, writer);
    const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
      id: "codex" as const, descriptor: { id: "codex" as const, capabilities: [] }, supportsCompletion: false,
      subagentReporting: null,
      sessionForkOnResume: "unsupported" as const, maxInputCharactersPerTurn: 100_000,
      forker: { fork: async () => { throw new Error("Not used by admission"); } },
      sendTurn: async () => {}, stopSession: () => {}, shutdown: () => {}, listModels: async () => [],
    });
    const providers: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
    const settings = new SettingsService();
    const commands = new AgentRuntimeCommandPort();
    const plans = new PlanTurnService(threads, providers,
      new PlanQuestionService(messageRepo, new PlanQuestionAnswersRepo(db, writer)), new PlanRepo(db, writer), new AgentTurnCommandPort(commands));
    const admission = new TurnAdmissionDispatchCoordinator(threads, workspaces, messageRepo,
      new GitWorktreeService(workspaces, new FakeGitExecutor(), hostRuntime), new AttachmentService(), providers,
      new ProviderAvailabilityService(settings, providers), boundary, settings, plans,
      new GoalLifecycleService(threads, providers, writer, commands, boundary), undefined, undefined, hostRuntime.platform,
      { start: async ({ parentTurn }) => {
        if (reschedule) await scheduler.schedule(input("2026-10-11T12:02:00.000Z"));
        await boundary.startParentTurn(parentTurn);
      } }, scheduler);
    const runtime: TurnRuntimeAdmissionAuthority = {
      reserve: () => ({ threadId: THREAD_ID, turnExecutionId: NodeCrypto.randomUUID(), mutationReservationToken: NodeCrypto.randomUUID(), generation: 1 }),
      activate: () => {}, abort: async () => {}, release: () => {}, owns: () => true,
    };
    try {
      const admitted = await admission.admit({ threadId: THREAD_ID, content: "A different request" }, runtime);
      expect(admitted.kind).toBe("dispatch");
      expect(store.listAll()).toEqual([]);
      expect(clock.timers.size).toBe(0);
      expect(published.at(-1)).toEqual({ threadId: THREAD_ID, retry: null });
      await clock.advance(60_000);
      expect(dispatch).toHaveBeenCalledTimes(0);
    } finally { settings.dispose(); }
  });

  it("replaces an existing schedule and ignores its old callback", async () => {
    await scheduler.schedule(input());
    const previous = [...clock.timers.values()][0];
    await scheduler.schedule(input("2026-10-11T12:02:00.000Z"));
    await previous?.callback();
    await clock.advance(60_000);
    expect(dispatch).toHaveBeenCalledTimes(0);
    expect(store.listAll()).toEqual([{ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
      runAt: "2026-10-11T12:02:00.000Z", createdAt: NOW }]);
    await clock.advance(60_000);
    expect(firedAt).toEqual([Date.parse("2026-10-11T12:02:00.000Z")]);
  });

  it.each([10, 15, 20])("recovers a persisted row overdue by %i minutes", async (minutes) => {
    await store.upsert({ threadId: THREAD_ID, turnId: TURN_ID, executionId: EXECUTION_ID,
      runAt: new Date(Date.parse(NOW) - minutes * 60_000).toISOString(), createdAt: "2026-10-10T12:00:00.000Z" });
    await scheduler.start();
    expect(store.get(THREAD_ID)).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(minutes <= 15 ? 1 : 0);
    expect(threads.findById(THREAD_ID)?.scheduled_retry).toBeNull();
  });

  it("restores future rows at boot and chunks a 31-day timer without firing early", async () => {
    await scheduler.schedule(input("2026-11-11T12:00:00.000Z"));
    await scheduler.shutdown();
    expect(clock.timers.size).toBe(0);
    scheduler = new TurnRetryScheduler(store, recovery, dispatch, (event) => published.push(event), clock);
    await scheduler.start();
    expect([...clock.timers.values()].map((timer) => timer.at - clock.now())).toEqual([2_147_483_647]);
    await clock.advance(30 * DAY_MS);
    expect(dispatch).toHaveBeenCalledTimes(0);
    await clock.advance(DAY_MS);
    expect(firedAt).toEqual([Date.parse("2026-11-11T12:00:00.000Z")]);
  });

  it.each([
    ["2026-10-11T12:00:00.000Z", "TURN_RETRY_SCHEDULE_INVALID_TIME"],
    ["2026-10-10T12:00:00.000Z", "TURN_RETRY_SCHEDULE_INVALID_TIME"],
    ["invalid", "TURN_RETRY_SCHEDULE_INVALID_TIME"],
    ["2026-11-11T12:00:00.001Z", "TURN_RETRY_SCHEDULE_TOO_FAR"],
  ])("rejects deadline %s with %s", async (at, code) => {
    await expect(scheduler.schedule(input(at))).rejects.toMatchObject({ code });
    expect(store.listAll()).toEqual([]);
    expect(published).toEqual([]);
  });

  it("rejects a non-latest and a non-errored attempt using recovery eligibility", async () => {
    const nextExecution = "00000000-0000-4000-8000-000000000016";
    startTurn("later-turn", nextExecution);
    finishTurn("later-turn", nextExecution, "completed");
    await expect(scheduler.schedule(input())).rejects.toMatchObject({ code: "TURN_RETRY_NOT_LATEST" });
    await expect(scheduler.schedule({ ...input(), turnId: "later-turn" })).rejects.toMatchObject({ code: "TURN_RETRY_NOT_ERRORED" });
    expect(store.listAll()).toEqual([]);
  });

  it.each(["soft", "hard"])("removes a schedule with %s thread deletion and never dispatches it", async (mode) => {
    await scheduler.schedule(input());
    if (mode === "soft") await threads.softDelete(THREAD_ID);
    else await threads.hardDelete(THREAD_ID);
    expect(store.listAll()).toEqual([]);
    await clock.advance(60_000);
    expect(dispatch).toHaveBeenCalledTimes(0);
    expect(clock.timers.size).toBe(0);
  });

  it.each([false, true])("disarms retries through thread deletion, including rescheduling during teardown: %s", async (reschedule) => {
    await scheduler.schedule(input());
    const writer = agentStorageTestWriter(db);
    const workspaces = new WorkspaceRepo(db, writer);
    const git = new FakeGitExecutor();
    const worktreeService = new ProjectWorktreeService(threads, workspaces, writer,
      new GitWorktreeService(workspaces, git, hostRuntime),
      new SandboxWorktreeCleanupPolicy(new WorktreeSafetyService(git, hostRuntime), new GitRepositoryService(workspaces, git), hostRuntime));
    const deletion = new ThreadService(threads, worktreeService, new AttachmentService(), new HandoffStorage(), {
      teardownThread: async () => {
        await scheduler.unschedule(THREAD_ID);
        if (reschedule) await scheduler.schedule(input("2026-10-11T12:02:00.000Z"));
      },
      deletePersistentData: async (_ids, remove) => remove(),
    }, scheduler);
    expect(await deletion.delete(THREAD_ID, false)).toBe(true);
    expect(threads.findById(THREAD_ID)).toBeNull();
    expect(store.listAll()).toEqual([]);
    expect(clock.timers.size).toBe(0);
    await clock.advance(60_000);
    expect(dispatch).toHaveBeenCalledTimes(0);
  });

  it("does not revive a schedule cancelled while its upsert is in flight", async () => {
    const scheduling = scheduler.schedule(input());
    await scheduler.unschedule(THREAD_ID);
    await scheduling;
    expect(store.listAll()).toEqual([]);
    expect(clock.timers.size).toBe(0);
    expect(published).toEqual([{ threadId: THREAD_ID, retry: null }]);
  });

  it("lets cancellation win while a due callback waits for the writer", async () => {
    await scheduler.schedule(input());
    const firing = clock.advance(60_000);
    await scheduler.unschedule(THREAD_ID);
    await firing;
    expect(dispatch).toHaveBeenCalledTimes(0);
    expect(store.listAll()).toEqual([]);
  });

  it("logs retry dispatch failure after clearing the notice and preserves the failed attempt", async () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => logger);
    dispatch.mockRejectedValueOnce(new Error("Provider unavailable"));
    await scheduler.schedule(input());
    await clock.advance(60_000);
    expect(store.listAll()).toEqual([]);
    expect(sink.loadTurn(TURN_ID)?.status).toBe("Errored");
    expect(published.at(-1)).toEqual({ threadId: THREAD_ID, retry: null });
    expect(errorLog).toHaveBeenCalledWith("Scheduled turn retry failed", { threadId: THREAD_ID, error: "Provider unavailable" });
  });
});
