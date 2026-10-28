import "reflect-metadata";
import { startupEnvironmentFixture } from "../../../projects/environment/testing/startup-environment-fixture.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as NodeEvents from "node:events";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { AttachmentMeta } from "@mcode/contracts/models/attachment";
import type { IAgentProvider, IProviderRegistry, ProviderId, ProviderTurnDiffUpdate } from "@mcode/contracts/providers/interfaces";
import type { PreviewAnnotationBundle } from "@mcode/contracts/models/browser-preview";
import type { NativePlanQuestionBatch, PlanQuestionHandler } from "@mcode/contracts/models/plan-questions";
import type { Database } from "bun:sqlite";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases, registerAgentStorageTestProducer } from "../../__tests__/agent-storage-fixture.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { CanonicalAcceptedProgress } from "../../canonical/canonical-accepted-progress.js";
import { TurnSnapshotRepo as RealTurnSnapshotRepo } from "../../turns/persistence/turn-snapshot-repo.js";
import { PlanQuestionAnswersRepo as RealPlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { ThreadRepo as RealThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo as RealWorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo as RealMessageRepo } from "../../conversation/persistence/message-repo.js";
import { ToolCallRecordRepo as RealToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo as RealThoughtSegmentRepo } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo as RealHookExecutionRepo } from "../../events/persistence/hook-execution-repo.js";
import { AgentService } from "../agent-service.js";
import { PlanTurnService } from "../../planning/plan-turn-service.js";
import { PlanQuestionService } from "../../planning/plan-question-service.js";
import { PlanRepo } from "../../planning/persistence/plan-repo.js";
import { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../agent-turn-command-port.js";
import { createAgentServiceForTest, drainAgentServicePersistenceForTest, startAgentServiceIngressForTest, startProviderTurnForTest, waitForAgentServiceIngressForTest, wrapProviderEmitterForRuntimeEvents, waitForAgentServiceWorkersForTest } from "./agent-service-test-harness.js";
import { createCanonicalAgentBoundaryStub } from "../../canonical/__tests__/canonical-agent-boundary-stub.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { broadcast } from "../../../../application/transport/push.js";
import type { MessageRepo } from "../../conversation/persistence/message-repo.js";
import type { GitService } from "../../../projects/index.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import type { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { ThreadControlMutationReservationService } from "../../../thread-control/index.js";
import { publishParentProviderEvent } from "../../events/provider-event-publication.js";
import { SubagentRosterService } from "../../collaboration/subagent-roster-service.js";
import { routeAgentRpc } from "../../transport/agent-rpc.js";
import { WorkspaceEnvironmentService } from "../../../projects/environment/workspace-environment-service.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn(), subscribedThreadIds: () => new Set<string>() }));

const THREAD_ID = "thread-cleanup-test";

function activeExecutionId(service: AgentService, threadId = THREAD_ID): string {
  const executionId = service.runtimeAccess().runtimeSnapshots()
    .find((snapshot) => snapshot.threadId === threadId)?.turnExecutionId;
  if (!executionId) throw new Error("Expected an active turn execution identity");
  return executionId;
}

async function startProviderTurn(service: AgentService): Promise<string> {
  return startProviderTurnForTest(service, THREAD_ID);
}

function makePreviewAnnotationBundle(): Extract<PreviewAnnotationBundle, { schemaVersion: 1 }> {
  const capture = {
    schemaVersion: 2 as const,
    pageUrl: "https://www.google.com/",
    pageTitle: "Google",
    capturedAt: "2026-07-02T00:00:00.000Z",
    captureKind: "element" as const,
    selectorHint: "html",
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    layoutViewport: { width: 1280, height: 720 },
  };

  return {
    schemaVersion: 1,
    annotations: [
      {
        id: "550e8400-e29b-41d4-a716-446655440001",
        displayNumber: 1,
        pageIdentity: "https://www.google.com/",
        pageContext: capture,
        targetContext: {
          label: "html",
          selectorHint: "html",
          bounds: { x: 0, y: 0, width: 1280, height: 720 },
        },
        note: "Move the header down.",
        snapshot: {
          id: "annotation-shot-1",
          name: "preview.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          sourcePath: "C:/tmp/annotation-shot-1.png",
          capture,
        },
      },
    ],
  };
}

async function setupEnvironmentForTest(enabled: boolean, db: Database, cwd: string, workspaceId: string, threads: RealThreadRepo) {
  if (!enabled) return undefined;
  const environment = startupEnvironmentFixture({
    mcodeDir: cwd, database: db, databaseWriter: agentStorageTestWriter(db), threads, platform: "linux",
  });
  await environment.save({ workspaceId, sourceRevision: null,
    document: { version: "0.1.0", actions: [{ id: "setup", name: "Setup", command: { default: "bun run setup" }, runOnStartup: true }] } });
  return environment;
}

/**
 * Build a minimal AgentService wired to a fake EventEmitter-based provider.
 * The returned `providerEmitter` lets the test fire events as if the SDK
 * produced them, exercising the handler registered in `init()`.
 */
async function buildService(
  cwd = process.cwd(),
  mutationReservations = new ThreadControlMutationReservationService(),
  providers?: IAgentProvider[],
  canonicalTurns = false,
  setup = false,
): Promise<{
  service: AgentService;
  providerEmitter: NodeEvents.EventEmitter;
  attachmentService: AttachmentService;
  messageRepo: MessageRepo;
  planQuestionAnswersRepo: RealPlanQuestionAnswersRepo;
  memoryPressureService: { markActive: ReturnType<typeof vi.fn>; markIdle: ReturnType<typeof vi.fn> };
  snapshotService: { captureRef: ReturnType<typeof vi.fn> };
  turnSnapshotRepo: RealTurnSnapshotRepo;
  toolCallRecordRepo: RealToolCallRecordRepo;
  canonicalSink: CanonicalAgentBoundary;
  threadRepo: RealThreadRepo;
  db: Database;
  providerRegistry: IProviderRegistry;
  environment: WorkspaceEnvironmentService | undefined;
  threadService: ThreadService;
}> {
  const db = openAgentStorageTestDatabase();
  const writer = agentStorageTestWriter(db);
  const workspaceRepo = new RealWorkspaceRepo(db, writer);
  const threadRepo = new RealThreadRepo(db, writer);
  const messageRepo = new RealMessageRepo(db, writer);
  const workspace = await workspaceRepo.create("Test", cwd);
  const thread = await threadRepo.create(workspace.id, "Test thread", "direct", "main", true, "claude");
  db.prepare("UPDATE threads SET id = ? WHERE id = ?").run(THREAD_ID, thread.id);
  const providerEmitter = wrapProviderEmitterForRuntimeEvents(Object.assign(new NodeEvents.EventEmitter(), {
    id: "claude" as ProviderId,
  }));
  // sendTurn() is called on the resolved provider
  (providerEmitter as any).sendTurn = vi.fn(() => Promise.resolve());
  (providerEmitter as any).stopSession = vi.fn(() => Promise.resolve());

  const gitService = {
    resolveWorkingDir: vi.fn(() => cwd),
    listWorktrees: vi.fn(() => []),
  } as unknown as GitService;

  const attachmentService = {
    persist: vi.fn((_threadId: string, attachments: AttachmentMeta[]) =>
      Promise.resolve({
        stored: attachments.map((att) => ({
          id: att.id,
          name: att.name,
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes,
        })),
        persisted: attachments,
      }),
    ),
    removeStoredAttachments: vi.fn(async () => undefined),
  } as unknown as AttachmentService;

  // The provider must be an EventEmitter so init() can subscribe via
  // provider.on("event", ...) and tests can fire events via providerEmitter.emit()
  const registeredProviders = providers ?? [providerEmitter as unknown as IAgentProvider];
  const providerRegistry = {
    resolve: vi.fn((providerId: ProviderId) => (
      registeredProviders.find((provider) => provider.id === providerId) ?? providerEmitter
    )),
    resolveAll: vi.fn(() => registeredProviders),
    shutdown: vi.fn(),
  } as unknown as IProviderRegistry;

  const threadService = {
    create: vi.fn(),
  } as unknown as ThreadService;

  const toolCallRecordRepo = new RealToolCallRecordRepo(db, writer);
  const turnSnapshotRepo = new RealTurnSnapshotRepo(db, writer);
  const thoughtSegmentRepo = new RealThoughtSegmentRepo(db, writer);
  const hookExecutionRepo = new RealHookExecutionRepo(db, writer);

  const snapshotService = {
    captureRef: vi.fn(() => Promise.resolve("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")),
    getFilesChanged: vi.fn(() => Promise.resolve([])),
  } as unknown as SnapshotService;

  const memoryPressureService = {
    markActive: vi.fn(),
    markIdle: vi.fn(),
    onPressureChange: vi.fn(),
  } as unknown as MemoryPressureService;

  const settingsService = {
    get: vi.fn(() => ({
      model: { defaults: { fallbackId: undefined } },
      agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
      provider: { enabled: {}, cli: {} },
    })),
    on: vi.fn(),
  } as unknown as SettingsService;

  const availability = {
    assertUsable: vi.fn(),
  } as unknown as ProviderAvailabilityService;

  const planQuestionAnswersRepo = new RealPlanQuestionAnswersRepo(db, writer);
  const canonicalWriter = new CanonicalAgentWriterClient(writer);
  const canonicalSink = canonicalTurns
    ? new CanonicalAgentBoundary(db, writer, canonicalWriter, () => undefined)
    : createCanonicalAgentBoundaryStub(db, writer);
  const progress = canonicalTurns ? new CanonicalAcceptedProgress(canonicalSink, canonicalWriter) : undefined;
  const environment = await setupEnvironmentForTest(setup, db, cwd, workspace.id, threadRepo);
  if (progress) {
    canonicalSink.bindAcceptedSynthesizedPublications((threadId, events) => progress.acceptSynthesizedPublications(threadId, events));
  }

  const service = createAgentServiceForTest(
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    attachmentService,
    providerRegistry,
    threadService,
    turnSnapshotRepo,
    snapshotService,
    db,
    memoryPressureService as MemoryPressureService,
    settingsService,
    availability,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      new NarrativeStore(
        messageRepo,
        toolCallRecordRepo,
        thoughtSegmentRepo,
        hookExecutionRepo,
      ),
      new ParentAssistantTextCheckpointService(db, agentStorageTestWriter(db)),
      undefined,
      undefined,
      mutationReservations,
      canonicalSink,
      environment,
      undefined,
  );
  await waitForAgentServiceWorkersForTest(service);
  if (progress) registerAgentStorageTestProducer(db, async () => {
    await drainAgentServicePersistenceForTest(service);
    await progress.close();
  });

  return {
    service,
    providerEmitter,
    attachmentService,
    messageRepo,
    planQuestionAnswersRepo,
    memoryPressureService: memoryPressureService as MemoryPressureService & { markActive: ReturnType<typeof vi.fn>; markIdle: ReturnType<typeof vi.fn> },
    snapshotService: snapshotService as SnapshotService & { captureRef: ReturnType<typeof vi.fn> },
    turnSnapshotRepo,
    toolCallRecordRepo,
    canonicalSink,
    threadRepo,
    db,
    providerRegistry,
    environment,
    threadService,
  };
}

afterEach(closeAgentStorageTestDatabases);

describe("AgentService turn cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards a generic runtime event", async () => {
    const { service, providerEmitter } = await buildService();
    const publish = vi.fn();
    startAgentServiceIngressForTest(service, publish);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const executionId = activeExecutionId(service);
    publish.mockClear();
    const event = {
      type: AgentEventType.TextDelta,
      delta: "Worker output",
      isFinalResponse: true,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    } satisfies AgentEvent;
    providerEmitter.emit("event", event);
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: AgentEventType.TextDelta, threadId: THREAD_ID, turnExecutionId: executionId, delta: "Worker output",
    }));
  });

  it("removes thread from activeThreadIds after committed Ended", async () => {
    const { service, providerEmitter, memoryPressureService } = await buildService();
    startAgentServiceIngressForTest(service);

    // sendMessage adds thread to activeSessionIds and emits TurnStarted
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
    const executionId = activeExecutionId(service);

    // Fire TurnComplete through the provider
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 100,
      tokensOut: 50,
      contextWindow: 200000,
      totalProcessedTokens: 150,
      providerId: "claude",
    } satisfies AgentEvent);
    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
    providerEmitter.emit("event", { type: AgentEventType.Ended, threadId: THREAD_ID, turnExecutionId: executionId });
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    // Thread should no longer be active
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markIdle).toHaveBeenCalled();
  });

  it("releases a stopped queued dispatch so the next FIFO Turn can reserve the active slot", async () => {
    const { service, messageRepo } = await buildService();
    await messageRepo.create(THREAD_ID, "user", "First queued work", 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "queued-message-1");
    await messageRepo.create(THREAD_ID, "user", "Second queued work", 2, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "queued-message-2");

    const first = await service.dispatchQueuedAutomaticTurn({
      threadId: THREAD_ID,
      messageId: "queued-message-1",
      content: "First queued work",
      displayContent: "First queued work",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      attachments: [],
      persistedAttachments: [],
      mentions: [],
      provider: "claude",
    });
    await expect(service.stopSession(THREAD_ID, { by: "user" })).resolves.toMatchObject({ status: "cancelled" });
    await expect(first.completion).resolves.toBeUndefined();

    await expect(service.dispatchQueuedAutomaticTurn({
      threadId: THREAD_ID,
      messageId: "queued-message-2",
      content: "Second queued work",
      displayContent: "Second queued work",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      attachments: [],
      persistedAttachments: [],
      mentions: [],
      provider: "claude",
    })).resolves.toMatchObject({ completion: expect.any(Promise) });
  });

  it("marks a replayed queued plan answer after projecting its persisted user message", async () => {
    const { service, messageRepo, planQuestionAnswersRepo } = await buildService();
    await messageRepo.create(THREAD_ID, "assistant", "Plan question", 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "00000000-0000-4000-8000-000000000101");
    await messageRepo.create(THREAD_ID, "user", "Implement the approved plan", 2, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "queued-plan-answer");

    await service.dispatchQueuedAutomaticTurn({
      threadId: THREAD_ID,
      messageId: "queued-plan-answer",
      content: "Implement the approved plan",
      displayContent: "Implement the approved plan",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      attachments: [],
      persistedAttachments: [],
      mentions: [],
      provider: "claude",
      markPlanAnswerForMessageId: "00000000-0000-4000-8000-000000000101",
    });
    await vi.waitFor(() => expect(planQuestionAnswersRepo.isAnswered("00000000-0000-4000-8000-000000000101"))
      .toBe(true));
  });

  it("retains pre-persisted automatic-gate attachments when the command falls through to a normal Turn", async () => {
    const { service, attachmentService, messageRepo } = await buildService();
    const stored = { id: "attachment-normal", name: "normal.png", mimeType: "image/png", sizeBytes: 4 };

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "Normal fallback Turn",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      provider: "claude",
      attachments: [],
      persistedAttachmentData: {
        stored: [stored],
        persisted: [{ ...stored, sourcePath: "/tmp/normal.png" }],
      },
      cleanupPersistedAttachmentsOnHandledCommand: true,
    });

    expect((attachmentService.removeStoredAttachments as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toContainEqual(expect.objectContaining({
      role: "user", content: "Normal fallback Turn", sequence: 1, attachments: [stored],
    }));
  });

  it("ignores a late TurnStarted after stop instead of auto-resuming the thread", async () => {
    const { service, providerEmitter, memoryPressureService } = await buildService();
    startAgentServiceIngressForTest(service);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    await service.stopSession(THREAD_ID, { by: "user" });
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);

    providerEmitter.emit("event", {
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
    } satisfies AgentEvent);

    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markActive).toHaveBeenCalledTimes(1);
  });

  it("cancels the turn and evicts the session when provider stop fails", async () => {
    const { service, providerEmitter } = await buildService();
    startAgentServiceIngressForTest(service);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const provider = providerEmitter as NodeEvents.EventEmitter & {
      stopSession: ReturnType<typeof vi.fn>;
      discardSession: ReturnType<typeof vi.fn>;
    };
    provider.discardSession = vi.fn(() => Promise.resolve());
    provider.stopSession.mockRejectedValueOnce(new Error("stop unavailable"));

    const result = await service.stopSession(THREAD_ID, { by: "user" });
    expect(result.status).toBe("cancelled");
    expect(result.snapshot).toMatchObject({ threadId: THREAD_ID, phase: "cancelled" });
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    await vi.waitFor(() => expect(provider.discardSession).toHaveBeenCalledWith(`mcode-${THREAD_ID}`));

    const retry = await service.stopSession(THREAD_ID, { by: "user" });
    expect(retry.status).toBe("already-terminal");
  });

  it("finalizes the turn as cancelled when provider stopSession never settles", async () => {
    const { service, providerEmitter } = await buildService();
    startAgentServiceIngressForTest(service);
    const provider = providerEmitter as NodeEvents.EventEmitter & {
      stopSession: ReturnType<typeof vi.fn>;
      discardSession: ReturnType<typeof vi.fn>;
      waitForSessionExit: ReturnType<typeof vi.fn>;
    };
    provider.discardSession = vi.fn(() => Promise.resolve());
    provider.waitForSessionExit = vi.fn(() => Promise.resolve());
    provider.stopSession.mockImplementation(() => new Promise<void>(() => {}));

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    vi.useFakeTimers();
    try {
      const stop = service.stopSession(THREAD_ID, { by: "user" });
      // The RPC resolves on terminalize; provider settle continues detached.
      await expect(stop).resolves.toMatchObject({ status: "cancelled" });
      expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.discardSession).toHaveBeenCalledWith(`mcode-${THREAD_ID}`);

      providerEmitter.emit("event", {
        type: AgentEventType.Ended,
        threadId: THREAD_ID,
        turnExecutionId: "00000000-0000-4000-8000-000000000099",
        outcome: "completed",
      } satisfies AgentEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminalizes setup failure after reserving runtime authority", async () => {
    const { service, providerEmitter, attachmentService } = await buildService();
    startAgentServiceIngressForTest(service);
    (attachmentService.persist as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("attachment setup failed"),
    );

    await expect(service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    })).rejects.toThrow("attachment setup failed");
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(service.runtimeAccess().runtimeSnapshots()).toEqual([
      expect.objectContaining({ threadId: THREAD_ID, phase: "errored" }),
    ]);
    expect((providerEmitter as NodeEvents.EventEmitter & { sendTurn: ReturnType<typeof vi.fn> }).sendTurn)
      .not.toHaveBeenCalled();
  });

  it("shares one successful provider stop across concurrent callers", async () => {
    const { service, providerEmitter } = await buildService();
    startAgentServiceIngressForTest(service);
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const provider = providerEmitter as NodeEvents.EventEmitter & {
      stopSession: ReturnType<typeof vi.fn>;
    };
    let releaseStop!: () => void;
    provider.stopSession.mockImplementation(() => new Promise<void>((resolve) => {
      releaseStop = resolve;
    }));

    const first = service.stopSession(THREAD_ID, { by: "user" });
    const second = service.stopSession(THREAD_ID, { by: "user" });
    await vi.waitFor(() => expect(provider.stopSession).toHaveBeenCalledOnce());
    releaseStop();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(provider.stopSession).toHaveBeenCalledTimes(1);
    expect(secondResult).toEqual(firstResult);
    expect(firstResult.status).toBe("cancelled");
  });

  it("shares one provider stop across concurrent callers even when it fails", async () => {
    const { service, providerEmitter } = await buildService();
    startAgentServiceIngressForTest(service);
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const provider = providerEmitter as NodeEvents.EventEmitter & {
      stopSession: ReturnType<typeof vi.fn>;
      discardSession: ReturnType<typeof vi.fn>;
    };
    provider.discardSession = vi.fn(() => Promise.resolve());
    provider.stopSession.mockRejectedValueOnce(new Error("stop unavailable"));
    const first = service.stopSession(THREAD_ID, { by: "user" });
    const second = service.stopSession(THREAD_ID, { by: "user" });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe("cancelled");
    expect(secondResult).toEqual(firstResult);
    await vi.waitFor(() => expect(provider.stopSession).toHaveBeenCalledTimes(1));
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);

    const retry = await service.stopSession(THREAD_ID, { by: "user" });
    expect(retry.status).toBe("already-terminal");
  });

  it("admits a follow-up turn while provider teardown is still settling", async () => {
    const { service, providerEmitter } = await buildService();
    startAgentServiceIngressForTest(service);
    const provider = providerEmitter as NodeEvents.EventEmitter & {
      sendTurn: ReturnType<typeof vi.fn>;
      stopSession: ReturnType<typeof vi.fn>;
    };
    provider.stopSession.mockImplementation(() => new Promise<void>(() => {}));
    try {
      await service.sendMessage({
        threadId: THREAD_ID,
        content: "hello",
        permissionMode: "default",
        model: "claude-sonnet-4-6",
        attachments: [],
        provider: "claude",
      });
      const result = await service.stopSession(THREAD_ID, { by: "user" });
      expect(result.status).toBe("cancelled");

      await service.sendMessage({
        threadId: THREAD_ID,
        content: "again",
        permissionMode: "default",
        model: "claude-sonnet-4-6",
        attachments: [],
        provider: "claude",
      });
      expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
      expect(provider.sendTurn).toHaveBeenCalledTimes(2);
    } finally {
      provider.stopSession.mockResolvedValue(undefined);
    }
  });

  it("does not evict or reset a newer execution when detached Stop teardown rejects", async () => {
    const { service, providerEmitter } = await buildService();
    startAgentServiceIngressForTest(service);
    let rejectStop!: (error: Error) => void;
    const stopSession = vi.fn(async () => {});
    const discardSession = vi.fn(async () => {});
    stopSession.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectStop = reject; }));
    Object.assign(providerEmitter, { stopSession, discardSession });
    const send = (content: string) => service.sendMessage({
      threadId: THREAD_ID, content, permissionMode: "default", model: "claude-sonnet-4-6", attachments: [], provider: "claude",
    });
    await send("first turn");
    const firstExecutionId = activeExecutionId(service);
    expect((await service.stopSession(THREAD_ID, { by: "user" })).status).toBe("cancelled");
    await send("next turn");
    const nextExecutionId = activeExecutionId(service);
    expect(nextExecutionId).not.toBe(firstExecutionId);
    rejectStop(new Error("Late teardown failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(discardSession).not.toHaveBeenCalled();
    expect(service.runtimeAccess().runtimeSnapshots()).toContainEqual(expect.objectContaining({
      threadId: THREAD_ID, turnExecutionId: nextExecutionId, phase: "running",
    }));
  });

  it("does not let completion race overwrite an explicit stop", async () => {
    const { service, providerEmitter } = await buildService();
    startAgentServiceIngressForTest(service);
    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    const runtime = service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === THREAD_ID);
    const executionId = runtime?.turnExecutionId;
    expect(executionId).toBeTruthy();
    if (!executionId) throw new Error("turn execution identity missing");
    const provider = providerEmitter as NodeEvents.EventEmitter & {
      stopSession: ReturnType<typeof vi.fn>;
    };
    let releaseStop!: () => void;
    provider.stopSession.mockImplementation(() => new Promise<void>((resolve) => {
      releaseStop = resolve;
    }));

    const stopping = service.stopSession(THREAD_ID, { by: "user" });
    await vi.waitFor(() => expect(provider.stopSession).toHaveBeenCalledOnce());
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 1,
      tokensOut: 1,
      contextWindow: 200000,
      totalProcessedTokens: 2,
      providerId: "claude",
    } satisfies AgentEvent);
    releaseStop();
    const result = await stopping;
    expect(provider.stopSession).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("cancelled");
    expect(result.snapshot).toMatchObject({ threadId: THREAD_ID, phase: "cancelled" });
  });

  it.each([1, 2] as const)("persists one image per page from bundle v%i with distinct filenames", async (schemaVersion) => {
    const directory = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-page-snapshots-"));
    vi.stubEnv("MCODE_DATA_DIR", directory);
    try {
      const { service, providerEmitter, attachmentService, messageRepo } = await buildService();
      const storage = new AttachmentService();
      vi.spyOn(attachmentService, "persist").mockImplementation(storage.persist.bind(storage));
      const legacy = makePreviewAnnotationBundle();
      const first = legacy.annotations[0];
      if (!first || !("snapshot" in first)) throw new Error("missing browser fixture");
      const sourcePath = NodePath.join(directory, "page.png");
      const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);
      await NodeFSPromises.writeFile(sourcePath, bytes);
      const last = { ...first, id: "550e8400-e29b-41d4-a716-446655440002", displayNumber: 2,
        snapshot: { ...first.snapshot, id: "last-shot", sourcePath } };
      const other = { ...first, id: "550e8400-e29b-41d4-a716-446655440003",
        pageIdentity: "other-page", pageContext: { ...first.pageContext, pageUrl: "https://other.test" },
        snapshot: { ...first.snapshot, id: "other-shot", sourcePath } };
      const pages = [last, other].map((note) => ({
        pageIdentity: note.pageIdentity, url: note.pageContext.pageUrl, title: "Google", faviconUrl: null,
        snapshot: { ...note.snapshot, scroll: { x: 0, y: 0 } },
      }));
      const annotations = [first, last, other].map((note) => ({
        id: note.id, pageIdentity: note.pageIdentity, displayNumber: note.displayNumber,
        pageContext: note.pageContext, targetContext: note.targetContext, note: note.note!,
      }));
      const v2: PreviewAnnotationBundle = { schemaVersion: 2, pages, annotations };
      const bundle: PreviewAnnotationBundle = schemaVersion === 1
        ? { schemaVersion: 1, annotations: [first, last, other] } : v2;

      await service.sendMessage({ threadId: THREAD_ID, content: "fix this", permissionMode: "default",
        model: "claude-sonnet-4-6", provider: "claude", attachments: [], previewAnnotations: bundle });

      const expected = [
        { id: "last-shot", name: "Notes on Google.png", mimeType: "image/png", sizeBytes: 8 },
        { id: "other-shot", name: "Notes on Google (2).png", mimeType: "image/png", sizeBytes: 8 },
      ];
      expect(messageRepo.listByThread(THREAD_ID, 10).messages).toContainEqual(expect.objectContaining({
        role: "user", content: "fix this", sequence: 1, attachments: expected, previewAnnotations: v2,
      }));
      expect(Reflect.get(providerEmitter, "sendTurn")).toHaveBeenCalledWith(expect.objectContaining({
        attachments: expected.map((attachment) => ({ ...attachment,
          sourcePath: NodePath.join(directory, "attachments", THREAD_ID, attachment.id + ".png") })),
      }));
      expect((await NodeFSPromises.readdir(NodePath.join(directory, "attachments", THREAD_ID))).sort())
        .toEqual(["last-shot.png", "other-shot.png"]);
      for (const attachment of expected) {
        expect(await NodeFSPromises.readFile(NodePath.join(directory, "attachments", THREAD_ID, attachment.id + ".png"))).toEqual(bytes);
      }
    } finally {
      vi.unstubAllEnvs();
      await NodeFSPromises.rm(directory, { recursive: true, force: true });
    }
  });

  it("stores only v2 for an initial RPC turn queued behind Project Setup", async () => {
    const directory = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-page-setup-"));
    vi.stubEnv("MCODE_DATA_DIR", directory);
    try {
      const { service, threadService, threadRepo, messageRepo, db, environment, providerEmitter, attachmentService } =
        await buildService(directory, undefined, undefined, false, true);
      db.prepare("UPDATE threads SET mode = 'worktree', worktree_path = ? WHERE id = ?").run(directory, THREAD_ID);
      const thread = threadRepo.findById(THREAD_ID);
      if (!thread || !environment) throw new Error("missing Setup fixture");
      vi.mocked(threadService.create).mockResolvedValue(thread);
      const storage = new AttachmentService();
      vi.spyOn(attachmentService, "persist").mockImplementation(storage.persist.bind(storage));
      const first = makePreviewAnnotationBundle().annotations[0];
      if (!first || !("snapshot" in first)) throw new Error("missing browser fixture");
      const sourcePath = NodePath.join(directory, "page.png");
      await NodeFSPromises.writeFile(sourcePath, Buffer.from([137, 80, 78, 71]));
      const unexpected = (): never => { throw new Error("Queued admission accessed an unrelated service"); };
      await routeAgentRpc("agent.createAndSend", { workspaceId: thread.workspace_id, mode: "worktree", branch: "main",
        content: "queued notes", provider: "claude", previewAnnotations: { schemaVersion: 1,
          annotations: [{ ...first, snapshot: { ...first.snapshot, sourcePath } }] } }, {
        agentService: service, messageRepo,
        approvalService: { respondToApproval: unexpected, listPendingApprovals: unexpected },
        hookExecutionRepo: { listByMessage: unexpected }, narrativeStore: { load: unexpected, listApprovals: unexpected },
        planQuestionAnswersRepo: { listAnsweredForThread: unexpected },
        planService: { saveVersion: unexpected, snapshot: unexpected, implement: unexpected, createComment: unexpected,
          updateComment: unexpected, setCommentStatus: unexpected, deleteComment: unexpected },
        planTurnService: { answerQuestions: unexpected, dismissQuestions: unexpected }, recapService: { generate: unexpected },
        subagentRosterService: { loadRoster: unexpected, loadDetail: unexpected, stop: unexpected }, taskRepo: { get: unexpected },
        thoughtSegmentRepo: { listByMessage: unexpected }, threadControlService: { respondToApproval: unexpected, listPendingApprovals: unexpected },
        toolCallRecordRepo: { listByMessage: unexpected, listByParent: unexpected },
        turnRecoveryService: { retryErroredTurn: unexpected, resumeTurn: unexpected },
        turnResumeScheduler: { schedule: unexpected, unschedule: unexpected },
      });
      const messages = messageRepo.listByThread(THREAD_ID, 10).messages.filter((message) => message.role === "user");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ content: "queued notes", previewAnnotations: { schemaVersion: 2,
        pages: [{ snapshot: { id: "annotation-shot-1" } }], annotations: [{ note: "Move the header down." }] },
        attachments: [{ id: "annotation-shot-1", name: "Notes on Google.png", sizeBytes: 4 }] });
      expect(environment.getAutomaticSetup({ threadId: THREAD_ID }).queuedTurns).toHaveLength(1);
      const queued = db.query<{ submission_json: string }, []>(
        "SELECT submission_json FROM workspace_environment_queued_turns",
      ).get();
      expect(JSON.parse(queued!.submission_json)).toMatchObject({ previewAnnotations: messages[0]!.previewAnnotations });
      expect(Reflect.get(providerEmitter, "sendTurn")).not.toHaveBeenCalled();
      await environment.dispose();
    } finally {
      vi.unstubAllEnvs();
      await NodeFSPromises.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["missing-source", "unsafe-id"])("rejects a page snapshot with %s before persisting the message", async (failure) => {
    const directory = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-page-rejected-"));
    vi.stubEnv("MCODE_DATA_DIR", directory);
    try {
      const { service, providerEmitter, attachmentService, messageRepo } = await buildService();
      const storage = new AttachmentService();
      vi.spyOn(attachmentService, "persist").mockImplementation(storage.persist.bind(storage));
      const first = makePreviewAnnotationBundle().annotations[0];
      if (!first || !("snapshot" in first)) throw new Error("missing browser fixture");
      const sourcePath = NodePath.join(directory, "page.png");
      const storedDirectory = NodePath.join(directory, "attachments", THREAD_ID);
      await NodeFSPromises.mkdir(storedDirectory, { recursive: true });
      if (failure === "unsafe-id") await NodeFSPromises.writeFile(sourcePath, Buffer.from([137, 80, 78, 71]));
      const bundle: PreviewAnnotationBundle = { schemaVersion: 2,
        pages: [{ pageIdentity: first.pageIdentity, url: first.pageContext.pageUrl, title: "Google", faviconUrl: null,
          snapshot: { ...first.snapshot, id: failure === "unsafe-id" ? "../escape" : "safe", sourcePath, scroll: { x: 0, y: 0 } } }],
        annotations: [{ id: first.id, pageIdentity: first.pageIdentity, displayNumber: 1,
          pageContext: first.pageContext, targetContext: first.targetContext, note: "Move the header down." }],
      };
      if (failure === "unsafe-id") {
        bundle.pages.unshift({ ...bundle.pages[0]!, pageIdentity: "safe-page",
          snapshot: { ...bundle.pages[0]!.snapshot, id: "safe-first" } });
        bundle.annotations.push({ ...bundle.annotations[0]!, id: "550e8400-e29b-41d4-a716-446655440002", pageIdentity: "safe-page" });
      }
      await expect(service.sendMessage({ threadId: THREAD_ID, content: "fix this", permissionMode: "default",
        model: "claude-sonnet-4-6", provider: "claude", attachments: [], previewAnnotations: bundle })).rejects.toThrow();
      if (failure === "unsafe-id") expect(attachmentService.persist).not.toHaveBeenCalled();
      expect(messageRepo.listByThread(THREAD_ID, 10).messages.filter((message) => message.role === "user")).toEqual([]);
      expect(Reflect.get(providerEmitter, "sendTurn")).not.toHaveBeenCalled();
      expect(await NodeFSPromises.readdir(NodePath.join(directory, "attachments", THREAD_ID))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await NodeFSPromises.rm(directory, { recursive: true, force: true });
    }
  });

  it("re-adds thread to activeThreadIds on TurnStarted after TurnComplete (auto-resume)", async () => {
    const { service, providerEmitter, memoryPressureService } = await buildService();
    startAgentServiceIngressForTest(service);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
    const executionId = activeExecutionId(service);

    // Turn completes, thread removed from active
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 100,
      tokensOut: 50,
      contextWindow: 200000,
      totalProcessedTokens: 150,
      providerId: "claude",
    } satisfies AgentEvent);
    providerEmitter.emit("event", { type: AgentEventType.Ended, threadId: THREAD_ID, turnExecutionId: executionId });
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);

    // SDK auto-resumes: TurnStarted fires from stream loop
    memoryPressureService.markActive.mockClear();
    const resumedExecutionId = await startProviderTurn(service);
    providerEmitter.emit("event", {
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: resumedExecutionId,
    } satisfies AgentEvent);

    // The resumed turn becomes active after prior-turn persistence releases its barrier.
    await vi.waitFor(() => {
      expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
      expect(memoryPressureService.markActive).toHaveBeenCalled();
    });
  });

  it("removes thread from activeThreadIds on Ended event", async () => {
    const { service, providerEmitter, memoryPressureService } = await buildService();
    startAgentServiceIngressForTest(service);

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
    const executionId = activeExecutionId(service);

    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      outcome: "completed",
    } satisfies AgentEvent);
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markIdle).toHaveBeenCalled();
  });
});

describe("AgentService Ended finalization", () => {
  let db: Database;
  let threadRepo: RealThreadRepo;
  let workspaceRepo: RealWorkspaceRepo;
  let messageRepo: RealMessageRepo;
  let providerEmitter: NodeEvents.EventEmitter & {
    sendTurn: ReturnType<typeof vi.fn>;
    stopSession: ReturnType<typeof vi.fn>;
    interruptChildTurn: ReturnType<typeof vi.fn>;
  };
  let canonicalSink: CanonicalAgentBoundary;
  let service: AgentService;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = openAgentStorageTestDatabase();
    threadRepo = new RealThreadRepo(db, agentStorageTestWriter(db));
    workspaceRepo = new RealWorkspaceRepo(db, agentStorageTestWriter(db));
    messageRepo = new RealMessageRepo(db, agentStorageTestWriter(db));
    const toolCallRecordRepo = new RealToolCallRecordRepo(db, agentStorageTestWriter(db));
    const thoughtSegmentRepo = new RealThoughtSegmentRepo(db, agentStorageTestWriter(db));
    const hookExecutionRepo = new RealHookExecutionRepo(db, agentStorageTestWriter(db));
    const narrative = new NarrativeStore(messageRepo, toolCallRecordRepo, thoughtSegmentRepo, hookExecutionRepo, db);
    providerEmitter = wrapProviderEmitterForRuntimeEvents(Object.assign(new NodeEvents.EventEmitter(), {
      id: "codex" as ProviderId,
      descriptor: {
        capabilities: [{ name: "child-cancellation", support: "supported" }],
      },
      sendTurn: vi.fn(() => Promise.resolve()),
      onTurnDiff: (listener: (update: ProviderTurnDiffUpdate) => void) => {
        providerEmitter.on("turn-diff", listener);
        return () => { providerEmitter.off("turn-diff", listener); };
      },
      stopSession: vi.fn(),
      interruptChildTurn: vi.fn(() => Promise.resolve()),
      shutdown: vi.fn(),
    }));

    const providerRegistry = {
      resolve: vi.fn(() => providerEmitter),
      resolveAll: vi.fn(() => [providerEmitter]),
      shutdown: vi.fn(),
    } as unknown as IProviderRegistry;
    const gitService = {
      resolveWorkingDir: vi.fn(() => process.cwd()),
      listWorktrees: vi.fn(() => []),
    } as unknown as GitService;
    const attachmentService = {
      persist: vi.fn(() => Promise.resolve({ stored: [], persisted: [] })),
    } as unknown as AttachmentService;
    const snapshotService = {
      captureRef: vi.fn(() => Promise.resolve("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")),
      getFilesChanged: vi.fn(() => Promise.resolve([])),
    } as unknown as SnapshotService;
    const memoryPressureService = {
      markActive: vi.fn(),
      markIdle: vi.fn(),
      onPressureChange: vi.fn(),
    } as unknown as MemoryPressureService;
    const settingsService = {
      get: vi.fn(() => ({
        model: { defaults: { fallbackId: undefined } },
        agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
        provider: { enabled: {}, cli: {} },
      })),
      on: vi.fn(),
    } as unknown as SettingsService;
    const canonicalWriter = new CanonicalAgentWriterClient(agentStorageTestWriter(db));
    canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), canonicalWriter, () => undefined);
    const progress = new CanonicalAcceptedProgress(canonicalSink, canonicalWriter);
    canonicalSink.bindAcceptedSynthesizedPublications((threadId, events) => progress.acceptSynthesizedPublications(threadId, events));
    const planTurns = new PlanTurnService(threadRepo, providerRegistry,
      new PlanQuestionService(messageRepo, new PlanQuestionAnswersRepo(db, agentStorageTestWriter(db))),
      new PlanRepo(db, agentStorageTestWriter(db)), new AgentTurnCommandPort(new AgentRuntimeCommandPort()));
    service = createAgentServiceForTest(
      threadRepo,
      workspaceRepo,
      messageRepo,
      gitService,
      attachmentService,
      providerRegistry,
      { create: vi.fn() } as unknown as ThreadService,
      new RealTurnSnapshotRepo(db, agentStorageTestWriter(db)),
      snapshotService,
      db,
      memoryPressureService,
      settingsService,
      { assertUsable: vi.fn() } as unknown as ProviderAvailabilityService,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      narrative,
      new ParentAssistantTextCheckpointService(db, agentStorageTestWriter(db)),
      undefined,
      undefined,
      undefined,
      canonicalSink,
      undefined,
      undefined,
      planTurns,
      undefined,
      new SubagentRosterService(canonicalSink, providerRegistry, narrative, db),
    );
    await waitForAgentServiceWorkersForTest(service);
    const fixtureService = service;
    registerAgentStorageTestProducer(db, async () => {
      await drainAgentServicePersistenceForTest(fixtureService);
      await progress.close();
    });
    startAgentServiceIngressForTest(service, (event) => {
      publishParentProviderEvent(event, {
        recordTurnOutcome: (threadId, outcome) => threadRepo.recordTurnOutcome(threadId, outcome, new Date().toISOString()),
        publishThreadStatus: (payload) => broadcast("thread.status", payload),
      });
    });
  });

  it("stops a native question turn through the provider and persists the dismissed dock", async () => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Question stop", "direct", "main", true, "codex");
    await threadRepo.updateSettings(thread.id, { interaction_mode: "plan" });
    let handler: PlanQuestionHandler | undefined;
    const provider: IAgentProvider = Object.assign(providerEmitter, {
      id: "codex" as const, descriptor: { id: "codex" as const, capabilities: [] },
      supportsCompletion: false,  maxInputCharactersPerTurn: 100_000,
       listModels: async () => [],
      bindPlanQuestions: (bound: PlanQuestionHandler) => { handler = bound; },
      supportsNativePlanQuestions: async () => true,
    });
    const registry: IProviderRegistry = { resolve: () => provider, resolveAll: () => [provider], shutdown: async () => {} };
    const records = new PlanQuestionAnswersRepo(db, agentStorageTestWriter(db));
    const plans = new PlanTurnService(threadRepo, registry, new PlanQuestionService(messageRepo, records),
      new PlanRepo(db, agentStorageTestWriter(db)), new AgentTurnCommandPort(new AgentRuntimeCommandPort()));
    plans.bindNativeQuestions(() => {});
    await service.sendMessage({ threadId: thread.id, content: "Plan", permissionMode: "default",
      model: "gpt-5", attachments: [], provider: "codex" });
    const batch: NativePlanQuestionBatch = { threadId: thread.id, requestId: "00000000-0000-4000-8000-000000000090",
      questions: [{ id: "tone", category: "Tone", question: "Which greeting?",
        options: [{ id: "0", title: "Brief", description: "One sentence" }, { id: "1", title: "Detailed", description: "A paragraph" }] }] };
    if (!handler) throw new Error("Question handler was not bound");
    await handler.requested(batch);
    const questionHandler = handler;
    providerEmitter.stopSession.mockImplementation(async (sessionId: string) => {
      if (sessionId !== `mcode-${thread.id}`) throw new Error("Stop targeted another provider session");
      await questionHandler.settled(batch, "dismissed");
    });
    expect(await service.stopSession(thread.id, { by: "user" })).toMatchObject({ status: "cancelled" });
    await vi.waitFor(() => expect(records.pendingNative(thread.id)).toEqual([]));
    expect(threadRepo.findById(thread.id)?.plan_phase).toBeNull();
    expect(messageRepo.listByThread(thread.id).messages.filter(message => message.role === "system").map(message => message.content))
      .toContain("Questions dismissed");
    expect(db.query("SELECT status FROM plan_question_answers WHERE id = ?").get(batch.requestId)).toEqual({ status: "dismissed" });
  });

  it.each(["cancelled", "errored"] as const)("persists reported context without completing a turn before %s", async (outcome) => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Usage before stop", "direct", "main", true, "codex");
    await service.sendMessage({ threadId: thread.id, content: "work", permissionMode: "default", model: "gpt-5", attachments: [], provider: "codex" });
    const turnExecutionId = activeExecutionId(service, thread.id);
    providerEmitter.emit("event", {
      type: AgentEventType.ContextEstimate, threadId: thread.id, turnExecutionId,
      tokensIn: 100, tokensOut: 20, totalProcessedTokens: 120, cacheReadTokens: 40, contextWindow: 200_000,
    } satisfies AgentEvent);
    await waitForAgentServiceIngressForTest(service, thread.id);
    expect(service.runtimeAccess().activeThreadIds()).toContain(thread.id);
    await vi.waitFor(() => expect(threadRepo.findById(thread.id))
      .toMatchObject({ last_context_tokens: 100, context_window: 200_000 }));
    providerEmitter.emit("event", { type: AgentEventType.Ended, threadId: thread.id, turnExecutionId, outcome } satisfies AgentEvent);
    await waitForAgentServiceIngressForTest(service, thread.id);
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(thread.id);
    expect(threadRepo.findById(thread.id)).toMatchObject({ last_context_tokens: 100, context_window: 200_000 });
  });

  it("terminalizes a running canonical child when parent stop has no native identity", async () => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Parent thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "delegate work without provider identity",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    const parentTurn = canonicalSink.loadTurnByExecution(executionId);
    expect(parentTurn).not.toBeNull();
    const child = await canonicalSink.startCodexChildDelegation({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:missing-identity",
      receiverThreadIds: ["native-missing-thread"],
      providerIdentities: [],
    });
    const childTurn = await canonicalSink.startCodexChildTurn({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:missing-identity",
      nativeThreadId: "native-missing-thread",
      nativeTurnId: "native-missing-turn",
    });
    db.prepare("UPDATE canonical_agent_threads SET provider_identities_json = '[]' WHERE id = ?")
      .run(child.childThread.id);
    db.prepare("UPDATE canonical_agent_turns SET provider_identities_json = '[]' WHERE id = ?")
      .run(childTurn.id);

    expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: child.childThread.id,
    })).toMatchObject({ latestTurn: { status: "Running" }, nativeThreadId: null, nativeTurnId: null });

    const result = await service.stopSession(thread.id, { by: "user" });

    expect(result.status).toBe("cancelled");
    expect(providerEmitter.interruptChildTurn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: child.childThread.id,
    })?.latestTurn?.status).toBe("Interrupted"));
  });

  it("leaves a stopAll turn unresolved when the provider sends no terminal outcome", async () => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Shutdown without outcome", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "stop without a provider outcome",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    let snapshotAtProviderStop: ReturnType<typeof canonicalSink.loadCheckpoint> = null;
    let providerStopCompleted = false;
    providerEmitter.stopSession.mockImplementation(async () => {
      snapshotAtProviderStop = canonicalSink.loadCheckpoint(executionId);
      await Promise.resolve();
      providerStopCompleted = true;
    });

    await service.stopAll();

    expect(providerStopCompleted).toBe(true);
    expect(snapshotAtProviderStop).toMatchObject({
      phase: "running",
      terminalOutcome: null,
    });
    expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
      phase: "running",
      terminalOutcome: null,
    });
    expect(threadRepo.findById(thread.id)?.status).toBe("active");
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === thread.id))
      .toMatchObject({ phase: "running", turnExecutionId: executionId });
  });

  it("does not persist an interruption when a running turn ends without an outcome", async () => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Test thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "please investigate",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    providerEmitter.emit("event", {
      type: AgentEventType.Message,
      threadId: thread.id,
      turnExecutionId: executionId,
      content: "partial answer before the provider stopped",
      tokens: null,
    } satisfies AgentEvent);

    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: thread.id,
      turnExecutionId: executionId,
    } satisfies AgentEvent);

    await waitForAgentServiceIngressForTest(service, thread.id);
    const assistant = messageRepo.listByThread(thread.id, 10).messages
      .find((message) => message.role === "assistant");
    expect(assistant?.outcome).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: thread.id,
      outcome: expect.any(String),
      executionId,
    }));
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === thread.id)?.phase).toBe("running");
  });

  it("leaves a matching outcome-less Ended unresolved", async () => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Recovery thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "retry this turn",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: thread.id,
      turnExecutionId: executionId,
    } satisfies AgentEvent);

    await waitForAgentServiceIngressForTest(service, thread.id);
    expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
      phase: "running",
      terminalOutcome: null,
    });
    expect(threadRepo.findById(thread.id)?.status).toBe("active");
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === thread.id))
      .toMatchObject({ phase: "running" });
  });

  it("leaves a full-looking response unresolved without terminal proof", async () => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Test thread", "direct", "main", true, "cursor");

    await service.sendMessage({
      threadId: thread.id,
      content: "please investigate",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "cursor",
    });
    const executionId = activeExecutionId(service, thread.id);
    providerEmitter.emit("event", {
      type: AgentEventType.TextDelta,
      threadId: thread.id,
      turnExecutionId: executionId,
      delta: "This is a complete-looking final response.",
      isFinalResponse: true,
    } satisfies AgentEvent);

    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: thread.id,
      turnExecutionId: executionId,
    } satisfies AgentEvent);
    await waitForAgentServiceIngressForTest(service, thread.id);
    const assistant = messageRepo.listByThread(thread.id, 10).messages
      .find((message) => message.role === "assistant");
    expect(assistant?.outcome).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: thread.id,
      outcome: expect.any(String),
      executionId,
    }));
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === thread.id)?.phase).toBe("running");
  });

});
