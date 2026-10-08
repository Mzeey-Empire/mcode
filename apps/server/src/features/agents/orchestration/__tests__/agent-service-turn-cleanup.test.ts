import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as NodeEvents from "node:events";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AgentEventType,
  createAgentModelState,
  reduceAgentEventBatch,
  type CanonicalAgentEventEnvelope,
} from "@mcode/contracts";
import type {
  AgentEvent,
  AttachmentMeta,
  IAgentProvider,
  IProviderRegistry,
  ProviderId,
  PreviewAnnotationBundle,
  TurnRequest,
  ProviderTurnDiffUpdate,
} from "@mcode/contracts";
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
import {
  createAgentServiceForTest,
  turnDiffsForAgentServiceTest,
  fileTrackerForAgentServiceTest,
  finalizerForAgentServiceTest,
  drainAgentServicePersistenceForTest,
  startAgentServiceIngressForTest,
  startProviderTurnForTest,
  waitForAgentServiceIngressForTest,
  wrapProviderEmitterForRuntimeEvents,
} from "./agent-service-test-harness.js";
import { createCanonicalAgentBoundaryStub } from "../../canonical/__tests__/canonical-agent-boundary-stub.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { broadcast } from "../../../../application/transport/push.js";
import type { MessageRepo } from "../../conversation/persistence/message-repo.js";
import type { GitService } from "../../../projects/index.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import type { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { ThreadControlMutationReservationService } from "../../../thread-control/index.js";
import { publishParentProviderEvent } from "../../events/provider-event-publication.js";
import { SubagentLifecycleService } from "../../collaboration/subagent-lifecycle-service.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn(), subscribedThreadIds: () => new Set<string>() }));

const THREAD_ID = "thread-cleanup-test";

function activeExecutionId(service: AgentService, threadId = THREAD_ID): string {
  const executionId = service.runtimeAccess().runtimeSnapshots()
    .find((snapshot) => snapshot.threadId === threadId)?.turnExecutionId;
  if (!executionId) throw new Error("Expected an active turn execution identity");
  return executionId;
}

function startProviderTurn(service: AgentService): string {
  return startProviderTurnForTest(service, THREAD_ID);
}

function makePreviewAnnotationBundle(): PreviewAnnotationBundle {
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
    captureRef: vi.fn(() => Promise.resolve("abc123")),
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
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
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
      undefined,
      undefined,
  );
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
  };
}

afterEach(closeAgentStorageTestDatabases);

describe("AgentService turn cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retains provider subscriptions through the provider ingress", async () => {
    const legacyProvider = wrapProviderEmitterForRuntimeEvents(Object.assign(new NodeEvents.EventEmitter(), {
      id: "claude" as ProviderId,
    })) as unknown as IAgentProvider;
    const { service } = await buildService(
      process.cwd(),
      new ThreadControlMutationReservationService(),
      [legacyProvider],
    );
    const publish = vi.fn();
    startAgentServiceIngressForTest(service, publish);
    startAgentServiceIngressForTest(service, publish);

    expect((legacyProvider as unknown as NodeEvents.EventEmitter).listenerCount("event")).toBe(1);

    const providerEvent = {
      type: AgentEventType.ProviderUnavailable,
      threadId: THREAD_ID,
      providerId: "claude",
      reason: "disabled",
    } satisfies AgentEvent;
    (legacyProvider as unknown as NodeEvents.EventEmitter).emit("event", providerEvent);
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith(providerEvent);
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
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    } satisfies AgentEvent;
    providerEmitter.emit("event", event);
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(event);
  });

  it("removes thread from activeThreadIds on TurnComplete", async () => {
    const { service, providerEmitter, memoryPressureService } = await buildService();
    startAgentServiceIngressForTest(service, );

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
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    // Thread should no longer be active
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markIdle).toHaveBeenCalled();
  });

  it("keeps an automatic queued dispatch pending after an early provider send until TurnComplete releases the active Turn", async () => {
    const { service, providerEmitter, messageRepo } = await buildService();
    startAgentServiceIngressForTest(service, );
    await messageRepo.create(THREAD_ID, "user", "Queued work", 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "queued-message");

    const accepted = await service.dispatchQueuedAutomaticTurn({
      threadId: THREAD_ID,
      messageId: "queued-message",
      content: "Queued work",
      displayContent: "Queued work",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      attachments: [],
      persistedAttachments: [],
      mentions: [],
      provider: "claude",
    });

    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
    let completed = false;
    void accepted.completion.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);

    const executionId = activeExecutionId(service);
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
      providerId: "claude",
    } satisfies AgentEvent);

    await expect(accepted.completion).resolves.toBeUndefined();
    expect(completed).toBe(true);
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
    await expect(service.stopSession(THREAD_ID)).resolves.toMatchObject({ status: "cancelled" });
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
    startAgentServiceIngressForTest(service, );

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    await service.stopSession(THREAD_ID);
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
    startAgentServiceIngressForTest(service, );

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

    const result = await service.stopSession(THREAD_ID);
    expect(result.status).toBe("cancelled");
    expect(result.snapshot).toMatchObject({ threadId: THREAD_ID, phase: "cancelled" });
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    await vi.waitFor(() => expect(provider.discardSession).toHaveBeenCalledWith(`mcode-${THREAD_ID}`));

    const retry = await service.stopSession(THREAD_ID);
    expect(retry.status).toBe("already-terminal");
  });

  it("finalizes the turn as cancelled when provider stopSession never settles", async () => {
    const { service, providerEmitter } = await buildService();
    startAgentServiceIngressForTest(service, );
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
      const stop = service.stopSession(THREAD_ID);
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

  it("applies a turnComplete held during compaction once compaction ends", async () => {
    const { service, providerEmitter } = await buildService();
    startAgentServiceIngressForTest(service, );
    const provider = providerEmitter as NodeEvents.EventEmitter & { sendTurn: ReturnType<typeof vi.fn> };
    provider.sendTurn.mockImplementationOnce((request: TurnRequest) => {
      providerEmitter.emit("event", {
        type: "compacting",
        threadId: THREAD_ID,
        turnExecutionId: request.turnExecutionId,
        active: true,
      });
      providerEmitter.emit("event", {
        type: AgentEventType.TurnComplete,
        threadId: THREAD_ID,
        turnExecutionId: request.turnExecutionId,
        reason: "end_turn",
        costUsd: null,
        tokensIn: 0,
        tokensOut: 0,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: "compacting",
        threadId: THREAD_ID,
        turnExecutionId: request.turnExecutionId,
        active: false,
      });
      providerEmitter.emit("event", {
        type: AgentEventType.Ended,
        threadId: THREAD_ID,
        turnExecutionId: request.turnExecutionId!,
      } satisfies AgentEvent);
      return Promise.resolve();
    });

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    await vi.waitFor(() => {
      expect(service.runtimeAccess().runtimeSnapshots().find((s) => s.threadId === THREAD_ID)?.phase)
        .toBe("completed");
    });
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
  });

  it("applies a compaction-held turnComplete when the stream ends without a closing compacting event", async () => {
    const { service, providerEmitter } = await buildService();
    startAgentServiceIngressForTest(service, );
    const provider = providerEmitter as NodeEvents.EventEmitter & { sendTurn: ReturnType<typeof vi.fn> };
    provider.sendTurn.mockImplementationOnce((request: TurnRequest) => {
      providerEmitter.emit("event", {
        type: "compacting",
        threadId: THREAD_ID,
        turnExecutionId: request.turnExecutionId,
        active: true,
      });
      providerEmitter.emit("event", {
        type: AgentEventType.TurnComplete,
        threadId: THREAD_ID,
        turnExecutionId: request.turnExecutionId,
        reason: "end_turn",
        costUsd: null,
        tokensIn: 0,
        tokensOut: 0,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.Ended,
        threadId: THREAD_ID,
        turnExecutionId: request.turnExecutionId!,
      } satisfies AgentEvent);
      return Promise.resolve();
    });

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });

    await vi.waitFor(() => {
      expect(service.runtimeAccess().runtimeSnapshots().find((s) => s.threadId === THREAD_ID)?.phase)
        .toBe("completed");
    });
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
  });

  it("cancels during delayed setup without dispatching after setup resumes", async () => {
    const { service, providerEmitter, attachmentService } = await buildService();
    startAgentServiceIngressForTest(service, );
    let releaseSetup!: () => void;
    const setupReady = new Promise<void>((resolve) => { releaseSetup = resolve; });
    (attachmentService.persist as ReturnType<typeof vi.fn>).mockImplementationOnce(() => (
      setupReady.then(() => ({ stored: [], persisted: [] }))
    ));

    const send = service.sendMessage({
      threadId: THREAD_ID,
      content: "hello",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    await vi.waitFor(() => expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID));

    const result = await service.stopSession(THREAD_ID);
    expect(result.status).toBe("cancelled");
    expect(result.dispatchState).toBe("not-dispatched");
    expect((providerEmitter as NodeEvents.EventEmitter & { sendTurn: ReturnType<typeof vi.fn> }).sendTurn)
      .not.toHaveBeenCalled();

    const replacement = service.sendMessage({
      threadId: THREAD_ID,
      content: "replacement",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
    });
    await replacement;
    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);

    releaseSetup();
    await send;
    expect((providerEmitter as NodeEvents.EventEmitter & { sendTurn: ReturnType<typeof vi.fn> }).sendTurn)
      .toHaveBeenCalledTimes(1);
  });

  it("terminalizes setup failure after reserving runtime authority", async () => {
    const { service, providerEmitter, attachmentService } = await buildService();
    startAgentServiceIngressForTest(service, );
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
    startAgentServiceIngressForTest(service, );
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

    const first = service.stopSession(THREAD_ID);
    const second = service.stopSession(THREAD_ID);
    await vi.waitFor(() => expect(provider.stopSession).toHaveBeenCalledOnce());
    releaseStop();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(provider.stopSession).toHaveBeenCalledTimes(1);
    expect(secondResult).toEqual(firstResult);
    expect(firstResult.status).toBe("cancelled");
  });

  it("shares one provider stop across concurrent callers even when it fails", async () => {
    const { service, providerEmitter } = await buildService();
    startAgentServiceIngressForTest(service, );
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
    const first = service.stopSession(THREAD_ID);
    const second = service.stopSession(THREAD_ID);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe("cancelled");
    expect(secondResult).toEqual(firstResult);
    await vi.waitFor(() => expect(provider.stopSession).toHaveBeenCalledTimes(1));
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);

    const retry = await service.stopSession(THREAD_ID);
    expect(retry.status).toBe("already-terminal");
  });

  it("admits a follow-up turn while provider teardown is still settling", async () => {
    const { service, providerEmitter } = await buildService();
    startAgentServiceIngressForTest(service, );
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
      const result = await service.stopSession(THREAD_ID);
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
    expect((await service.stopSession(THREAD_ID)).status).toBe("cancelled");
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
    startAgentServiceIngressForTest(service, );
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

    const stopping = service.stopSession(THREAD_ID);
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

  it("persists preview annotation snapshots as visible provider attachments", async () => {
    const { service, providerEmitter, attachmentService, messageRepo } = await buildService();
    const bundle = makePreviewAnnotationBundle();

    await service.sendMessage({
      threadId: THREAD_ID,
      content: "fix this",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "claude",
      mentions: [],
      previewAnnotations: bundle,
    });

    const expectedAttachment = {
      id: "annotation-shot-1",
      name: "Annotation 1 screenshot.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      sourcePath: "C:/tmp/annotation-shot-1.png",
    };

    expect(attachmentService.persist).toHaveBeenCalledWith(THREAD_ID, [
      expectedAttachment,
    ]);
    expect(messageRepo.listByThread(THREAD_ID, 10).messages).toContainEqual(expect.objectContaining({
      role: "user", content: "fix this", sequence: 1,
      attachments: [
        {
          id: "annotation-shot-1",
          name: "Annotation 1 screenshot.png",
          mimeType: "image/png",
          sizeBytes: 2048,
        },
      ], previewAnnotations: bundle,
    }));
    expect((providerEmitter as any).sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expectedAttachment],
      }),
    );
  });

  it("keeps compaction active while materializing a post-terminal goal receipt", async () => {
    const { service, providerEmitter, messageRepo } = await buildService();
    startAgentServiceIngressForTest(service, );

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
      type: AgentEventType.Compacting,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      active: true,
    } satisfies AgentEvent);

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
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(service.runtimeAccess().activeThreadIds()).toContain(THREAD_ID);
    providerEmitter.emit("event", {
      type: AgentEventType.Message,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      content: "Goal achieved in 1s.",
      tokens: null,
    } satisfies AgentEvent);
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    await vi.waitFor(() => expect(messageRepo.listByThread(THREAD_ID, 10).messages).toContainEqual(expect.objectContaining({
      role: "assistant", content: "Goal achieved in 1s.", model: "claude-sonnet-4-6",
    })));
  });

  it("re-adds thread to activeThreadIds on TurnStarted after TurnComplete (auto-resume)", async () => {
    const { service, providerEmitter, memoryPressureService } = await buildService();
    startAgentServiceIngressForTest(service, );

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
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);

    // SDK auto-resumes: TurnStarted fires from stream loop
    memoryPressureService.markActive.mockClear();
    const resumedExecutionId = startProviderTurn(service);
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

  it("aborts an auto-resumed turn when a pending mutation reservation owns the thread", async () => {
    const mutationReservations = new ThreadControlMutationReservationService();
    const { service, providerEmitter } = await buildService(process.cwd(), mutationReservations);
    const provider = providerEmitter as NodeEvents.EventEmitter & { stopSession: ReturnType<typeof vi.fn> };
    startAgentServiceIngressForTest(service, );

    expect(mutationReservations.rehydrate(THREAD_ID, "pending-approval")).toBe(true);
    const resumedExecutionId = startProviderTurn(service);
    providerEmitter.emit("event", {
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: resumedExecutionId,
    } satisfies AgentEvent);

    await vi.waitFor(() => expect(provider.stopSession).toHaveBeenCalledWith(`mcode-${THREAD_ID}`));
    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: THREAD_ID,
      turnExecutionId: resumedExecutionId,
      outcome: "cancelled",
    } satisfies AgentEvent);
    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(mutationReservations.owns(THREAD_ID, "pending-approval", "pendingApproval")).toBe(true);
  });

  it("initializes file tracking for provider-originated auto-resumed turns", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-auto-resume-tracker-"));
    try {
      await NodeFSPromises.writeFile(NodePath.join(root, "tracked.txt"), "before\n");
      const {
        service,
        providerEmitter,
        snapshotService,
        turnSnapshotRepo,
      } = await buildService(root);
      startAgentServiceIngressForTest(service, );
      const resumedExecutionId = startProviderTurn(service);
      snapshotService.captureRef.mockClear();
      const observeToolUse = vi.spyOn(fileTrackerForAgentServiceTest(service), "observeToolUse");

      providerEmitter.emit("event", {
        type: AgentEventType.TurnStarted,
        threadId: THREAD_ID,
        turnExecutionId: resumedExecutionId,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.ToolUse,
        threadId: THREAD_ID,
        turnExecutionId: resumedExecutionId,
        toolCallId: "auto-edit",
        toolName: "Edit",
        toolInput: { file_path: "tracked.txt" },
      } satisfies AgentEvent);
      await vi.waitFor(() => expect(observeToolUse).toHaveBeenCalledOnce());
      await observeToolUse.mock.results[0]!.value;

      await NodeFSPromises.writeFile(NodePath.join(root, "tracked.txt"), "after\n");
      providerEmitter.emit("event", {
        type: AgentEventType.ToolResult,
        threadId: THREAD_ID,
        turnExecutionId: resumedExecutionId,
        toolCallId: "auto-edit",
        output: "updated",
        isError: false,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.TurnComplete,
        threadId: THREAD_ID,
        turnExecutionId: resumedExecutionId,
        reason: "end_turn",
        costUsd: null,
        tokensIn: 1,
        tokensOut: 1,
        contextWindow: 200000,
        totalProcessedTokens: 2,
        providerId: "claude",
      } satisfies AgentEvent);

      await vi.waitFor(() => expect(turnSnapshotRepo.listByThread(THREAD_ID)).toHaveLength(1));
      expect(snapshotService.captureRef).toHaveBeenCalledWith(root);
      expect(turnSnapshotRepo.listByThread(THREAD_ID)[0]).toMatchObject({
        file_effects: {
          fileCount: 1,
          effects: [expect.objectContaining({
            path: "tracked.txt",
            kind: "edited",
            scope: "workspace",
          })],
        },
      });
    } finally {
      await NodeFSPromises.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps overlapping auto-resumed generations isolated until prior persistence finishes", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-auto-resume-overlap-"));
    let releaseFirstResult: (() => void) | undefined;
    let fixtureService: AgentService | undefined;
    try {
      await NodeFSPromises.writeFile(NodePath.join(root, "first.txt"), "before first\n");
      await NodeFSPromises.writeFile(NodePath.join(root, "second.txt"), "before second\n");
      const {
        service,
        providerEmitter,
        turnSnapshotRepo,
        toolCallRecordRepo,
        canonicalSink,
        threadRepo,
      } = await buildService(root, undefined, undefined, true);
      fixtureService = service;
      startAgentServiceIngressForTest(service, );
      const tracker = fileTrackerForAgentServiceTest(service);
      const observeToolUse = vi.spyOn(tracker, "observeToolUse");
      const firstExecutionId = startProviderTurn(service);
      const thread = threadRepo.findById(THREAD_ID);
      if (!thread) throw new Error("Expected the cleanup thread");
      const seedTurn = async (executionId: string, sequence: number) => canonicalSink.startParentTurn({
        thread: { id: thread.id, workspaceId: thread.workspace_id, providerId: thread.provider, createdAt: thread.created_at },
        turnId: `turn:${executionId}`, executionId, permissionMode: "supervised", providerIdentities: [],
        userMessage: { kind: "create", content: `Turn ${sequence}`, sequence },
      });
      await seedTurn(firstExecutionId, 1);
      expect(canonicalSink.loadParentTurnUserMessage(firstExecutionId)).toMatchObject({ role: "user", sequence: 1 });
      const originalObserveToolResult = tracker.observeToolResult.bind(tracker);
      const firstResultGate = new Promise<void>((resolve) => {
        releaseFirstResult = resolve;
      });
      let resultCount = 0;
      vi.spyOn(tracker, "observeToolResult").mockImplementation(async (...args) => {
        resultCount += 1;
        if (resultCount === 1) await firstResultGate;
        await originalObserveToolResult(...args);
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TurnStarted,
        threadId: THREAD_ID,
        turnExecutionId: firstExecutionId,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.ToolUse,
        threadId: THREAD_ID,
        turnExecutionId: firstExecutionId,
        toolCallId: "first-edit",
        toolName: "Edit",
        toolInput: { file_path: "first.txt" },
      } satisfies AgentEvent);
      await vi.waitFor(() => expect(observeToolUse).toHaveBeenCalledTimes(1));
      await observeToolUse.mock.results[0]!.value;
      await NodeFSPromises.writeFile(NodePath.join(root, "first.txt"), "after first\n");
      providerEmitter.emit("event", {
        type: AgentEventType.ToolResult,
        threadId: THREAD_ID,
        turnExecutionId: firstExecutionId,
        toolCallId: "first-edit",
        output: "updated",
        isError: false,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.TurnComplete,
        threadId: THREAD_ID,
        turnExecutionId: firstExecutionId,
        reason: "end_turn",
        costUsd: null,
        tokensIn: 1,
        tokensOut: 1,
        contextWindow: 200000,
        totalProcessedTokens: 2,
        providerId: "claude",
      } satisfies AgentEvent);
      await waitForAgentServiceIngressForTest(service, THREAD_ID);

      const secondExecutionId = startProviderTurn(service);
      await seedTurn(secondExecutionId, 2);
      expect(canonicalSink.loadParentTurnUserMessage(secondExecutionId)).toMatchObject({ role: "user", sequence: 2 });
      providerEmitter.emit("event", {
        type: AgentEventType.TurnStarted,
        threadId: THREAD_ID,
        turnExecutionId: secondExecutionId,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.ToolUse,
        threadId: THREAD_ID,
        turnExecutionId: secondExecutionId,
        toolCallId: "second-edit",
        toolName: "Edit",
        toolInput: { file_path: "second.txt" },
      } satisfies AgentEvent);
      await vi.waitFor(() => expect(observeToolUse).toHaveBeenCalledTimes(2));
      await observeToolUse.mock.results[1]!.value;
      await NodeFSPromises.writeFile(NodePath.join(root, "second.txt"), "after second\n");
      providerEmitter.emit("event", {
        type: AgentEventType.Message,
        threadId: THREAD_ID,
        turnExecutionId: secondExecutionId,
        content: "second turn complete",
        tokens: null,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.ToolResult,
        threadId: THREAD_ID,
        turnExecutionId: secondExecutionId,
        toolCallId: "second-edit",
        output: "updated",
        isError: false,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.TurnComplete,
        threadId: THREAD_ID,
        turnExecutionId: secondExecutionId,
        reason: "end_turn",
        costUsd: null,
        tokensIn: 1,
        tokensOut: 1,
        contextWindow: 200000,
        totalProcessedTokens: 2,
        providerId: "claude",
      } satisfies AgentEvent);
      await waitForAgentServiceIngressForTest(service, THREAD_ID);
      expect(turnSnapshotRepo.listByThread(THREAD_ID)).toEqual([]);

      releaseFirstResult?.();
      await vi.waitFor(() => expect(turnSnapshotRepo.listByThread(THREAD_ID)).toHaveLength(2));
      const snapshots = turnSnapshotRepo.listByThread(THREAD_ID);
      const firstSnapshot = snapshots.find((snapshot) => snapshot.file_effects?.effects[0]?.path === "first.txt");
      const secondSnapshot = snapshots.find((snapshot) => snapshot.file_effects?.effects[0]?.path === "second.txt");
      if (!firstSnapshot?.file_effects || !secondSnapshot?.file_effects) throw new Error("Both execution file-effect snapshots must persist");
      expect(firstSnapshot.file_effects.effects.map((effect) => effect.path)).toEqual(["first.txt"]);
      expect(secondSnapshot.file_effects.effects.map((effect) => effect.path)).toEqual(["second.txt"]);
      expect(toolCallRecordRepo.listByMessage(firstSnapshot.message_id)).toEqual([
        expect.objectContaining({
          id: "first-edit",
          message_id: firstSnapshot.message_id,
        }),
      ]);
      expect(toolCallRecordRepo.listByMessage(secondSnapshot.message_id)).toEqual([
        expect.objectContaining({
          id: "second-edit",
          message_id: secondSnapshot.message_id,
        }),
      ]);
    } finally {
      releaseFirstResult?.();
      if (fixtureService) await finalizerForAgentServiceTest(fixtureService).drain();
      await NodeFSPromises.rm(root, { recursive: true, force: true });
    }
  });

  it("does not re-add thread after an Error event following TurnComplete", async () => {
    const { service, providerEmitter, memoryPressureService } = await buildService();
    startAgentServiceIngressForTest(service, );

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

    // Turn completes, thread removed
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

    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);

    // Error event should not re-add the thread
    memoryPressureService.markActive.mockClear();
    providerEmitter.emit("event", {
      type: AgentEventType.Error,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      error: "Something went wrong",
    } satisfies AgentEvent);
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(service.runtimeAccess().activeThreadIds()).not.toContain(THREAD_ID);
    expect(memoryPressureService.markActive).not.toHaveBeenCalled();
  });

  it("removes thread from activeThreadIds on Ended event", async () => {
    const { service, providerEmitter, memoryPressureService } = await buildService();
    startAgentServiceIngressForTest(service, );

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
  let lastTurnRequest: TurnRequest | undefined;
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
  let canonicalEvents: CanonicalAgentEventEnvelope[];
  let service: AgentService;
  let pendingPlanOutputs: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    lastTurnRequest = undefined;
    db = openAgentStorageTestDatabase();
    canonicalEvents = [];
    threadRepo = new RealThreadRepo(db, agentStorageTestWriter(db));
    workspaceRepo = new RealWorkspaceRepo(db, agentStorageTestWriter(db));
    messageRepo = new RealMessageRepo(db, agentStorageTestWriter(db));
    const toolCallRecordRepo = new RealToolCallRecordRepo(db, agentStorageTestWriter(db));
    const thoughtSegmentRepo = new RealThoughtSegmentRepo(db, agentStorageTestWriter(db));
    const hookExecutionRepo = new RealHookExecutionRepo(db, agentStorageTestWriter(db));
    providerEmitter = wrapProviderEmitterForRuntimeEvents(Object.assign(new NodeEvents.EventEmitter(), {
      id: "codex" as ProviderId,
      descriptor: {
        capabilities: [{ name: "child-cancellation", support: "supported" }],
      },
      sendTurn: vi.fn((request: TurnRequest) => { lastTurnRequest = request; return Promise.resolve(); }),
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
      captureRef: vi.fn(() => Promise.resolve("ref-before")),
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
    canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), canonicalWriter, (events) => {
      canonicalEvents.push(...events);
    });
    const progress = new CanonicalAcceptedProgress(canonicalSink, canonicalWriter);
    canonicalSink.bindAcceptedSynthesizedPublications((threadId, events) => progress.acceptSynthesizedPublications(threadId, events));
    pendingPlanOutputs = new Map<string, string>();
    const planTurns = Object.assign(Object.create(PlanTurnService.prototype), {
      beginOutputGeneration: () => undefined,
      beginQuestionGeneration: () => undefined,
      buildQuestionPrompt: (content: string) => content,
      buildPlanOutputInstructions: () => "",
      onTextDelta: () => undefined,
      needsAssistantMaterialization: () => false,
      persistAssistantMessage: () => undefined,
      clearTurn: (threadId: string) => {
        pendingPlanOutputs.delete(threadId);
      },
    }) as PlanTurnService;
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
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      new NarrativeStore(messageRepo, toolCallRecordRepo, thoughtSegmentRepo, hookExecutionRepo),
      new ParentAssistantTextCheckpointService(db, agentStorageTestWriter(db)),
      undefined,
      undefined,
      undefined,
      canonicalSink,
      undefined,
      undefined,
      planTurns,
      undefined,
      new SubagentLifecycleService(canonicalSink, providerRegistry),
    );
    const fixtureService = service;
    registerAgentStorageTestProducer(db, async () => {
      await drainAgentServicePersistenceForTest(fixtureService);
      await progress.close();
    });
    startAgentServiceIngressForTest(service, (event) => {
      publishParentProviderEvent(event, {
        updateThreadStatus: (threadId, status) => threadRepo.updateStatus(threadId, status),
        publishThreadStatus: (payload) => broadcast("thread.status", payload),
      });
    });
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

  it.each(["error", "turnComplete", "ended"] as const)(
    "keeps an explicit stop authoritative when provider emits %s synchronously",
    async (terminalType) => {
      const workspace = await workspaceRepo.create("Test", process.cwd());
      const thread = await threadRepo.create(workspace.id, `Stop ${terminalType}`, "direct", "main", true, "codex");

      await service.sendMessage({
        threadId: thread.id,
        content: "stop this turn",
        permissionMode: "default",
        model: "gpt-5",
        attachments: [],
        provider: "codex",
      });
      const executionId = activeExecutionId(service, thread.id);
      providerEmitter.stopSession.mockImplementation(() => {
        if (terminalType === "error") {
          providerEmitter.emit("event", {
            type: AgentEventType.Error,
            threadId: thread.id,
            turnExecutionId: executionId,
            error: "provider stopped",
          } satisfies AgentEvent);
        } else if (terminalType === "turnComplete") {
          providerEmitter.emit("event", {
            type: AgentEventType.TurnComplete,
            threadId: thread.id,
            turnExecutionId: executionId,
            reason: "stopped",
            costUsd: null,
            tokensIn: 0,
            tokensOut: 0,
          } satisfies AgentEvent);
        } else {
          providerEmitter.emit("event", {
            type: AgentEventType.Ended,
            threadId: thread.id,
            turnExecutionId: executionId,
          } satisfies AgentEvent);
        }
      });

      await expect(service.stopSession(thread.id)).resolves.toMatchObject({
        status: "cancelled",
        turnExecutionId: executionId,
      });
      await vi.waitFor(() => expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
        phase: "cancelled",
        terminalOutcome: "cancelled",
      }));
      expect(threadRepo.findById(thread.id)?.status).toBe("paused");
      expect(broadcast).not.toHaveBeenCalledWith("thread.status", {
        threadId: thread.id,
        status: "completed",
      });
      expect(broadcast).not.toHaveBeenCalledWith("thread.status", {
        threadId: thread.id,
        status: "errored",
      });
      expect(broadcast).not.toHaveBeenCalledWith("thread.status", {
        threadId: thread.id,
        status: "interrupted",
      });
    },
  );

  it("does not materialize a queued goal receipt after Error rejects a trailing completion", async () => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Terminal error", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "finish this turn",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    const appendChunk = ParentAssistantTextCheckpointService.prototype.appendChunk;
    let queuedTrailingEvents = false;
    const appendChunkSpy = vi.spyOn(ParentAssistantTextCheckpointService.prototype, "appendChunk")
      .mockImplementation(function(this: ParentAssistantTextCheckpointService, inputs) {
        if (!queuedTrailingEvents) {
          queuedTrailingEvents = true;
          providerEmitter.emit("event", {
            type: AgentEventType.TurnComplete,
            threadId: thread.id,
            turnExecutionId: executionId,
            reason: "end_turn",
            costUsd: null,
            tokensIn: 1,
            tokensOut: 1,
            contextWindow: 200000,
            totalProcessedTokens: 2,
            providerId: "codex",
          } satisfies AgentEvent);
          providerEmitter.emit("event", {
            type: AgentEventType.Message,
            threadId: thread.id,
            turnExecutionId: executionId,
            content: "Goal achieved in 2s.",
            tokens: null,
          } satisfies AgentEvent);
        }
        return appendChunk.call(this, inputs);
      });
    try {
      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: thread.id,
        turnExecutionId: executionId,
        delta: "final text",
        isFinalResponse: true,
      } satisfies AgentEvent);
      providerEmitter.emit("event", {
        type: AgentEventType.Error,
        threadId: thread.id,
        turnExecutionId: executionId,
        error: "provider failed",
      } satisfies AgentEvent);
      await waitForAgentServiceIngressForTest(service, thread.id);

      await vi.waitFor(() => expect(canonicalSink.loadCheckpoint(executionId)?.terminalOutcome).toBe("errored"));
      await finalizerForAgentServiceTest(service).drain();
      expect(queuedTrailingEvents).toBe(true);
      expect(service.runtimeAccess().runtimeSnapshots())
        .toContainEqual(expect.objectContaining({ threadId: thread.id, phase: "errored" }));
      expect(messageRepo.listByThread(thread.id, 10).messages)
        .not.toContainEqual(expect.objectContaining({ role: "assistant", content: "Goal achieved in 2s." }));
    } finally {
      appendChunkSpy.mockRestore();
    }
  });

  it("stops every running canonical descendant through the public parent stop seam", async () => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Parent thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "delegate nested work",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    const parentTurn = canonicalSink.loadTurnByExecution(executionId);
    expect(parentTurn).not.toBeNull();

    const direct = await canonicalSink.startCodexChildDelegation({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:direct-child",
      receiverThreadIds: ["native-direct-thread"],
      providerIdentities: [],
    });
    const directTurn = await canonicalSink.startCodexChildTurn({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:direct-child",
      nativeThreadId: "native-direct-thread",
      nativeTurnId: "native-direct-turn",
    });
    const nested = await canonicalSink.startCodexChildDelegation({
      parentThreadId: direct.childThread.id,
      parentTurnId: directTurn.id,
      parentExecutionId: canonicalSink.loadExecutionIdForTurn(directTurn.id),
      parentItemId: "toolCall:nested-child",
      receiverThreadIds: ["native-nested-thread"],
      providerIdentities: [],
    });
    await canonicalSink.startCodexChildTurn({
      parentThreadId: direct.childThread.id,
      parentTurnId: directTurn.id,
      parentExecutionId: canonicalSink.loadExecutionIdForTurn(directTurn.id),
      parentItemId: "toolCall:nested-child",
      nativeThreadId: "native-nested-thread",
      nativeTurnId: "native-nested-turn",
    });
    const sibling = await canonicalSink.startCodexChildDelegation({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:completed-sibling",
      receiverThreadIds: ["native-sibling-thread"],
      providerIdentities: [],
    });
    await canonicalSink.startCodexChildTurn({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:completed-sibling",
      nativeThreadId: "native-sibling-thread",
      nativeTurnId: "native-sibling-turn",
    });
    await canonicalSink.finishCodexChildTurn({
      childThreadId: sibling.childThread.id,
      nativeTurnId: "native-sibling-turn",
      outcome: "completed",
    });

    expect(canonicalSink.loadCanonicalChildStopTargets(thread.id).map((target) => [
      target.childThread.id,
      target.latestTurn?.status,
    ])).toEqual(expect.arrayContaining([
      [direct.childThread.id, "Running"],
      [nested.childThread.id, "Running"],
    ]));
    expect(service.runtimeAccess().runtimeSnapshots().find((snapshot) => snapshot.threadId === thread.id))
      .toMatchObject({ phase: "running", turnExecutionId: executionId });

    pendingPlanOutputs.set(thread.id, "# plan\n\n## Stop-safe cleanup");
    expect(pendingPlanOutputs.has(thread.id)).toBe(true);

    providerEmitter.interruptChildTurn.mockRejectedValueOnce(new Error("child interrupt unavailable"));
    providerEmitter.stopSession.mockImplementation(() => {
      providerEmitter.emit("event", {
        type: AgentEventType.Ended,
        threadId: thread.id,
        turnExecutionId: activeExecutionId(service, thread.id),
      } satisfies AgentEvent);
    });
    const result = await service.stopSession(thread.id);

    expect(result.status).toBe("cancelled");
    // Descendant interrupts and the provider stop run detached after the RPC.
    await vi.waitFor(() => expect(providerEmitter.stopSession).toHaveBeenCalledOnce());
    expect(providerEmitter.interruptChildTurn).toHaveBeenCalledTimes(2);
    expect(providerEmitter.interruptChildTurn).toHaveBeenCalledWith(
      `mcode-${thread.id}`,
      "native-nested-thread",
      "native-nested-turn",
    );
    expect(providerEmitter.interruptChildTurn).toHaveBeenCalledWith(
      `mcode-${thread.id}`,
      "native-direct-thread",
      "native-direct-turn",
    );
    expect(Math.max(...providerEmitter.interruptChildTurn.mock.invocationCallOrder))
      .toBeLessThan(providerEmitter.stopSession.mock.invocationCallOrder[0]!);
    await vi.waitFor(() => expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: direct.childThread.id,
    })?.latestTurn?.status).toBe("Interrupted"));
    await vi.waitFor(() => expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: nested.childThread.id,
    })?.latestTurn?.status).toBe("Interrupted"));
    expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: sibling.childThread.id,
    })?.latestTurn?.status).toBe("Completed");
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(thread.id);
    expect(threadRepo.findById(thread.id)?.status).toBe("paused");
    expect(broadcast).not.toHaveBeenCalledWith("thread.status", {
      threadId: thread.id,
      status: "interrupted",
    });
    await vi.waitFor(() => expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
      phase: "cancelled",
      terminalOutcome: "cancelled",
    }));
    expect(canonicalSink.loadTurnByExecution(executionId)?.status).toBe("Cancelled");
    expect(pendingPlanOutputs.has(thread.id)).toBe(false);
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

    const result = await service.stopSession(thread.id);

    expect(result.status).toBe("cancelled");
    expect(providerEmitter.interruptChildTurn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: child.childThread.id,
    })?.latestTurn?.status).toBe("Interrupted"));
  });

  it("waits for a provider terminal outcome during graceful stopAll", async () => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Parent thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "delegate work before shutdown",
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
      parentItemId: "toolCall:shutdown-child",
      receiverThreadIds: ["native-shutdown-thread"],
      providerIdentities: [],
    });
    await canonicalSink.startCodexChildTurn({
      parentThreadId: thread.id,
      parentTurnId: parentTurn!.id,
      parentExecutionId: executionId,
      parentItemId: "toolCall:shutdown-child",
      nativeThreadId: "native-shutdown-thread",
      nativeTurnId: "native-shutdown-turn",
    });

    let snapshotAtProviderStop: ReturnType<typeof canonicalSink.loadCheckpoint> = null;
    let resolveProviderStop: (() => void) | undefined;
    providerEmitter.stopSession.mockImplementation(() => new Promise<void>((resolve) => {
      snapshotAtProviderStop = canonicalSink.loadCheckpoint(executionId);
      resolveProviderStop = () => {
        providerEmitter.emit("event", {
          type: AgentEventType.Ended,
          threadId: thread.id,
          turnExecutionId: executionId,
          outcome: "cancelled",
        } satisfies AgentEvent);
        resolve();
      };
    }));
    const stopping = service.stopAll();
    let stopAllCompleted = false;
    void stopping.then(() => {
      stopAllCompleted = true;
    });

    await vi.waitFor(() => expect(snapshotAtProviderStop).toMatchObject({
      phase: "running",
      terminalOutcome: null,
    }));
    expect(stopAllCompleted).toBe(false);
    if (!resolveProviderStop) throw new Error("Expected stopAll to await the provider stop");
    resolveProviderStop();
    await stopping;
    expect(stopAllCompleted).toBe(true);
    await vi.waitFor(() => expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
      phase: "interrupted",
      terminalOutcome: "interrupted",
    }));
    expect(canonicalSink.loadCanonicalChildStopTarget({
      owningParentThreadId: thread.id,
      childThreadId: child.childThread.id,
    })?.latestTurn?.status).toBe("Interrupted");
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(thread.id);
    expect(providerEmitter.stopSession).toHaveBeenCalledWith(`mcode-${thread.id}`);
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

  it("releases an exact provider_lost Ended without terminalizing its durable turn", async () => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Lost provider thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "release this lost provider runtime",
      permissionMode: "default",
      model: "gpt-5",
      attachments: [],
      provider: "codex",
    });
    const executionId = activeExecutionId(service, thread.id);
    if (!lastTurnRequest) throw new Error("Expected dispatched provider request");
    const update: ProviderTurnDiffUpdate = {
      turnId: lastTurnRequest.turnId, turnExecutionId: executionId,
      deliveryAttempt: lastTurnRequest.deliveryAttempt ?? 1, revision: 1, state: "snapshot", nativeFidelity: "agent",
      patch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
    };
    providerEmitter.emit("turn-diff", update);
    const turnDiffs = turnDiffsForAgentServiceTest(service);
    expect(turnDiffs.liveComparison(thread.id)?.files.map((file) => file.path)).toEqual(["a.txt"]);

    providerEmitter.emit("event", {
      type: AgentEventType.Ended,
      threadId: thread.id,
      turnExecutionId: executionId,
      reason: "provider_lost",
    } satisfies AgentEvent);

    await vi.waitFor(() => expect(service.runtimeAccess().runtimeSnapshots()
      .find((snapshot) => snapshot.threadId === thread.id)).toBeUndefined());
    expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
      phase: "running",
      terminalOutcome: null,
    });
    expect(threadRepo.findById(thread.id)?.status).toBe("active");
    expect(service.runtimeAccess().activeThreadIds()).not.toContain(thread.id);
    expect(turnDiffs.liveComparison(thread.id)).toBeNull();
    expect(turnDiffs.latest(thread.id)).toBeUndefined();
    providerEmitter.emit("turn-diff", { ...update, revision: 2 });
    expect(turnDiffs.liveComparison(thread.id)).toBeNull();
  });

  it("maps provider-cancelled Ended to the recoverable interrupted outcome", async () => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Cancelled provider thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "cancel this turn",
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
      outcome: "cancelled",
    } satisfies AgentEvent);

    await vi.waitFor(() => {
      expect(canonicalSink.loadCheckpoint(executionId)).toMatchObject({
        phase: "interrupted",
        terminalOutcome: "interrupted",
      });
    });
    // Publication saves the thread status after the checkpoint commits, without awaiting it.
    await vi.waitFor(() => {
      expect(threadRepo.findById(thread.id)?.status).toBe("interrupted");
      expect(broadcast).toHaveBeenCalledWith("thread.status", {
        threadId: thread.id,
        status: "interrupted",
      });
    }, { timeout: 5_000 });
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

  it("keeps a provider Error consistent across canonical, legacy, and renderer state", async () => {
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
      content: "partial answer before failure",
      tokens: null,
    } satisfies AgentEvent);
    providerEmitter.emit("event", {
      type: AgentEventType.Error,
      threadId: thread.id,
      turnExecutionId: executionId,
      error: "provider failed",
    } satisfies AgentEvent);
    await vi.waitFor(() => expect(canonicalSink.loadCheckpoint(executionId)?.terminalOutcome).toBe("errored"));

    const { messages } = messageRepo.listByThread(thread.id, 10);
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant).toMatchObject({
      outcome: "errored",
      outcomeExecutionId: executionId,
    });
    expect(canonicalSink.loadTurnByExecution(executionId)?.status).toBe("Errored");
    expect(canonicalSink.loadConversationProjection(thread.id, 10).messages)
      .toContainEqual(expect.objectContaining({ id: assistant?.id, outcome: "errored" }));
    // Canonical events reach the renderer after the checkpoint commits, so the reduced state converges later.
    await vi.waitFor(() => expect(reduceAgentEventBatch(createAgentModelState(), canonicalEvents)).toMatchObject({
      outcome: "applied",
      state: {
        turns: {
          [canonicalSink.loadTurnByExecution(executionId)!.id]: expect.objectContaining({
            status: "Errored",
          }),
        },
      },
    }), { timeout: 5_000 });
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: thread.id,
      messageId: assistant?.id,
      outcome: "errored",
      executionId,
    })));
  });

  it("keeps a completed turn completed when a provider sends a late error", async () => {
    const workspace = await workspaceRepo.create("Test", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Completed thread", "direct", "main", true, "codex");

    await service.sendMessage({
      threadId: thread.id,
      content: "complete this turn",
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
      content: "completed answer",
      tokens: null,
    } satisfies AgentEvent);
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: thread.id,
      turnExecutionId: executionId,
      reason: "end_turn",
      costUsd: null,
      tokensIn: 1,
      tokensOut: 1,
      providerId: "codex",
    } satisfies AgentEvent);

    await vi.waitFor(() => expect(canonicalSink.loadCheckpoint(executionId)?.terminalOutcome).toBe("completed"));
    providerEmitter.emit("event", {
      type: AgentEventType.Error,
      threadId: thread.id,
      turnExecutionId: executionId,
      error: "late provider failure",
    } satisfies AgentEvent);
    await waitForAgentServiceIngressForTest(service, thread.id);
    const turn = canonicalSink.loadTurnByExecution(executionId);
    const assistant = messageRepo.listByThread(thread.id, 10).messages
      .find((message) => message.role === "assistant");
    expect(turn?.status).toBe("Completed");
    expect(assistant).toMatchObject({ outcome: "completed", outcomeExecutionId: executionId });
    expect(canonicalSink.loadConversationProjection(thread.id, 10).messages)
      .toContainEqual(expect.objectContaining({ id: assistant?.id, outcome: "completed" }));
    expect(reduceAgentEventBatch(createAgentModelState(), canonicalEvents)).toMatchObject({
      outcome: "applied",
      state: {
        turns: {
          [turn!.id]: expect.objectContaining({ status: "Completed" }),
        },
      },
    });
    expect(broadcast).toHaveBeenCalledWith("turn.persisted", expect.objectContaining({
      threadId: thread.id,
      messageId: assistant?.id,
      outcome: "completed",
      executionId,
    }));
  });
});
