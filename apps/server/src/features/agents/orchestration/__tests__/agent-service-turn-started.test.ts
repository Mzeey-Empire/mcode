import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as NodeEvents from "node:events";
import type { Database } from "bun:sqlite";
import { AgentEventType } from "@mcode/contracts";
import type {
  IAgentProvider,
  IProviderRegistry,
  ProviderId,
  ProviderRuntimeEvent,
} from "@mcode/contracts";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import { TurnSnapshotRepo } from "../../turns/persistence/turn-snapshot-repo.js";
import { AgentService } from "../agent-service.js";
import { createAgentServiceForTest, startAgentServiceIngressForTest, wrapProviderEmitterForRuntimeEvents } from "./agent-service-test-harness.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import type { GitService } from "../../../projects/index.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService, MemoryPressureSnapshot } from "../../../../runtime/memory/memory-pressure-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";

/**
 * Test harness for AgentService.sendMessage "turn started" emission.
 *
 * The provider is stubbed with an EventEmitter whose sendMessage() returns a
 * never-resolving promise, so we can assert the turnStarted event lands on the
 * EventEmitter bus BEFORE provider.sendMessage() completes.
 */
describe("AgentService.sendMessage emits TurnStarted", () => {
  let db: Database;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let messageRepo: MessageRepo;
  let toolCallRecordRepo: ToolCallRecordRepo;
  let turnSnapshotRepo: TurnSnapshotRepo;
  let svc: AgentService;
  let canonicalSink: CanonicalAgentBoundary;
  let providerStub: NodeEvents.EventEmitter & Partial<IAgentProvider> & {
    sendTurn: ReturnType<typeof vi.fn>;
  };
  let capturedEvents: ProviderRuntimeEvent[];
  // Snapshot of capturedEvents.length taken synchronously when the provider's
  // sendMessage body is entered. If emit truly precedes the call, this must be >= 1.
  let eventsLengthAtSendMessageEntry: number;
  let pressureListener: ((snapshot: MemoryPressureSnapshot) => void) | undefined;
  let memoryActivation: ReturnType<typeof vi.fn<() => void>>;
  let attachmentGate: Promise<void> | undefined;

  beforeEach(() => {
    pressureListener = undefined;
    attachmentGate = undefined;
    memoryActivation = vi.fn();
    db = openAgentStorageTestDatabase();
    const writer = agentStorageTestWriter(db);
    threadRepo = new ThreadRepo(db, writer);
    workspaceRepo = new WorkspaceRepo(db, writer);
    messageRepo = new MessageRepo(db, writer);
    toolCallRecordRepo = new ToolCallRecordRepo(db, writer);
    turnSnapshotRepo = new TurnSnapshotRepo(db, writer);

    // Capture runtime envelopes emitted on the provider bus.
    capturedEvents = [];
    eventsLengthAtSendMessageEntry = -1;
    providerStub = wrapProviderEmitterForRuntimeEvents(Object.assign(new NodeEvents.EventEmitter(), {
      id: "claude" as ProviderId,
      supportsCompletion: false,
      sessionForkOnResume: "unsupported" as const,
      maxInputCharactersPerTurn: 16_000,
      // Never resolves. We want to observe events emitted BEFORE completion.
      // Snapshot capturedEvents.length synchronously on entry: this is the
      // load-bearing ordering signal. If the emit happened BEFORE the call
      // entered (correct order), this will be >= 1.
      sendTurn: vi.fn(() => {
        eventsLengthAtSendMessageEntry = capturedEvents.length;
        return new Promise<void>(() => {});
      }),
      stopSession: vi.fn(),
      shutdown: vi.fn(),
    }));
    providerStub.on("event", (event: ProviderRuntimeEvent) => capturedEvents.push(event));

    const registryStub: IProviderRegistry = {
      resolve: () => providerStub as unknown as IAgentProvider,
      resolveAll: () => [providerStub as unknown as IAgentProvider],
      shutdown: async () => {},
    };

    const gitServiceStub = {
      // process.cwd() is guaranteed to be a real absolute directory, satisfying
      // AgentService's isAbsolute/existsSync/statSync validation.
      resolveWorkingDir: vi.fn(() => process.cwd()),
    } as unknown as GitService;

    const attachmentServiceStub = {
      persist: vi.fn(async () => { await attachmentGate; return { stored: [], persisted: [] }; }),
    } as unknown as AttachmentService;

    const snapshotServiceStub = {
      captureRef: vi.fn(async () => "ref-before-sha"),
    } as unknown as SnapshotService;

    const memoryPressureServiceStub = {
      markActive: memoryActivation,
      markIdle: vi.fn(),
      onPressureChange: vi.fn((listener: (snapshot: MemoryPressureSnapshot) => void) => { pressureListener = listener; return () => { pressureListener = undefined; }; }),
    } as unknown as MemoryPressureService;

    const settingsServiceStub = {
      get: vi.fn(async () => ({
        model: { defaults: { fallbackId: undefined } },
        agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
      })),
    } as unknown as SettingsService;

    // ThreadService is lazy-resolved via tsyringe's delay(), so a shallow stub is fine.
    const threadServiceStub = {} as unknown as ThreadService;

    // Availability gate is a no-op stub — turn-started emission is orthogonal to
    // provider enable/disable checks.
    const availabilityStub = {
      assertUsable: vi.fn(),
    } as unknown as ProviderAvailabilityService;

    canonicalSink = new CanonicalAgentBoundary(db, writer, new CanonicalAgentWriterClient(writer), vi.fn());
    svc = createAgentServiceForTest(
      threadRepo,
      workspaceRepo,
      messageRepo,
      gitServiceStub,
      attachmentServiceStub,
      registryStub,
      threadServiceStub,
      turnSnapshotRepo,
      snapshotServiceStub,
      db,
      memoryPressureServiceStub,
      settingsServiceStub,
      availabilityStub,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      new NarrativeStore(
        messageRepo,
        toolCallRecordRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../conversation/narrative/persistence/thought-segment-repo.js").ThoughtSegmentRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../events/persistence/hook-execution-repo.js").HookExecutionRepo,
      ),
      new ParentAssistantTextCheckpointService(db, writer),
      undefined,
      undefined,
      undefined,
      canonicalSink,
    );
  });

  afterEach(async () => {
    try { await svc?.stopAll(); }
    finally { await closeAgentStorageTestDatabases(); }
  });

  it("emits turnStarted through the provider before provider.sendMessage resolves", async () => {
    const workspace = await workspaceRepo.create("test-ws", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Test Thread", "direct", "main", true, "claude");

    // Kick off sendMessage without awaiting (provider.sendMessage never resolves).
    void svc.sendMessage({
      threadId: thread.id,
      content: "hello",
      permissionMode: "default",
      sourceTurnId: "canonical-source-turn",
    });

    // Let the async prelude (attachment persist + ref capture + settings.get) settle.
    await vi.waitFor(() => expect(providerStub.sendTurn).toHaveBeenCalledTimes(1));

    // TurnStarted must be the FIRST event on the bus (nothing precedes it).
    expect(capturedEvents.length, "expected at least one event on the bus").toBeGreaterThan(0);
    expect(capturedEvents[0]?.event).toMatchObject({
      type: AgentEventType.TurnStarted,
      threadId: thread.id,
    });
    const executionId = capturedEvents[0]!.event.turnExecutionId;
    if (!executionId) throw new Error("TurnStarted has no execution identity");
    expect(canonicalSink.loadTurnByExecution(executionId)).toMatchObject({
      threadId: thread.id,
      status: "Running",
      providerIdentities: [],
    });
    expect(canonicalSink.loadConversationProjection(thread.id, 10).messages).toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
    ]);

    // Load-bearing ordering assertion: the snapshot taken synchronously inside
    // the provider's sendMessage body must show the TurnStarted emit had already
    // landed on the bus BEFORE the call entered. This is the real "emit precedes
    // call" proof, not just "emit precedes the (never-resolving) promise".
    expect(
      eventsLengthAtSendMessageEntry,
      "expected capturedEvents.length >= 1 at sendMessage entry (emit must precede call)",
    ).toBeGreaterThanOrEqual(1);

    // Guard against accidental double-emission on resume/retry paths.
    const turnStartedCount = capturedEvents.filter(
      (runtimeEvent) => runtimeEvent.event.type === AgentEventType.TurnStarted,
    ).length;
    expect(turnStartedCount, "turnStarted must be emitted exactly once").toBe(1);
    expect(svc.runtimeAccess().runtimeSnapshots()).toContainEqual(expect.objectContaining({
      threadId: thread.id,
      phase: "running",
    }));

    // Provider.sendTurn must have been invoked. Confirms the emit happened
    // during sendTurn flow, not via some other path.
    expect(providerStub.sendTurn).toHaveBeenCalledTimes(1);
    expect(providerStub.sendTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "canonical-source-turn",
    }));
  });

  it("protects admission before native dispatch and releases the live pressure authority on stop", async () => {
    const workspace = await workspaceRepo.create("pressure-ws", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Preparing Turn", "direct", "main", true, "claude");
    const pressure: MemoryPressureSnapshot = { level: "critical", source: "process-rss", usedBytes: 700, budgetBytes: 512, ratio: 700 / 512 };
    const shedMemoryPressure = vi.fn<(level: MemoryPressureSnapshot["level"], isThreadProtected: (threadId: string) => boolean) => Promise<void>>().mockResolvedValue(undefined);
    Object.assign(providerStub, { shedMemoryPressure });
    providerStub.sendTurn.mockResolvedValue(undefined);
    startAgentServiceIngressForTest(svc);
    memoryActivation.mockImplementation(() => { pressureListener?.(pressure); });
    let releaseAttachments!: () => void;
    attachmentGate = new Promise<void>((resolve) => { releaseAttachments = resolve; });
    const sending = svc.sendMessage({ threadId: thread.id, content: "hello", permissionMode: "full" });
    try {
      await vi.waitFor(() => expect(shedMemoryPressure).toHaveBeenCalledOnce());
      expect(providerStub.sendTurn).not.toHaveBeenCalled();
      const isThreadProtected = shedMemoryPressure.mock.calls[0]?.[1];
      if (!isThreadProtected) throw new Error("Memory shedding has no admission authority");
      expect(isThreadProtected(thread.id)).toBe(true);
      expect(isThreadProtected("unrelated-idle-thread")).toBe(false);
      releaseAttachments();
      await sending;
      await svc.stopSession(thread.id);
      expect(isThreadProtected(thread.id)).toBe(false);
      pressureListener?.(pressure);
      expect(shedMemoryPressure).toHaveBeenCalledTimes(2);
      expect(shedMemoryPressure.mock.calls[1]?.[1](thread.id)).toBe(false);
    } finally {
      releaseAttachments();
      await sending;
    }
  });

  it("starts canonical providers through AgentService without leaving terminal suppression behind", async () => {
    Object.assign(providerStub, {
      id: "cursor" as ProviderId,
      descriptor: {
        id: "cursor",
        capabilities: [{ name: "approval-review", support: "supported" }],
      },
      getApprovalReviewSupport: async () => ({
        status: "available" as const,
        supportedModes: ["manual", "automatic"] as const,
        reason: "automatic-review-available",
        liveChangeScope: "none" as const,
      }),
    });
    startAgentServiceIngressForTest(svc);
    const workspace = await workspaceRepo.create("test-ws", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Cursor Thread", "direct", "main", true, "cursor");
    void svc.sendMessage({
      threadId: thread.id,
      content: "hello",
      permissionMode: "default",
      approvalReviewMode: "automatic",
      sourceTurnId: "canonical-cursor-turn",
    });
    await vi.waitFor(() => expect(providerStub.sendTurn).toHaveBeenCalledTimes(1));

    expect(svc.runtimeAccess().activeThreadIds()).toContain(thread.id);
    expect(providerStub.sendTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "canonical-cursor-turn",
      permissionMode: "supervised",
      approvalReviewMode: "automatic",
    }));
    const request = providerStub.sendTurn.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    const persistedTurn = canonicalSink.loadTurnByExecution(request!.turnExecutionId);
    expect(persistedTurn).toMatchObject({
      permissionMode: "supervised",
      approvalReviewMode: "automatic",
      approvalReviewReason: "automatic-review-available",
    });

    providerStub.emit("event", {
      type: AgentEventType.TextDelta,
      threadId: thread.id,
      turnExecutionId: request!.turnExecutionId,
      delta: "Reviewing approval request.",
    });
    providerStub.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: thread.id,
      turnExecutionId: request!.turnExecutionId,
      toolCallId: "approval-review:test-id",
      toolName: "Approval review",
      toolInput: { status: "reviewing" },
    });
    const approved: ProviderRuntimeEvent = {
      event: {
        type: AgentEventType.ToolResult,
        threadId: thread.id,
        turnExecutionId: request!.turnExecutionId,
        toolCallId: "approval-review:test-id",
        output: "approved",
        isError: false,
      },
    };
    providerStub.emit("event", approved);
    providerStub.emit("event", approved);
    await vi.waitFor(() => {
      const item = db.query<{ payload_json: string }, [string]>(
        "SELECT payload_json FROM canonical_agent_items WHERE id = ?",
      ).get("toolCall:approval-review:test-id");
      expect(item && JSON.parse(item.payload_json)).toMatchObject({
        narrative: { record: { output_summary: "approved", status: "completed" } },
      });
    });
    const reviewItems = db.prepare(
      "SELECT id, payload_json FROM canonical_agent_items WHERE id = ?",
    ).all("toolCall:approval-review:test-id") as Array<{ id: string; payload_json: string }>;
    expect(reviewItems).toHaveLength(1);
    expect(JSON.parse(reviewItems[0]!.payload_json)).toMatchObject({
      narrative: { record: { id: "approval-review:test-id", output_summary: "approved", status: "completed" } },
    });

  });

  it("dispatches Full Access as manual approval review without creating an approval lifecycle", async () => {
    Object.assign(providerStub, {
      id: "cursor" as ProviderId,
      descriptor: {
        id: "cursor",
        capabilities: [{ name: "approval-review", support: "supported" }],
      },
      getApprovalReviewSupport: async () => ({
        status: "available" as const,
        supportedModes: ["manual", "automatic"] as const,
        reason: "automatic-review-available",
        liveChangeScope: "none" as const,
      }),
    });
    startAgentServiceIngressForTest(svc);
    const workspace = await workspaceRepo.create("test-ws", process.cwd());
    const thread = await threadRepo.create(workspace.id, "Full Access Cursor Thread", "direct", "main", true, "cursor");
    void svc.sendMessage({
      threadId: thread.id,
      content: "hello",
      permissionMode: "full",
      approvalReviewMode: "automatic",
      sourceTurnId: "full-access-cursor-turn",
    });
    await vi.waitFor(() => expect(providerStub.sendTurn).toHaveBeenCalledTimes(1));

    expect(providerStub.sendTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "full-access-cursor-turn",
      permissionMode: "full",
      approvalReviewMode: "manual",
    }));
    const request = providerStub.sendTurn.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(canonicalSink.loadTurnByExecution(request!.turnExecutionId)).toMatchObject({
      permissionMode: "full",
      approvalReviewMode: "manual",
      approvalReviewReason: "full-access-bypasses-approval-review",
    });
    const reviewItems = db.prepare(
      "SELECT id FROM canonical_agent_items WHERE id LIKE 'toolCall:approval-review:%'",
    ).all();
    expect(reviewItems).toHaveLength(0);
  });
});
