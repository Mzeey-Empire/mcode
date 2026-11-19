import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeEvents from "node:events";
import type { Database } from "bun:sqlite";
import { container } from "tsyringe";
import { logger } from "@mcode/shared";
import { TurnAdmissionError } from "@mcode/shared/turn-admission";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAgentProvider, IProviderRegistry, TurnRequest } from "@mcode/contracts/providers/interfaces";
import { setupContainer } from "../../../../../application/composition/container.js";
import { ApplicationDatabaseWriter } from "../../../../../runtime/persistence/sqlite/application-database-writer.js";
import { WorkerOwnedTurnRuntime } from "../../../execution/worker-owned-turn-runtime.js";
import { AgentService } from "../../../orchestration/agent-service.js";
import { AgentEventPublicationRegistry } from "../../../orchestration/agent-event-publication-registry.js";
import type { ProviderHostPorts } from "@mcode/providers";
import { BackgroundToolSettlementEffect } from "../../../turns/background-tool-settlement-effect.js";
import { CanonicalAgentBoundary } from "../../../canonical/canonical-agent-boundary.js";
import { TurnRecoveryService } from "../../turn-recovery-service.js";
import { sendRecoveryAttempt } from "../../../transport/turn-message-dispatch.js";
import { testModelCatalog } from "../../../__tests__/provider-model-fixture.js";
import { ProviderAvailabilityService } from "../../../../providers/availability/provider-availability-service.js";
import { WorkspaceRepo } from "../../../../projects/persistence/workspace-repo.js";
import { SnapshotRefPins } from "../../../../projects/diffs/snapshots/snapshot-ref-pins.js";
import { ThreadRepo } from "../../../../thread-control/persistence/thread-repo.js";
import type { TurnStopCause } from "@mcode/contracts/compat/agent-model";
import { openWorkerServiceFixture } from "../../../orchestration/__tests__/worker-turn-fixture.js";
import { PlannedRestart } from "../index.js";
import { PlannedRestartStore } from "../planned-restart-store.js";
import { TurnResumeScheduler } from "../../turn-resume-scheduler.js";
import { TurnResumeScheduleStore } from "../../turn-resume-schedule-store.js";
import { MessageRepo } from "../../../conversation/persistence/message-repo.js";
import type { SendMessageCommand } from "../../../turns/turn-admission-dispatch-coordinator.js";

// Native ESM namespaces cannot be spied on; retain real filesystem behavior behind configurable exports.
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof NodeFS>() }));

/** Provider dispatches the tests started. Each outlives its admission and writes to the database a test closes. */
const dispatches = new Set<Promise<unknown>>();

/**
 * `sendRecoveryAttempt` resolves once the turn is admitted, while its provider dispatch keeps running git in the
 * test directory and writing to the database. A test that closed under it would fail a later test's setup.
 */
function sendAttempt(service: Pick<AgentService, "sendMessage">, command: SendMessageCommand): Promise<void> {
  return sendRecoveryAttempt({ sendMessage: (sent) => {
    const dispatch = service.sendMessage(sent);
    dispatches.add(dispatch.catch(() => undefined));
    return dispatch;
  } }, command);
}

async function finishDispatches(): Promise<void> {
  while (dispatches.size > 0) {
    const running = [...dispatches];
    dispatches.clear();
    await Promise.all(running);
  }
}

describe("planned restart runtime", () => {
  let directory: string;
  let opened = false;
  const dispatched = new Set<string>();

  async function boot(): Promise<void> {
    container.reset();
    dispatched.clear();
    await setupContainer(directory);
    opened = true;
    const provider: IAgentProvider = Object.assign(new NodeEvents.EventEmitter(), {
      id: "codex" as const, descriptor: { id: "codex" as const, capabilities: [] },
      supportsCompletion: false, maxInputCharactersPerTurn: 16000,
      sendTurn: async (request: TurnRequest) => { dispatched.add(request.threadId); },
      stopSession: async () => undefined, shutdown: () => undefined,
      listModels: testModelCatalog.listModels, setCanonicalTurnDeliveryFailureHandler: () => undefined,
      fenceCanonicalTurnEvents: async () => undefined, retireCanonicalTurnEvents: async () => undefined,
    });
    container.registerInstance<IProviderRegistry>("IProviderRegistry", {
      resolve: () => provider, resolveAll: () => [provider], shutdown: async () => undefined,
    });
    vi.spyOn(container.resolve(ProviderAvailabilityService), "assertUsable").mockReturnValue(undefined);
    await container.resolve(WorkerOwnedTurnRuntime).whenReady();
    const publication = container.resolve(AgentEventPublicationRegistry);
    publication.bind(() => undefined);
    publication.start();
  }

  async function close(): Promise<void> {
    if (!opened) return;
    await finishDispatches();
    await container.resolve(SnapshotRefPins).drain();
    await container.resolve(WorkerOwnedTurnRuntime).close();
    await container.resolve(ApplicationDatabaseWriter).close();
    container.resolve<Database>("Database").close(true);
    opened = false;
    container.reset();
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  function store(): PlannedRestartStore {
    return new PlannedRestartStore();
  }

  /** Each start is a new process, so it gets its own instance. */
  function nextStart(): PlannedRestart {
    return new PlannedRestart(container.resolve(CanonicalAgentBoundary), container.resolve(TurnRecoveryService),
      container.resolve(MessageRepo));
  }

  async function open(name: string): Promise<void> {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `mcode-planned-${name}-`));
    vi.stubEnv("MCODE_DB_PATH", NodePath.join(directory, "app.sqlite"));
    vi.stubEnv("MCODE_DATA_DIR", directory);
    await boot();
  }

  async function createThreads(count: number): Promise<string[]> {
    const workspace = await container.resolve(WorkspaceRepo).create("restart", directory);
    const threads = [];
    for (let index = 0; index < count; index++) {
      const thread = await container.resolve(ThreadRepo).create(workspace.id, `Restart ${index}`, "direct", "main", true, "codex");
      await container.resolve(AgentService).sendMessage({ threadId: thread.id, content: "Finish the task", permissionMode: "default" });
      threads.push(thread.id);
    }
    return threads;
  }

  async function stopRunning(threadId: string, stop: TurnStopCause = { by: "user" }): Promise<void> {
    const turn = container.resolve(CanonicalAgentBoundary).loadLatestTurn(threadId);
    await container.resolve(AgentService).stopSession(threadId, stop);
    if (turn) await vi.waitFor(() => expect(container.resolve(CanonicalAgentBoundary).loadTurn(turn.id)?.status).not.toBe("Running"));
    await vi.waitFor(() => expect(container.resolve(WorkerOwnedTurnRuntime).owner.current(threadId)).toBeUndefined());
  }

  async function complete(threadId: string): Promise<void> {
    await vi.waitFor(() => expect(dispatched.has(threadId)).toBe(true));
    const workers = container.resolve(WorkerOwnedTurnRuntime);
    const owned = workers.owner.current(threadId)!;
    const { executionId, turnId } = owned.execution;
    const now = new Date().toISOString();
    const eventId = `completed:${executionId}`;
    await container.resolve<ProviderHostPorts>("ProviderHostPorts").events.submit({
      ...owned.execution, deliveryAttempt: 1, batchId: eventId, phase: "running", events: [{
        eventId, sourceProviderId: "codex", sourceIdentities: [], sourceSequence: 1,
        providerTimestamp: now, routing: { ...owned.execution, itemId: eventId },
        payload: { type: "item.recorded", item: {
          id: eventId, threadId, turnId, kind: "system", providerIdentities: [], createdAt: now, updatedAt: now,
          payload: { projection: "providerRuntimeEvent", runtimeEvent: {
            event: { type: "ended", threadId, turnExecutionId: executionId, outcome: "completed" },
          } },
        } },
      }],
    });
    await workers.progress!.waitForTerminalSaves(threadId);
    await vi.waitFor(() => expect(workers.owner.current(threadId)).toBeUndefined());
    dispatched.delete(threadId);
  }

  async function restartWith(count: number): Promise<string[]> {
    const threads = await createThreads(count);
    container.resolve(AgentService).beginShutdown();
    const stop = container.resolve(PlannedRestart);
    stop.beginShutdown();
    await stop.record();
    await container.resolve(AgentService).stopAll();
    await close();
    await boot();
    await container.resolve(TurnRecoveryService).reconcileOnStartup();
    return threads;
  }

  function contents(threadId: string): string[] {
    return container.resolve(MessageRepo).listByThread(threadId, 100).messages.map((message) => message.content);
  }

  it("writes only for a planned stop and consumes the file once", async () => {
    await open("file");
    const [threadId] = await createThreads(1);
    expect(store().read()).toBeNull();
    await container.resolve(PlannedRestart).record();
    const saved = store().read();
    expect(saved?.stoppedAt).toEqual(expect.any(String));
    expect(saved?.wakes).toEqual([]);
    expect(store().read()).toEqual(saved);
    store().clear();
    expect(store().read()).toBeNull();
    if (threadId) await stopRunning(threadId);
  }, 30_000);

  it("leaves a crash interruption for manual Resume without creating a restart file", async () => {
    await open("crash");
    const [threadId] = await createThreads(1);
    await container.resolve(AgentService).stopAll();
    await close();
    await boot();
    await container.resolve(TurnRecoveryService).reconcileOnStartup();
    expect(NodeFS.existsSync(store().filename)).toBe(false);
    const asked: string[] = [];
    await nextStart().continueAtStartup(async (command) => { asked.push(command.threadId); });
    expect(asked).toEqual([]);
    expect(container.resolve(CanonicalAgentBoundary).loadLatestTurn(threadId!)?.ending).toMatchObject({ cause: "app_closed" });
  }, 30_000);

  it.each(['{', '{"version":2,"turns":[],"wakes":[]}', '{"version":1}'])("ignores invalid input %s", async (raw) => {
    await open("invalid");
    NodeFS.writeFileSync(store().filename, raw);
    expect(store().read()).toBeNull();
    expect(NodeFS.existsSync(store().filename)).toBe(true);
  });

  it("resumes app_closed once and skips a thread the user resumed first silently", async () => {
    await open("resume");
    const threads = await restartWith(2);
    const canonical = container.resolve(CanonicalAgentBoundary);
    const service = container.resolve(AgentService);
    const start = nextStart();
    start.load();
    const first = threads[0]!;
    const old = canonical.loadLatestTurn(first)!;
    await container.resolve(TurnRecoveryService).resumeTurn({ threadId: first, turnId: old.id }, (command) => sendAttempt(service, command));
    const asked: string[] = [];
    await start.continueAtStartup(async (command) => { asked.push(command.threadId); await sendAttempt(service, command); });
    await start.continueAtStartup(async () => { throw new Error("repeated"); });
    expect(asked).toEqual([threads[1]]);
    expect(contents(first).filter((text) => text.startsWith("Could not"))).toEqual([]);
    expect(contents(first)).not.toContain("Resumed after Mcode restarted");
    expect(contents(threads[1]!)).toContain("Resumed after Mcode restarted");
    for (const threadId of threads) await stopRunning(threadId);
  }, 30_000);

  it("keeps a loaded resume through an exit before continuation", async () => {
    await open("unbound");
    const [threadId] = await restartWith(1);
    nextStart().load();
    await close();
    await boot();
    const asked: string[] = [];
    await nextStart().continueAtStartup(async (command) => { asked.push(command.threadId); });
    expect(asked).toEqual([threadId]);
  }, 30_000);

  it("ignores and logs a directory at the restart path", async () => {
    await open("directory");
    const warning = vi.spyOn(logger, "warn");
    NodeFS.mkdirSync(store().filename);
    const read = vi.spyOn(NodeFS, "readFileSync");
    const asked: string[] = [];
    await nextStart().continueAtStartup(async (command) => { asked.push(command.threadId); });
    expect(asked).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls.some(([message]) => message.includes("restart"))).toBe(true);
  }, 30_000);

  it.each(["EBUSY", "EPERM", "EACCES"])("reads a restart record after a transient %s", async (code) => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-store-"));
    const restartStore = new PlannedRestartStore(NodePath.join(directory, "app.sqlite"));
    const record = { version: 1, resumes: [], wakes: [] } as const;
    NodeFS.writeFileSync(restartStore.filename, JSON.stringify(record));
    const read = vi.spyOn(NodeFS, "readFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("Locked"), { code });
    });
    expect(restartStore.read()).toEqual(record);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("gives up after three locked reads with one warning", async () => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-store-"));
    const restartStore = new PlannedRestartStore(NodePath.join(directory, "app.sqlite"));
    const read = vi.spyOn(NodeFS, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("Locked"), { code: "EBUSY" });
    });
    const warning = vi.spyOn(logger, "warn");
    expect(restartStore.read()).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("leaves an overdue startup resume interrupted by a failed refresh for manual Resume", async () => {
    let fixture = await openWorkerServiceFixture("claude");
    try {
      const threadId = fixture.thread.id;
      await fixture.service.sendMessage({ threadId, content: "Finish the task", provider: "claude",
        model: "claude-sonnet-4-6", permissionMode: "default" });
      const limited = fixture.sent[0]!;
      const route = { threadId, turnExecutionId: limited.turnExecutionId };
      await fixture.emit({ type: "error", ...route, error: "Usage limit", failure: { kind: "usage_limit" } });
      await fixture.emit({ type: "ended", ...route });
      await fixture.workers.progress!.waitForTerminalSaves(threadId);
      const now = new Date().toISOString();
      await container.resolve(TurnResumeScheduleStore).upsert({ threadId, turnId: limited.turnId,
        executionId: limited.turnExecutionId, runAt: now, createdAt: now });
      const stop = container.resolve(PlannedRestart);
      stop.beginShutdown();
      await stop.record();
      const fixtureDirectory = fixture.directory;
      await fixture.close({ keepDirectory: true });
      fixture = await openWorkerServiceFixture("claude", { directory: fixtureDirectory, threadId });
      await container.resolve(TurnRecoveryService).reconcileOnStartup();
      const scheduler = new TurnResumeScheduler(container.resolve(TurnResumeScheduleStore),
        container.resolve(TurnRecoveryService), (command) => sendAttempt(fixture.service, command), () => undefined);
      const failure = new Error("refresh write refused");
      const write = vi.spyOn(PlannedRestartStore.prototype, "record").mockImplementationOnce(() => { throw failure; });
      try {
        // This is the startup admission boundary: a failed load must prevent even overdue resumes from starting.
        await expect((async () => {
          container.resolve(PlannedRestart).load();
          await scheduler.start();
        })()).rejects.toThrow(failure);
      } finally {
        write.mockRestore();
        await scheduler.shutdown();
      }
      await finishDispatches();
      await fixture.service.stopAll();
      await fixture.close({ keepDirectory: true });
      fixture = await openWorkerServiceFixture("claude", { directory: fixtureDirectory, threadId });
      await container.resolve(TurnRecoveryService).reconcileOnStartup();
      const asked: string[] = [];
      await container.resolve(PlannedRestart).continueAtStartup(async (command) => { asked.push(command.threadId); });
      expect(asked).toEqual([]);
    } finally {
      await finishDispatches();
      await fixture.close();
    }
  }, 30_000);

  it.each(["cancelled", "busy"])("drops a %s admission without a failure notice", async (reason) => {
    await open(reason);
    const [threadId] = await restartWith(1);
    const start = nextStart();
    await start.continueAtStartup(async () => {
      if (reason === "cancelled") await start.cancel(threadId!);
      if (reason === "busy") throw new TurnAdmissionError("busy", "Occupied");
      throw new Error("cancelled admission");
    });
    expect(contents(threadId!).filter((text) => text.startsWith("Could not"))).toEqual([]);
  }, 30_000);

  it("replaces the resumed notice when the fallback fails after the resume was reported", async () => {
    await open("late-failure");
    const [threadId] = await restartWith(1);
    let reportLateFailure: ((error: unknown) => void) | undefined;
    const recovery: Pick<TurnRecoveryService, "resumeTurn" | "wakeParent"> = {
      resumeTurn: async (_turn, _dispatch, context) => {
        reportLateFailure = context?.onLateFailure;
        return { turnId: "native-attempt", mode: "native-session" };
      },
      wakeParent: async () => { throw new Error("not a wake"); },
    };
    const start = new PlannedRestart(container.resolve(CanonicalAgentBoundary), recovery,
      container.resolve(MessageRepo));
    await start.continueAtStartup(async () => {});
    expect(contents(threadId!)).toContain("Resumed after Mcode restarted");
    reportLateFailure?.(new Error("seeded fallback failed"));
    await vi.waitFor(() => expect(contents(threadId!)).toContain("Could not resume after Mcode restarted"));
    expect(contents(threadId!)).not.toContain("Resumed after Mcode restarted");
  }, 30_000);

  it("keeps the failure when the fallback fails before the resume is reported", async () => {
    await open("early-late-failure");
    const [threadId] = await restartWith(1);
    const recovery: Pick<TurnRecoveryService, "resumeTurn" | "wakeParent"> = {
      resumeTurn: async (_turn, _dispatch, context) => {
        context?.onLateFailure?.(new Error("seeded fallback failed"));
        return { turnId: "native-attempt", mode: "native-session" };
      },
      wakeParent: async () => { throw new Error("not a wake"); },
    };
    const start = new PlannedRestart(container.resolve(CanonicalAgentBoundary), recovery,
      container.resolve(MessageRepo));
    await start.continueAtStartup(async () => {});
    await vi.waitFor(() => expect(contents(threadId!)).toContain("Could not resume after Mcode restarted"));
    expect(contents(threadId!)).not.toContain("Resumed after Mcode restarted");
  }, 30_000);

  it("keeps a resume pending while its ended native attempt hands over to the seeded fallback", async () => {
    await open("fallback-handover");
    const [threadId] = await restartWith(1);
    let duringHandover: boolean | undefined;
    let start: PlannedRestart | undefined;
    const recovery: Pick<TurnRecoveryService, "resumeTurn" | "wakeParent"> = {
      resumeTurn: async (_turn, dispatch) => {
        await dispatch({ threadId: threadId!, content: "", permissionMode: "default", sourceTurnId: "native-attempt" });
        duringHandover = start?.hasPendingResume(threadId!, "native-attempt");
        return { turnId: "seeded-attempt", mode: "seeded-session" };
      },
      wakeParent: async () => { throw new Error("not a wake"); },
    };
    start = new PlannedRestart(container.resolve(CanonicalAgentBoundary), recovery, container.resolve(MessageRepo));
    await start.continueAtStartup(async (command) => { command.admissionGuard?.(); });
    expect(duringHandover).toBe(true);
    expect(start.hasPendingResume(threadId!, "native-attempt")).toBe(false);
  }, 30_000);

  it("drops failed starts with one diagnostic notice and never retries", async () => {
    await open("failure");
    const [threadId] = await restartWith(1);
    const start = nextStart();
    await start.continueAtStartup(async () => { throw new Error("provider unavailable"); });
    const retried: string[] = [];
    await start.continueAtStartup(async (command) => { retried.push(command.threadId); });
    await nextStart().continueAtStartup(async (command) => { retried.push(command.threadId); });
    expect(retried).toEqual([]);
    expect(contents(threadId!).filter((text) => text.startsWith("Could not"))).toEqual(["Could not resume after Mcode restarted"]);
    const notice = container.resolve(MessageRepo).listByThread(threadId!, 100).messages.find((message) => message.content.startsWith("Could not"));
    expect(notice?.systemNotice?.kind).toBe("diagnostic");
  }, 30_000);

  it("publishes each written notice with its saved identity so an open thread shows it live", async () => {
    await open("publish");
    const [threadId] = await restartWith(1);
    const canonical = container.resolve(CanonicalAgentBoundary);
    const progress = container.resolve(WorkerOwnedTurnRuntime).progress!;
    canonical.bindAcceptedSynthesizedPublications((thread, events) => progress.acceptSynthesizedPublications(thread, events));
    const publish = vi.spyOn(canonical, "recordSynthesizedPublications");
    await nextStart().continueAtStartup(async () => { throw new Error("provider unavailable"); });
    const saved = container.resolve(MessageRepo).listByThread(threadId!, 100).messages.find((message) => message.content.startsWith("Could not"));
    expect(publish).toHaveBeenCalledWith(threadId, [expect.objectContaining({
      type: "system", messageId: saved?.id, sequence: saved?.sequence, message: "Could not resume after Mcode restarted",
    })]);
    expect(publish.mock.results.every((result) => result.type === "return")).toBe(true);
  }, 30_000);

  it("limits starts to four and carries queued work through another shutdown", async () => {
    await open("queue");
    const threads = await restartWith(5);
    const previous = threads.map((threadId) => container.resolve(CanonicalAgentBoundary).loadLatestTurn(threadId)!);
    const start = nextStart();
    const service = container.resolve(AgentService);
    const asked: Array<{ threadId: string; turnId: string | undefined; executionId: string }> = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const running = start.continueAtStartup(async (command) => {
      await sendAttempt(service, command);
      const owned = container.resolve(WorkerOwnedTurnRuntime).owner.current(command.threadId)!;
      await container.resolve(WorkerOwnedTurnRuntime).progress!.waitForSaved(command.threadId);
      asked.push({ threadId: command.threadId, turnId: command.sourceTurnId, executionId: owned.execution.executionId });
      await held;
    });
    await vi.waitFor(() => expect(asked).toHaveLength(4));
    start.beginShutdown();
    service.beginShutdown();
    await start.record();
    release();
    await running;
    for (const attempt of asked) {
      const old = previous.find((turn) => turn.threadId === attempt.threadId)!;
      const savedAttempt = container.resolve(CanonicalAgentBoundary).loadLatestTurn(attempt.threadId)!;
      expect(attempt.turnId).toBe(savedAttempt.id);
      expect(attempt.executionId).toBe(savedAttempt.executionId);
      expect(attempt.turnId).not.toBe(old.id);
      expect(attempt.executionId).not.toBe(old.executionId);
    }
    expect(threads.flatMap(contents).filter((text) => text.startsWith("Could not"))).toEqual([]);
    await expect(service.sendMessage({ threadId: threads[0]!, content: "late" })).rejects.toThrow();
    const queued = threads.find((threadId) => !asked.some((attempt) => attempt.threadId === threadId));
    const following: string[] = [];
    await nextStart().continueAtStartup(async (command) => { following.push(command.threadId); });
    expect(following).toEqual([queued]);
  }, 30_000);

  it("does not bring back work this start dropped when it stops again", async () => {
    await open("second-stop");
    const [failed, cancelled, waiting] = await restartWith(3);
    const start = nextStart();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const running = start.continueAtStartup(async (command) => {
      if (command.threadId === failed) throw new Error("provider unavailable");
      if (command.threadId === cancelled) {
        await start.cancel(cancelled);
        throw new Error("cancelled admission");
      }
      await held;
    });
    await vi.waitFor(() => expect([failed!, cancelled!].some((threadId) => start.isPending(threadId))).toBe(false));
    start.beginShutdown();
    await start.record();
    release();
    await running;
    const following: string[] = [];
    await nextStart().continueAtStartup(async (command) => { following.push(command.threadId); });
    expect(following).toEqual([waiting]);
  }, 30_000);

  it("leaves an earlier crash interruption for manual Resume after a later planned stop", async () => {
    await open("crash-then-stop");
    await createThreads(1);
    await container.resolve(AgentService).stopAll();
    await close();
    await boot();
    await container.resolve(TurnRecoveryService).reconcileOnStartup();
    const stop = nextStart();
    stop.beginShutdown();
    await stop.record();
    const asked: string[] = [];
    await nextStart().continueAtStartup(async (command) => { asked.push(command.threadId); });
    expect(asked).toEqual([]);
  }, 30_000);

  it("leaves work started after the planned stop to manual Resume when a crash interrupts it", async () => {
    await open("started-after-stop");
    const stop = nextStart();
    stop.beginShutdown();
    await stop.record();
    nextStart().load();
    await createThreads(1);
    await container.resolve(AgentService).stopAll();
    await close();
    await boot();
    await container.resolve(TurnRecoveryService).reconcileOnStartup();
    const asked: string[] = [];
    await nextStart().continueAtStartup(async (command) => { asked.push(command.threadId); });
    expect(asked).toEqual([]);
  }, 30_000);

  it.each([0, 1])("resumes work committed %i ms at or after the stop", async (offset) => {
    await open("in-flight-stop");
    const [threadId] = await createThreads(1);
    const turn = container.resolve(CanonicalAgentBoundary).loadLatestTurn(threadId!)!;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(new Date(turn.createdAt).getTime() - offset));
    const stop = nextStart();
    stop.beginShutdown();
    await stop.record();
    vi.useRealTimers();
    await container.resolve(AgentService).stopAll();
    await close();
    await boot();
    await container.resolve(TurnRecoveryService).reconcileOnStartup();
    const asked: string[] = [];
    await nextStart().continueAtStartup(async (command) => { asked.push(command.threadId); });
    expect(asked).toEqual([threadId]);
  }, 30_000);

  it("starts nothing when the restart file cannot be removed, so nothing can repeat", async () => {
    await open("locked");
    await restartWith(1);
    vi.spyOn(PlannedRestartStore.prototype, "clear").mockReturnValue(false);
    const asked: string[] = [];
    await nextStart().continueAtStartup(async (command) => { asked.push(command.threadId); });
    expect(asked).toEqual([]);
  }, 30_000);

  it("rechecks the admission guard after an ordinary turn finishes during wake preparation", async () => {
    await open("race");
    const [threadId] = await createThreads(1);
    await complete(threadId!);
    const anchor = container.resolve(CanonicalAgentBoundary).loadLatestTurn(threadId!)!;
    store().record({ version: 1, stoppedAt: new Date().toISOString(), resumes: [],
      wakes: [{ threadId: threadId!, anchorTurnId: anchor.id }] });
    const service = container.resolve(AgentService);
    let hidden = 0;
    await nextStart().continueAtStartup(async (command) => {
      await service.sendMessage({ threadId: threadId!, content: "ordinary competing work" });
      await complete(threadId!);
      await sendAttempt(service, command);
      hidden += 1;
    });
    expect(hidden).toBe(0);
    expect(contents(threadId!).filter((text) => text.startsWith("Could not"))).toEqual([]);
  }, 30_000);

  it("refuses a seeded fallback after a newer turn finishes", async () => {
    await open("fallback-race");
    const [threadId] = await restartWith(1);
    const service = container.resolve(AgentService);
    let attempts = 0;
    const recovery: Pick<TurnRecoveryService, "resumeTurn" | "wakeParent"> = {
      resumeTurn: async (_turn, dispatch) => {
        const native = { threadId: threadId!, content: "native", sourceTurnId: "native-attempt" };
        await dispatch(native);
        await complete(threadId!);
        await service.sendMessage({ threadId: threadId!, content: "newer" });
        await complete(threadId!);
        await dispatch({ threadId: threadId!, content: "fallback", sourceTurnId: "fallback-attempt" });
        return { turnId: "fallback-attempt", mode: "seeded-session" };
      },
      wakeParent: async () => { throw new Error("not a wake"); },
    };
    const start = new PlannedRestart(container.resolve(CanonicalAgentBoundary), recovery, container.resolve(MessageRepo));
    await start.continueAtStartup(async (command) => { await sendAttempt(service, command); attempts += 1; });
    expect(attempts).toBe(1);
    expect(contents(threadId!).filter((text) => text.startsWith("Could not"))).toEqual([]);
  }, 30_000);

  it("skips moved-on and non app_closed turns without a notice", async () => {
    await open("stale");
    const threads = await createThreads(2);
    await container.resolve(PlannedRestart).record();
    for (const threadId of threads) await stopRunning(threadId);
    const asked: string[] = [];
    await nextStart().continueAtStartup(async (command) => { asked.push(command.threadId); });
    expect(asked).toEqual([]);
    expect(threads.flatMap(contents).filter((text) => text.startsWith("Could not"))).toEqual([]);
  }, 30_000);

  it("wakes only a current idle anchor and drops failed wakes with one notice", async () => {
    await open("wake");
    const threads = await createThreads(3);
    const canonical = container.resolve(CanonicalAgentBoundary);
    const wakes = threads.map((threadId) => ({ threadId, anchorTurnId: canonical.loadLatestTurn(threadId)!.id }));
    await complete(threads[0]!);
    await stopRunning(threads[1]!);
    // A newer finished turn also leaves the thread idle and completed, so only the saved anchor tells them apart.
    await container.resolve(AgentService).sendMessage({ threadId: threads[1]!, content: "moved on" });
    await complete(threads[1]!);
    await store().record({ version: 1, stoppedAt: new Date().toISOString(), resumes: [], wakes });
    const asked: string[] = [];
    const start = nextStart();
    await start.continueAtStartup(async (command) => { asked.push(command.threadId); throw new Error("unavailable"); });
    await start.continueAtStartup(async () => { throw new Error("retry"); });
    expect(asked).toEqual([threads[0]]);
    expect(contents(threads[0]!).filter((text) => text.startsWith("Could not"))).toEqual(["Could not wake after Mcode restarted"]);
    expect(contents(threads[0]!)).not.toContain("Woke after Mcode restarted");
    expect(threads.slice(1).flatMap(contents).filter((text) => text.startsWith("Could not"))).toEqual([]);
    await stopRunning(threads[2]!);
  }, 30_000);
});


describe("planned restart capture of held work", () => {
  it("aborts a failed refresh before settlement and preserves the wake for the following start", async () => {
    let fixture = await openWorkerServiceFixture("claude");
    try {
      await fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Review in the background",
        provider: "claude", model: "claude-sonnet-4-6", permissionMode: "default" });
      const turn = fixture.sent[0]!;
      const route = { threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId };
      await fixture.emit({ type: "toolUse", ...route, toolCallId: "review", toolName: "Agent", toolInput: { description: "Review" } });
      await fixture.emit({ type: "toolBackgrounded", ...route, toolCallId: "review", kind: "subagent", label: "Review" });
      const restart = container.resolve(PlannedRestart);
      restart.beginShutdown();
      await restart.record();
      await endWork(fixture, "completed");
      await fixture.workers.progress!.waitForTerminalSaves(fixture.thread.id);
      const directory = fixture.directory;
      const threadId = fixture.thread.id;
      await fixture.close({ keepDirectory: true });
      fixture = await openWorkerServiceFixture("claude", { directory, threadId });
      const store = new PlannedRestartStore();
      const original = store.read();
      const failure = new Error("refresh write refused");
      vi.spyOn(PlannedRestartStore.prototype, "record").mockImplementationOnce(() => { throw failure; });
      try {
        expect(() => container.resolve(PlannedRestart).load(fixture.canonical.listHeldBackgroundToolCalls())).toThrow(failure);
        expect(store.read()).toEqual(original);
      } finally {
        vi.restoreAllMocks();
      }
      await fixture.close({ keepDirectory: true });
      fixture = await openWorkerServiceFixture("claude", { directory, threadId });
      await container.resolve(TurnRecoveryService).reconcileOnStartup();
      const settlement = container.resolve(BackgroundToolSettlementEffect);
      settlement.bindAcceptedProgress(fixture.workers.progress!);
      const start = container.resolve(PlannedRestart);
      start.load(fixture.canonical.listHeldBackgroundToolCalls());
      await settlement.settleOrphansAtStartup();
      const asked: string[] = [];
      await start.continueAtStartup(async (command) => { asked.push(command.threadId); });
      expect(asked).toEqual([threadId]);
    } finally {
      await finishDispatches();
      await fixture.close();
    }
  }, 30_000);

  async function endWork(fixture: Awaited<ReturnType<typeof openWorkerServiceFixture>>, status: string): Promise<void> {
    const turn = fixture.sent[0]!;
    const route = { threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId };
    if (status === "completed" || status === "crash") {
      await fixture.emit({ type: "turnComplete", ...route, reason: "end_turn",
        costUsd: null, tokensIn: 1, tokensOut: 1, providerId: "claude" });
      await fixture.emit({ type: "ended", ...route });
    } else if (status === "running") {
      vi.mocked(fixture.provider.stopSession).mockImplementation(async () => {
        await fixture.emit({ type: "ended", ...route, outcome: "interrupted" });
      });
      await fixture.service.stopAll();
    } else if (status === "usage_limit") {
      await fixture.emit({ type: "error", ...route, error: "Usage limit", failure: { kind: "usage_limit" } });
      await fixture.emit({ type: "ended", ...route });
    } else {
      await fixture.stop();
    }
  }

  it.each(["running", "completed", "usage_limit", "cancelled", "crash"] as const)(
    "decides from saved work after shutdown begins: %s", async (status) => {
      let fixture = await openWorkerServiceFixture("claude");
      try {
        await fixture.service.sendMessage({ threadId: fixture.thread.id, content: "Review in the background",
          provider: "claude", model: "claude-sonnet-4-6", permissionMode: "default" });
        const turn = fixture.sent[0]!;
        const route = { threadId: fixture.thread.id, turnExecutionId: turn.turnExecutionId };
        await fixture.emit({ type: "toolUse", ...route, toolCallId: "review", toolName: "Agent", toolInput: { description: "Review" } });
        await fixture.emit({ type: "toolBackgrounded", ...route, toolCallId: "review", kind: "subagent", label: "Review" });
        const restart = container.resolve(PlannedRestart);
        if (status !== "crash") {
          fixture.service.beginShutdown();
          restart.beginShutdown();
          await restart.record();
        }
        await endWork(fixture, status);
        await fixture.workers.progress!.waitForTerminalSaves(fixture.thread.id);
        await fixture.workers.progress!.waitForSaved(fixture.thread.id);
        if (status === "running") expect(restart.hasPendingResume(fixture.thread.id, turn.turnId)).toBe(true);
        const directory = fixture.directory;
        const threadId = fixture.thread.id;
        await fixture.close({ keepDirectory: true });
        fixture = await openWorkerServiceFixture("claude", { directory, threadId });
        await container.resolve(TurnRecoveryService).reconcileOnStartup();
        const settlement = container.resolve(BackgroundToolSettlementEffect);
        settlement.bindAcceptedProgress(fixture.workers.progress!);
        const start = container.resolve(PlannedRestart);
        start.load(fixture.canonical.listHeldBackgroundToolCalls());
        await settlement.settleOrphansAtStartup();
        const asked: SendMessageCommand[] = [];
        if (status === "completed") {
          // The settled calls are gone by the next launch; the rewritten wakes must survive without them.
          await fixture.close({ keepDirectory: true });
          fixture = await openWorkerServiceFixture("claude", { directory, threadId });
        }
        const following = status === "completed"
          ? new PlannedRestart(fixture.canonical, container.resolve(TurnRecoveryService), fixture.messages) : start;
        await following.continueAtStartup(async (command) => { asked.push(command); });
        expect(asked.map((command) => command.threadId))
          .toEqual(status === "running" || status === "completed" ? [threadId] : []);
        expect(asked.every((command) => command.internalUserMessage === true)).toBe(true);
      } finally {
        await finishDispatches();
        await fixture.close();
      }
    }, 30_000);
});

