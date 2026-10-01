import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { AgentEventType, CanonicalAgentProgressFrameSchema, ProviderRuntimeEventSchema } from "@mcode/contracts";
import type {
  AgentEvent,
  IProviderRegistry,
  ProviderRuntimeEvent,
  ProviderRuntimeExtension,
} from "@mcode/contracts";
import { AgentService } from "../agent-service.js";
import {
  continueAgentTurnWithoutSavingForTest,
  createAgentServiceForTest,
  finalizerForAgentServiceTest,
  messageRepoForAgentServiceTest,
  runtimeProviderEvent,
  startAgentServiceIngressForTest,
  startProviderTurnForTest,
  streamAgentReliabilityTextForTest,
  waitForAgentServiceIngressForTest as waitForCoreIngress,
} from "./agent-service-test-harness.js";
import { createCanonicalAgentBoundaryStub } from "../../canonical/__tests__/canonical-agent-boundary-stub.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { TaskPersistenceService } from "../../tasks/task-persistence-service.js";
import {
  ParentAssistantTextCheckpointService,
  PARENT_ASSISTANT_TEXT_RETAINED_LIMITS,
} from "../../turns/parent-assistant-text-checkpoint-service.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";
import { MessageStore } from "../../conversation/persistence/message-store.js";
import { TaskStore } from "../persistence/task-store.js";
import { broadcast } from "../../../../application/transport/push.js";
import { isTurnScopedEvent } from "../../turns/turn-runtime.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import type { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { MessageRepo as SqliteMessageRepo } from "../../conversation/persistence/message-repo.js";
import type { GitService } from "../../../projects/index.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import {
  ToolCallRecordRepo,
  type CreateToolCallRecordInput,
} from "../../tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo, type CreateThoughtSegmentInput } from "../../conversation/narrative/persistence/thought-segment-repo.js";
import { HookExecutionRepo, type CreateHookExecutionInput } from "../../events/persistence/hook-execution-repo.js";
import { TurnSnapshotRepo } from "../../turns/persistence/turn-snapshot-repo.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import { TaskRepo } from "../persistence/task-repo.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import type { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";

function normalizedNarrativeProviderEvent(event: Record<string, unknown>): Record<string, unknown> {
  return event.type === AgentEventType.TurnComplete
    ? { reason: "completed", costUsd: null, ...event }
    : event;
}

function needsNarrativeTurnExecutionId(event: unknown): event is Record<string, unknown> {
  return Boolean(
    event
    && typeof event === "object"
    && isTurnScopedEvent(event as Parameters<typeof isTurnScopedEvent>[0])
    && !(event as { turnExecutionId?: string }).turnExecutionId,
  );
}

function providerRuntimeEventForNarrativeTest(eventName: string, event: unknown): unknown {
  if (eventName !== "event" || !event || typeof event !== "object" || "event" in event) return event;
  return runtimeProviderEvent(event as AgentEvent);
}
import { ProviderEventIngress } from "../../../providers/composition/provider-event-ingress.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));

const THREAD_ID = "t-narr";
const MSG_ID = "msg-narr";
function openMemoryDatabase(): Database { return openAgentStorageTestDatabase(); }

const providerCommits = new Map<AgentService, () => Promise<void>>();

afterEach(async () => {
  for (const [service, committed] of providerCommits) {
    await committed();
    await waitForCoreIngress(service, THREAD_ID);
  }
  providerCommits.clear();
  await closeAgentStorageTestDatabases();
});

function defaultNarrativeDatabase(): Database {
  const db = openMemoryDatabase();
  const now = new Date().toISOString();
  db.run("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", ["ws-1", "Workspace", "/workspace", now, now]);
  db.run("INSERT INTO threads (id, workspace_id, title, branch, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [THREAD_ID, "ws-1", "Parent", "main", "claude", "claude-sonnet-4-6", now, now]);
  new MessageStore(db).create(THREAD_ID, "assistant", "", 2, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { type: "composer" }, MSG_ID);
  new MessageStore(db).create(THREAD_ID, "user", "Start", 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { type: "composer" }, "user-narr");
  new TaskStore(db).upsert(THREAD_ID, [{ id: "1", content: "Original task", status: "pending", group: "Tasks" }, { id: "3", content: "Removable task", status: "pending", group: "Tasks" }]);
  return db;
}

async function waitForSavedNarrativeTurn(service: AgentService): Promise<void> {
  await waitForAgentServiceIngressForTest(service, THREAD_ID);
  await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith("turn.persisted", expect.objectContaining({ threadId: THREAD_ID })));
  await finalizerForAgentServiceTest(service).drain();
}

async function waitForAgentServiceIngressForTest(service: AgentService, threadId: string): Promise<void> {
  await providerCommits.get(service)?.();
  await waitForCoreIngress(service, threadId);
}

function narrativeExecutionId(service: AgentService): string {
  const executionId = service.runtimeAccess().runtimeSnapshots()
    .find((snapshot) => snapshot.threadId === THREAD_ID)?.turnExecutionId;
  if (!executionId) throw new Error("Expected a narrative test execution identity");
  return executionId;
}

function codexRuntimeEvent(
  event: AgentEvent,
  extension: Omit<ProviderRuntimeExtension, "providerId" | "kind">,
): ProviderRuntimeEvent {
  return {
    event,
    extension: {
      providerId: "codex",
      kind: "codex-collaboration",
      ...extension,
    },
  };
}

async function commitNativeProjection(canonical: CanonicalAgentBoundary, db: Database, executionId: string, sequence: number, runtimeEvent: ProviderRuntimeEvent) {
  const reader = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), () => undefined);
  const turn = reader.loadTurnByExecution(executionId);
  if (!turn) throw new Error("Native provider fixture has no canonical parent turn");
  const itemId = `native-narrative-${sequence}`;
  const now = new Date().toISOString();
  const stampedRuntimeEvent = ProviderRuntimeEventSchema().parse({
    ...runtimeEvent,
    event: { ...runtimeEvent.event, turnExecutionId: executionId },
  });
  return canonical.commit({
    threadId: THREAD_ID, turnId: turn.id, executionId, phase: "running",
    events: [{ eventId: `${executionId}:${itemId}`, routing: { threadId: THREAD_ID, turnId: turn.id, executionId, itemId },
      sourceProviderId: "codex", sourceIdentities: [], sourceSequence: sequence,
      payload: { type: "item.recorded", item: { id: itemId, threadId: THREAD_ID, turnId: turn.id,
        kind: "system", providerIdentities: [], createdAt: now, updatedAt: now,
        payload: { projection: "providerRuntimeEvent", runtimeEvent: stampedRuntimeEvent },
      } },
    }],
  });
}

function routingDiagnostics(db: Database): unknown[] {
  return db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM canonical_agent_items WHERE thread_id = ? AND kind = 'error'")
    .all(THREAD_ID).map((row) => JSON.parse(row.payload_json));
}

interface Built {
  service: AgentService;
  providerEmitter: NodeEvents.EventEmitter;
  canonicalSink: CanonicalAgentBoundary;
  db: Database;
  messageRepo: MessageRepo;
  thoughtBulk: ReturnType<typeof vi.fn>;
  hookBulk: ReturnType<typeof vi.fn>;
  toolBulk: ReturnType<typeof vi.fn>;
  taskAppend: ReturnType<typeof vi.fn>;
  taskUpsertGroup: ReturnType<typeof vi.fn>;
  taskUpdate: ReturnType<typeof vi.fn>;
  taskRemove: ReturnType<typeof vi.fn>;
  narrativeStore: NarrativeStore;
}

async function build(options: {
  db?: Database;
  canonicalSink?: CanonicalAgentBoundary;
  messageRepo?: MessageRepo;
  parentAssistantTextCheckpoints?: ParentAssistantTextCheckpointService;
  onProviderEvent?: (event: AgentEvent) => void;
} = {}): Promise<Built> {
  const db = options.db ?? defaultNarrativeDatabase();
  const writer = agentStorageTestWriter(db);
  const providerEmitter = Object.assign(new NodeEvents.EventEmitter(), {
    id: "codex" as const,
  });
  (providerEmitter as any).sendTurn = vi.fn(() => Promise.resolve());
  (providerEmitter as any).stopSession = vi.fn(() => Promise.resolve());

  const threadRepo = new ThreadRepo(db, writer);
  const workspaceRepo = new WorkspaceRepo(db, writer);
  const messageRepo = options.messageRepo ?? new SqliteMessageRepo(db, writer);
  const gitService = {
    resolveWorkingDir: vi.fn(() => "/workspace"),
    listWorktrees: vi.fn(() => []),
  } as unknown as GitService;
  const attachmentService = {
    persist: vi.fn(() => Promise.resolve({ stored: [], persisted: [] })),
  } as unknown as AttachmentService;
  const providerRegistry = {
    resolve: vi.fn(() => providerEmitter),
    resolveAll: vi.fn(() => [providerEmitter]),
    shutdown: vi.fn(),
  } as unknown as IProviderRegistry;
  const threadService = { create: vi.fn() } as unknown as ThreadService;
  const toolCallRecordRepo = new ToolCallRecordRepo(db, writer);
  const toolBulk = vi.spyOn(toolCallRecordRepo, "bulkCreateBatched");
  const thoughtSegmentRepo = new ThoughtSegmentRepo(db, writer);
  const thoughtBulk = vi.spyOn(thoughtSegmentRepo, "bulkCreateBatched");
  const hookExecutionRepo = new HookExecutionRepo(db, writer);
  const hookBulk = vi.spyOn(hookExecutionRepo, "bulkCreateBatched");
  const turnSnapshotRepo = new TurnSnapshotRepo(db, writer);
  const snapshotService = {
    captureRef: vi.fn(() => Promise.resolve("abc")),
    getFilesChanged: vi.fn(() => Promise.resolve([])),
  } as unknown as SnapshotService;
  const memoryPressureService = {
    markActive: vi.fn(),
    markIdle: vi.fn(),
    onPressureChange: vi.fn(),
  } as unknown as MemoryPressureService;
  const taskRepo = new TaskRepo(db, writer);
  const taskAppend = vi.spyOn(taskRepo, "appendTask");
  const taskUpsertGroup = vi.spyOn(taskRepo, "upsertGroup");
  const taskUpdate = vi.spyOn(taskRepo, "updateTask");
  const taskRemove = vi.spyOn(taskRepo, "removeTask");
  const settingsService = {
    get: vi.fn(() => ({
      model: { defaults: { fallbackId: undefined } },
      agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
      provider: { enabled: {}, cli: {} },
    })),
    on: vi.fn(),
  } as unknown as SettingsService;
  const availability = { assertUsable: vi.fn() } as unknown as ProviderAvailabilityService;
  const canonicalSink = options.canonicalSink ?? createCanonicalAgentBoundaryStub(db);
  const providerIngress = new ProviderEventIngress();
  const parentAssistantTextCheckpoints = options.parentAssistantTextCheckpoints
    ?? new ParentAssistantTextCheckpointService(db, agentStorageTestWriter(db));

  // Observe real facade calls while the owner commits the resulting narrative.
  const narrativeStore = new NarrativeStore(
    messageRepo,
    toolCallRecordRepo,
    thoughtSegmentRepo,
    hookExecutionRepo,
  );

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
    memoryPressureService,
    settingsService,
    availability,
      { deliverHandoff: vi.fn(async () => ({ providerWireOverride: "" })) } as any,
      { issue: vi.fn(), tryConsume: vi.fn(() => false), clear: vi.fn(), hasActiveGrant: vi.fn(() => false) } as any,
      narrativeStore,
      parentAssistantTextCheckpoints,
      undefined,
      undefined,
      undefined,
      canonicalSink,
      undefined,
      providerIngress,
      undefined,
      undefined,
      undefined,
      new TaskPersistenceService(taskRepo, narrativeStore),
  );
  startAgentServiceIngressForTest(service, options.onProviderEvent);
  // Provider adapters always stamp turn-scoped events with the active execution
  // identity. Keep this fixture aligned with that production boundary while
  // leaving each test focused on the narrative payload it emits.
  const turnExecutionId = startProviderTurnForTest(service, THREAD_ID);
  if (!options.canonicalSink) {
    await canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: new Date().toISOString() },
      turnId: "fixture-narrative-turn", executionId: turnExecutionId, permissionMode: "supervised", providerIdentities: [],
      userMessage: { kind: "existing", messageId: "user-narr" },
    });
  }
  let nativeSequence = 0;
  let nativeCommits = Promise.resolve();
  providerCommits.set(service, () => nativeCommits);
  const emit = providerEmitter.emit.bind(providerEmitter);
  providerEmitter.emit = ((eventName: string, event?: unknown, ...args: unknown[]) => {
    if (eventName === "event" && event && typeof event === "object") {
      event = normalizedNarrativeProviderEvent(event as Record<string, unknown>);
      if (needsNarrativeTurnExecutionId(event)) {
        event = { ...(event as Record<string, unknown>), turnExecutionId };
      }
    }
    const runtimeEvent = providerRuntimeEventForNarrativeTest(eventName, event);
    const parsed = eventName === "event" ? ProviderRuntimeEventSchema().safeParse(runtimeEvent) : undefined;
    if (parsed?.success && parsed.data.extension) {
      nativeSequence += 1;
      const sequence = nativeSequence;
      nativeCommits = nativeCommits.then(async () => {
        const receipt = await commitNativeProjection(canonicalSink, db, turnExecutionId, sequence, parsed.data);
        providerIngress.acceptLegacyProjected(receipt.providerProjection.events);
      });
      void nativeCommits.catch(() => undefined);
      return true;
    }
    return emit(eventName, runtimeEvent, ...args);
  }) as typeof providerEmitter.emit;
  // Prime per-thread state without running sendMessage's full path. The buffers
  // now live in NarrativeStore; seed them via the same public entry points
  // sendMessage uses (beginTurn + resetTurnCounters).
  narrativeStore.beginTurn(THREAD_ID);
  narrativeStore.resetTurnCounters(THREAD_ID);
  return {
    service,
    providerEmitter,
    canonicalSink,
    db,
    messageRepo,
    thoughtBulk,
    hookBulk,
    toolBulk,
    taskAppend,
    taskUpsertGroup,
    taskUpdate,
    taskRemove,
    narrativeStore,
  };
}

describe("AgentService narrative persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves unclassified text to narration and clears its assistant checkpoint at a false boundary", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const published: AgentEvent[] = [];
    const { providerEmitter, service } = await build({
      db,
      canonicalSink,
      onProviderEvent: (event) => published.push(event),
    });
    const executionId = narrativeExecutionId(service);

    await canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
      turnId: "turn-durable-text",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      userMessage: { kind: "create", content: "start", sequence: 1 },
    });

    vi.useFakeTimers();
    try {
      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "durable ",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "text",
      });

      expect(published).toEqual([]);
      expect(db.prepare(
        "SELECT text FROM parent_assistant_text_checkpoint_chunks WHERE execution_id = ?",
      ).all(executionId)).toEqual([]);

      providerEmitter.emit("event", {
        type: AgentEventType.AssistantMessageBoundary,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        isFinalResponse: false,
      });
      await waitForAgentServiceIngressForTest(service, THREAD_ID);

      expect(published
        .filter((event) => event.type === AgentEventType.TextDelta)
        .map((event) => event.delta))
        .toEqual(["durable ", "text"]);
      expect(db.prepare(`
        SELECT first_sequence, last_sequence, text
        FROM parent_assistant_text_checkpoint_chunks
        WHERE execution_id = ?
      `).all(executionId)).toEqual([]);
    } finally {
      vi.useRealTimers();

    }
  });

  it("starts a fresh retention window after each durable narration boundary", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const published: AgentEvent[] = [];
    const { providerEmitter, service } = await build({
      db,
      canonicalSink,
      onProviderEvent: (event) => published.push(event),
    });
    const executionId = narrativeExecutionId(service);

    await canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
      turnId: "turn-multiple-narration-segments",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      userMessage: { kind: "create", content: "start", sequence: 1 },
    });
    const firstSegment = Array.from({ length: 10 }, () => "a".repeat(14 * 1024));
    const secondSegment = Array.from({ length: 10 }, () => "b".repeat(14 * 1024));

    try {
      for (const segment of [firstSegment, secondSegment]) {
        for (const delta of segment) {
          providerEmitter.emit("event", {
            type: AgentEventType.TextDelta,
            threadId: THREAD_ID,
            turnExecutionId: executionId,
            delta,
          });
        }
        providerEmitter.emit("event", {
          type: AgentEventType.AssistantMessageBoundary,
          threadId: THREAD_ID,
          turnExecutionId: executionId,
          isFinalResponse: false,
        });
      }
      await waitForAgentServiceIngressForTest(service, THREAD_ID);

      expect(published
        .filter((event) => event.type === AgentEventType.TextDelta)
        .map((event) => event.delta.length))
        .toEqual([...firstSegment, ...secondSegment].map((delta) => delta.length));
      expect(published.filter((event) => event.type === AgentEventType.AssistantMessageBoundary))
        .toHaveLength(2);
    } finally {

    }
  });

  it("publishes a semantic boundary while its text save is delayed, then saves both in provider order", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const published: AgentEvent[] = [];
    let sqliteAvailable = false;
    const appendChunk = ParentAssistantTextCheckpointService.prototype.appendChunk;
    const appendSpy = vi.spyOn(ParentAssistantTextCheckpointService.prototype, "appendChunk")
      .mockImplementation(function (this: ParentAssistantTextCheckpointService, inputs) {
        if (!sqliteAvailable) throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
        return appendChunk.call(this, inputs);
      });

    try {
      const { providerEmitter, service } = await build({
        db,
        canonicalSink,
        onProviderEvent: (event) => published.push(event),
      });
      const executionId = narrativeExecutionId(service);

      await canonicalSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
        turnId: "turn-delayed-semantic-boundary",
        executionId,
        permissionMode: "supervised",
        providerIdentities: [],
        userMessage: { kind: "create", content: "start", sequence: 1 },
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "delayed text",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.AssistantMessageBoundary,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        isFinalResponse: false,
      });
      await waitForAgentServiceIngressForTest(service, THREAD_ID);

      expect(published.map((event) => event.type)).toEqual([
        AgentEventType.TextDelta,
        AgentEventType.AssistantMessageBoundary,
      ]);
      expect(canonicalSink.loadParentNarrativeRecovery("turn-delayed-semantic-boundary")).toEqual([]);
      await vi.waitFor(() => expect(appendSpy).toHaveBeenCalled());

      sqliteAvailable = true;
      await vi.waitFor(() => expect(JSON.stringify(
        canonicalSink.loadParentNarrativeRecovery("turn-delayed-semantic-boundary"),
      )).toContain("delayed text"), { timeout: 3_000 });
      expect(db.query("SELECT text FROM parent_assistant_text_checkpoint_chunks WHERE execution_id = ?")
        .all(executionId)).toEqual([]);
      expect(published).toHaveLength(2);
    } finally {
      appendSpy.mockRestore();
      vi.useRealTimers();

    }
  });

  it("holds the provider FIFO until the assistant-text baseline is readable", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const published: AgentEvent[] = [];
    const restoreChunks = ParentAssistantTextCheckpointService.prototype.restoreChunks;
    const restoreChunksSpy = vi.spyOn(ParentAssistantTextCheckpointService.prototype, "restoreChunks")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
      })
      .mockImplementation(function (this: ParentAssistantTextCheckpointService, executionId) {
        return restoreChunks.call(this, executionId);
      });

    vi.useFakeTimers();
    try {
      const { providerEmitter, service } = await build({
        db,
        canonicalSink,
        onProviderEvent: (event) => published.push(event),
      });
      const executionId = narrativeExecutionId(service);

      await canonicalSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
        turnId: "turn-delayed-baseline",
        executionId,
        permissionMode: "supervised",
        providerIdentities: [],
        userMessage: { kind: "create", content: "start", sequence: 1 },
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "delayed baseline",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.AssistantMessageBoundary,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        isFinalResponse: false,
      });

      expect(published).toEqual([]);

      await vi.advanceTimersByTimeAsync(250);
      expect(published.map((event) => event.type)).toEqual([
        AgentEventType.TextDelta,
        AgentEventType.AssistantMessageBoundary,
      ]);
      expect(restoreChunksSpy).toHaveBeenCalledTimes(3);
    } finally {
      restoreChunksSpy.mockRestore();
      vi.useRealTimers();

    }
  });

  it("keeps the provider running when a queued tool completion needs output compaction", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const restoreChunksSpy = vi.spyOn(ParentAssistantTextCheckpointService.prototype, "restoreChunks")
      .mockImplementation(() => {
        throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
      });

    vi.useFakeTimers();
    try {
      const { providerEmitter, service } = await build({ db, canonicalSink, onProviderEvent: vi.fn() });
      const executionId = narrativeExecutionId(service);

      await canonicalSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
        turnId: "turn-oversized-event",
        executionId,
        permissionMode: "supervised",
        providerIdentities: [],
        userMessage: { kind: "create", content: "start", sequence: 1 },
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "blocked first",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.ToolResult,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        toolCallId: "oversized-result",
        output: "x".repeat(PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes),
        isError: false,
        outputTruncated: true,
        outputTotalBytes: 1_048_607,
        outputArtifactPath: "/artifacts/oversized-result.txt",
      });
      await waitForAgentServiceIngressForTest(service, THREAD_ID);

      expect((providerEmitter as unknown as { stopSession: ReturnType<typeof vi.fn> }).stopSession)
        .not.toHaveBeenCalled();
      expect(service.runtimeAccess().runtimeSnapshots()).not.toContainEqual(expect.objectContaining({
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        phase: "interrupted",
      }));
    } finally {
      restoreChunksSpy.mockRestore();
      vi.useRealTimers();

    }
  });

  it("stops before a deeply nested queued provider payload can exhaust the event pump", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const restoreChunksSpy = vi.spyOn(ParentAssistantTextCheckpointService.prototype, "restoreChunks")
      .mockImplementation(() => {
        throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
      });
    const nestedInput: Record<string, unknown> = {};
    let current = nestedInput;
    for (let index = 0; index < 60_000; index += 1) {
      const child: Record<string, unknown> = {};
      current.child = child;
      current = child;
    }

    vi.useFakeTimers();
    try {
      const { providerEmitter, service } = await build({ db, canonicalSink, onProviderEvent: vi.fn() });
      const executionId = narrativeExecutionId(service);

      await canonicalSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
        turnId: "turn-deep-event",
        executionId,
        permissionMode: "supervised",
        providerIdentities: [],
        userMessage: { kind: "create", content: "start", sequence: 1 },
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "blocked first",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.ToolUse,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        toolCallId: "deep-tool",
        toolName: "Read",
        toolInput: nestedInput,
      });
      await waitForAgentServiceIngressForTest(service, THREAD_ID);

      expect((providerEmitter as unknown as { stopSession: ReturnType<typeof vi.fn> }).stopSession)
        .toHaveBeenCalledWith(`mcode-${THREAD_ID}`);
      expect(service.runtimeAccess().runtimeSnapshots()).toContainEqual(expect.objectContaining({
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        phase: "running",
      }));
    } finally {
      restoreChunksSpy.mockRestore();
      vi.useRealTimers();

    }
  });

  it("saves an already visible journal-backed boundary after SQLite recovers without another provider event", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    const journalDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-agent-journal-"));
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const journalService = new ParentAssistantTextCheckpointService(
      db,
      agentStorageTestWriter(db),
      { directory: journalDirectory },
    );
    const published: AgentEvent[] = [];
    let sqliteAvailable = false;
    const appendChunk = journalService.appendChunk.bind(journalService);
    const appendChunkSpy = vi.spyOn(journalService, "appendChunk")
      .mockImplementation((inputs) => {
        if (!sqliteAvailable) throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
        return appendChunk(inputs);
      });

    try {
      const { providerEmitter, service } = await build({
        db,
        canonicalSink,
        parentAssistantTextCheckpoints: journalService,
        onProviderEvent: (event) => published.push(event),
      });
      const executionId = narrativeExecutionId(service);

      await canonicalSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
        turnId: "turn-journal-boundary",
        executionId,
        permissionMode: "supervised",
        providerIdentities: [],
        userMessage: { kind: "create", content: "start", sequence: 1 },
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "journaled text",
      });
      providerEmitter.emit("event", {
        type: AgentEventType.AssistantMessageBoundary,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        isFinalResponse: false,
      });
      await waitForAgentServiceIngressForTest(service, THREAD_ID);

      expect(published.map((event) => event.type)).toEqual([
        AgentEventType.TextDelta,
        AgentEventType.AssistantMessageBoundary,
      ]);
      expect(canonicalSink.loadParentNarrativeRecovery("turn-journal-boundary")).toEqual([]);
      await vi.waitFor(() => expect(NodeFS.readdirSync(journalDirectory).length).toBeGreaterThan(0));

      sqliteAvailable = true;
      await vi.waitFor(() => expect(JSON.stringify(
        canonicalSink.loadParentNarrativeRecovery("turn-journal-boundary"),
      )).toContain("journaled text"), { timeout: 3_000 });

      expect(published.map((event) => event.type)).toEqual([
        AgentEventType.TextDelta,
        AgentEventType.AssistantMessageBoundary,
      ]);
      expect(NodeFS.readdirSync(journalDirectory)).toEqual([]);
    } finally {
      appendChunkSpy.mockRestore();
      vi.useRealTimers();

      NodeFS.rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it("keeps an explicitly unsaved narration boundary in memory without creating a recovery projection", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const published: AgentEvent[] = [];
    const appendSpy = vi.spyOn(ParentAssistantTextCheckpointService.prototype, "appendChunk")
      .mockImplementation(() => {
        throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" });
      });

    try {
      const { providerEmitter, service, narrativeStore } = await build({
        db,
        canonicalSink,
        onProviderEvent: (event) => published.push(event),
      });
      const executionId = narrativeExecutionId(service);

      await canonicalSink.startParentTurn({
        thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
        turnId: "turn-unsaved-narration",
        executionId,
        permissionMode: "supervised",
        providerIdentities: [],
        userMessage: { kind: "create", content: "start", sequence: 1 },
      });

      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "visible but unsaved",
      });
      await waitForAgentServiceIngressForTest(service, THREAD_ID);
      await vi.waitFor(() => expect(appendSpy).toHaveBeenCalled());
      continueAgentTurnWithoutSavingForTest(service, executionId);
      providerEmitter.emit("event", {
        type: AgentEventType.AssistantMessageBoundary,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        isFinalResponse: false,
      });
      await waitForAgentServiceIngressForTest(service, THREAD_ID);
      expect(published.map((event) => event.type)).toEqual([
        AgentEventType.TextDelta,
        AgentEventType.AssistantMessageBoundary,
      ]);
      expect(narrativeStore.recoverySnapshot(THREAD_ID)).toEqual([
        expect.objectContaining({
          kind: "narrationSegment",
          record: expect.objectContaining({ text: "visible but unsaved" }),
        }),
      ]);
      expect(canonicalSink.loadParentNarrativeRecovery("turn-unsaved-narration")).toEqual([]);
    } finally {
      appendSpy.mockRestore();

    }
  });

  it("retains provisional text while the visible boundary waits for narration recovery", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const published: AgentEvent[] = [];
    const { providerEmitter, service, thoughtBulk, narrativeStore } = await build({
      db,
      canonicalSink,
      onProviderEvent: (event) => published.push(event),
    });
    const executionId = narrativeExecutionId(service);

    await canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
      turnId: "turn-rejected-narration",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      userMessage: { kind: "create", content: "start", sequence: 1 },
    });

    vi.useFakeTimers();
    try {
      providerEmitter.emit("event", {
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        delta: "provisional text",
      });
      await waitForAgentServiceIngressForTest(service, THREAD_ID);
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(db.query("SELECT text FROM parent_assistant_text_checkpoint_chunks WHERE execution_id = ?")
        .all(executionId)).toEqual([{ text: "provisional text" }]));
      expect(published).toHaveLength(1);
      published.length = 0;
      db.exec(`
        CREATE TRIGGER reject_narration_recovery
        BEFORE INSERT ON canonical_agent_items
        WHEN json_extract(NEW.payload_json, '$.projection') = 'narrativeRecovery'
        BEGIN
          SELECT RAISE(ABORT, 'forced narration recovery failure');
        END;
      `);

      providerEmitter.emit("event", {
        type: AgentEventType.AssistantMessageBoundary,
        threadId: THREAD_ID,
        turnExecutionId: executionId,
        isFinalResponse: false,
      });
      await waitForAgentServiceIngressForTest(service, THREAD_ID);

      expect(published).toEqual([
        expect.objectContaining({ type: AgentEventType.AssistantMessageBoundary, isFinalResponse: false }),
      ]);
      expect(db.prepare(`
        SELECT text FROM parent_assistant_text_checkpoint_chunks
        WHERE execution_id = ?
      `).all(executionId)).toEqual([{ text: "provisional text" }]);
      expect(canonicalSink.loadParentNarrativeRecovery("turn-rejected-narration")).toEqual([]);
      expect(narrativeStore.recoverySnapshot(THREAD_ID)).toEqual([
        expect.objectContaining({ kind: "narrationSegment", record: expect.objectContaining({ text: "provisional text" }) }),
      ]);
      expect(thoughtBulk).not.toHaveBeenCalled();
    } finally {
      db.exec("DROP TRIGGER IF EXISTS reject_narration_recovery");
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(JSON.stringify(
      canonicalSink.loadParentNarrativeRecovery("turn-rejected-narration"),
    )).toContain("provisional text"));
  });

  it("publishes narration classification before saving its covered text delta", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const observed: Array<{ type: string; persisted: string | undefined }> = [];
    const { providerEmitter, service } = await build({
      db,
      canonicalSink,
      onProviderEvent: (event) => {
        const row = db.prepare(`
          SELECT payload_json FROM canonical_agent_items
          WHERE json_extract(payload_json, '$.projection') = 'narrativeRecovery'
          ORDER BY updated_at DESC
          LIMIT 1
        `).get() as { payload_json: string } | undefined;
        observed.push({ type: event.type, persisted: row?.payload_json });
      },
    });
    const executionId = narrativeExecutionId(service);

    await canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
      turnId: "turn-narration-before-publish",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      userMessage: { kind: "create", content: "start", sequence: 1 },
    });

    providerEmitter.emit("event", {
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      delta: "I will inspect the child.",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.AssistantMessageBoundary,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      isFinalResponse: false,
    });
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(observed.at(-1)).toMatchObject({
      type: AgentEventType.AssistantMessageBoundary,
      persisted: undefined,
    });
    await vi.waitFor(() => expect(JSON.stringify(
      canonicalSink.loadParentNarrativeRecovery("turn-narration-before-publish"),
    )).toContain("I will inspect the child."));
    expect(JSON.stringify(canonicalSink.loadParentNarrativeRecovery("turn-narration-before-publish")))
      .not.toContain("turnExecutionId");

  });

  it("commits and publishes the private unfinished reliability prefix", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const published: AgentEvent[] = [];
    const messageRepo = new SqliteMessageRepo(db, agentStorageTestWriter(db));
    const { service } = await build({
      db,
      canonicalSink,
      messageRepo,
      onProviderEvent: (event) => published.push(event),
    });

    try {
      const stream = await streamAgentReliabilityTextForTest(service, THREAD_ID);

      expect(stream).toMatchObject({
        threadId: THREAD_ID,
        text: "Durable assistant prefix for restart recovery.",
      });
      expect(published).toEqual([{
        type: AgentEventType.TextDelta,
        threadId: THREAD_ID,
        turnExecutionId: stream.executionId,
        delta: stream.text,
        isFinalResponse: true,
      }]);
      await vi.waitFor(() => expect(db.query("SELECT text FROM parent_assistant_text_checkpoint_chunks WHERE execution_id = ?")
        .all(stream.executionId)).toEqual([{ text: stream.text }]));
      expect(db.prepare(`
        SELECT first_sequence, last_sequence, text
        FROM parent_assistant_text_checkpoint_chunks
        WHERE execution_id = ?
      `).all(stream.executionId)).toEqual([{
        first_sequence: 1,
        last_sequence: 1,
        text: stream.text,
      }]);
    } finally {

    }
  });

  it("persists TaskCreate at result time keyed by the harness-assigned id", async () => {
    const { service, providerEmitter, taskAppend } = await build();

    // The harness assigns the task id only in the result, so the create must be
    // buffered on ToolUse and persisted on ToolResult.
    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "task-create-1",
      toolName: "TaskCreate",
      toolInput: {
        subject: "Buy groceries",
        description: "Pick up milk, eggs, bread",
        activeForm: "Buying groceries",
      },
    });
    expect(taskAppend).not.toHaveBeenCalled();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      toolCallId: "task-create-1",
      output: "Task #1 created successfully: Buy groceries",
      isError: false,
    });
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(taskAppend).toHaveBeenCalledWith(THREAD_ID, {
      id: "1",
      content: "Buy groceries - Pick up milk, eggs, bread",
      status: "pending",
      activeForm: "Buying groceries",
      group: "Tasks",
    });
  });

  it("does not persist a TaskCreate whose result errored", async () => {
    const { providerEmitter, taskAppend } = await build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "task-create-err",
      toolName: "TaskCreate",
      toolInput: { subject: "Doomed", description: "never lands" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      toolCallId: "task-create-err",
      output: "Task #2 created successfully",
      isError: true,
    });

    expect(taskAppend).not.toHaveBeenCalled();
  });

  it("persists a shell exit code from its tool result", async () => {
    const { service, providerEmitter, toolBulk } = await build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "shell-failed",
      toolName: "command_execution",
      toolInput: { command: "exit 1" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      toolCallId: "shell-failed",
      output: "",
      isError: true,
      exitCode: 1,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await waitForSavedNarrativeTurn(service);

    expect(toolBulk).toHaveBeenCalledOnce();
    const toolCalls: CreateToolCallRecordInput[] = toolBulk.mock.calls[0][0];
    expect(toolCalls[0].exitCode).toBe(1);
  });

  it("persists privileged Browser evaluation without source, result, or artifacts", async () => {
    const { service, providerEmitter, toolBulk } = await build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "evaluate-1",
      toolName: "mcp__mcode-browser__browser_evaluate",
      toolInput: { expression: "globalThis.SECRET_SOURCE" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      toolCallId: "evaluate-1",
      output: '{"valueJson":"SECRET_RESULT"}',
      isError: false,
      outputTruncated: true,
      outputTotalBytes: 999,
      outputArtifactPath: "C:\\secret-result.txt",
      toolInput: { expression: "globalThis.SECRET_SOURCE" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await waitForSavedNarrativeTurn(service);

    expect(toolBulk).toHaveBeenCalledOnce();
    const toolCalls: CreateToolCallRecordInput[] = toolBulk.mock.calls[0][0];
    expect(toolCalls[0]).toMatchObject({
      toolName: "mcp__mcode-browser__browser_evaluate",
      inputSummary: '{"operation":"browser_evaluate"}',
      outputSummary: '{"operation":"browser_evaluate","outcome":"completed"}',
      outputTruncated: false,
    });
    expect(toolCalls[0].outputArtifactPath).toBeUndefined();
    expect(JSON.stringify(toolCalls[0])).not.toContain("SECRET_SOURCE");
    expect(JSON.stringify(toolCalls[0])).not.toContain("SECRET_RESULT");
  });

  it("persists Browser actions as content-free narrative receipts", async () => {
    const { service, providerEmitter, toolBulk } = await build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "act-1",
      toolName: "mcp__mcode-browser__browser_act",
      toolInput: {
        observationRef: "SECRET_OBSERVATION",
        steps: [{ operation: "type", text: "SECRET_TYPED_VALUE" }],
      },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      toolCallId: "act-1",
      output: JSON.stringify({
        operation: "act",
        outcome: "completed",
        effect: "complete",
        recovery: "inspect",
        receipts: [
          { index: 0, operation: "type", status: "applied", message: "SECRET_RESULT" },
        ],
        finalObservation: { visibleText: "SECRET_PAGE_BODY" },
      }),
      isError: false,
      outputArtifactPath: "C:\\SECRET_RESULT.txt",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await waitForSavedNarrativeTurn(service);

    expect(toolBulk).toHaveBeenCalledOnce();
    const toolCalls: CreateToolCallRecordInput[] = toolBulk.mock.calls[0][0];
    expect(toolCalls[0]).toMatchObject({
      inputSummary: '{"operation":"browser_act","steps":[{"operation":"type"}]}',
      outputSummary: '{"operation":"browser_act","outcome":"completed","effect":"complete","recovery":"inspect","receipts":[{"index":0,"operation":"type","status":"applied"}]}',
      outputTruncated: false,
    });
    expect(toolCalls[0].outputArtifactPath).toBeUndefined();
    expect(JSON.stringify(toolCalls[0])).not.toContain("SECRET");
  });

  it("applies a TaskUpdate status transition to the persisted task by harness id", async () => {
    const { service, providerEmitter, taskUpdate } = await build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "task-update-1",
      toolName: "TaskUpdate",
      toolInput: { taskId: "1", status: "in_progress" },
    });
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(taskUpdate).toHaveBeenCalledWith(
      THREAD_ID,
      "1",
      { status: "in_progress" },
      "Tasks",
    );
  });

  it("removes the persisted task when a TaskUpdate sets status deleted", async () => {
    const { service, providerEmitter, taskRemove, taskUpdate } = await build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "task-update-del",
      toolName: "TaskUpdate",
      toolInput: { taskId: "3", status: "deleted" },
    });
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(taskRemove).toHaveBeenCalledWith(THREAD_ID, "3", "Tasks");
    expect(taskUpdate).not.toHaveBeenCalled();
  });

  it("patches subject and activeForm via TaskUpdate without a status change", async () => {
    const { service, providerEmitter, taskUpdate } = await build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "task-update-edit",
      toolName: "TaskUpdate",
      toolInput: { taskId: "1", subject: "Run unit tests", activeForm: "Running unit tests" },
    });
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(taskUpdate).toHaveBeenCalledWith(
      THREAD_ID,
      "1",
      { content: "Run unit tests", activeForm: "Running unit tests" },
      "Tasks",
    );
  });

  it("persists Codex update_plan tool calls for Scope hydration", async () => {
    const { service, providerEmitter, taskUpsertGroup } = await build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "update-plan-1",
      toolName: "update_plan",
      toolInput: {
        plan: [
          { status: "pending", step: "Test todo item one with CODE-A1 and CODE-B1" },
          { status: "inProgress", step: "Test todo item two with CODE-A2 and CODE-B2" },
          { status: "completed", step: "Test todo item three with CODE-A3 and CODE-B3" },
        ],
      },
    });
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(taskUpsertGroup).toHaveBeenCalledWith(THREAD_ID, "Tasks", [
      {
        content: "Test todo item one with CODE-A1 and CODE-B1",
        status: "pending",
        group: "Tasks",
      },
      {
        content: "Test todo item two with CODE-A2 and CODE-B2",
        status: "in_progress",
        group: "Tasks",
      },
      {
        content: "Test todo item three with CODE-A3 and CODE-B3",
        status: "completed",
        group: "Tasks",
      },
    ]);
  });

  it("segments thoughts split by tool calls with strictly-ordered sortOrder", async () => {
    const { service, providerEmitter, thoughtBulk, toolBulk } = await build();

    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: "I will ", isFinalResponse: false });
    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: "read.", isFinalResponse: false });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "tc-1",
      toolName: "Read",
      toolInput: { file_path: "/a" },
    });
    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: "Now respond.", isFinalResponse: false });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    // Wait for the persistTurn promise chain to settle.
    await waitForSavedNarrativeTurn(service);

    expect(toolBulk).toHaveBeenCalledOnce();
    expect(thoughtBulk).toHaveBeenCalledOnce();
    const thoughts: CreateThoughtSegmentInput[] = thoughtBulk.mock.calls[0][0];
    expect(thoughts).toHaveLength(2);
    expect(thoughts[0].text).toBe("I will read.");
    expect(thoughts[0].sortOrder).toBe(0);
    expect(thoughts[1].text).toBe("Now respond.");
    expect(thoughts[1].sortOrder).toBe(2);
    const savedMessage = messageRepoForAgentServiceTest(service).listByThread(THREAD_ID, 1).messages[0];
    expect(savedMessage?.role).toBe("assistant");
    expect(thoughts.every((t) => t.messageId === savedMessage?.id)).toBe(true);

    const toolCalls = toolBulk.mock.calls[0][0];
    expect(toolCalls[0].sortOrder).toBe(1);
  });

  it("records a hook execution between two tool calls with didBlock round-trip", async () => {
    const { service, providerEmitter, hookBulk } = await build();

    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "tc-1",
      toolName: "Bash",
      toolInput: { command: "ls" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.HookStarted,
      threadId: THREAD_ID,
      hookName: "PreToolUse",
      hookType: "permission",
      toolName: "Bash",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.HookCompleted,
      threadId: THREAD_ID,
      hookName: "PreToolUse",
      exitCode: 0,
      durationMs: 17,
      didBlock: true,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "tc-2",
      toolName: "Read",
      toolInput: { file_path: "/x" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await waitForSavedNarrativeTurn(service);

    await vi.waitFor(() => expect(hookBulk).toHaveBeenCalledOnce());
    const hooks: CreateHookExecutionInput[] = hookBulk.mock.calls[0][0];
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hookName).toBe("PreToolUse");
    expect(hooks[0].toolName).toBe("Bash");
    expect(hooks[0].didBlock).toBe(true);
    expect(hooks[0].durationMs).toBe(17);
    // Tool#1 took sortOrder 0; hook 1; tool#2 2.
    expect(hooks[0].sortOrder).toBe(1);
    const savedMessage = messageRepoForAgentServiceTest(service).listByThread(THREAD_ID, 1).messages[0];
    expect(savedMessage?.role).toBe("assistant");
    expect(hooks[0].messageId).toBe(savedMessage?.id);
  });

  it("retains completed hook narrative when terminal finalization fails", async () => {
    const db = openMemoryDatabase();
    const now = "2026-08-24T10:00:00.000Z";
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "claude", "active", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const published: AgentEvent[] = [];
    const { service, providerEmitter, hookBulk, narrativeStore } = await build({
      db,
      canonicalSink,
      onProviderEvent: (event) => published.push(event),
    });
    const executionId = narrativeExecutionId(service);

    await canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "claude", createdAt: now },
      turnId: "turn-late-hook-failure",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      userMessage: { kind: "create", content: "start", sequence: 1 },
    });
    const finalizer = finalizerForAgentServiceTest(service);
    vi.spyOn(finalizer, "finalize").mockRejectedValue(new Error("forced terminal failure"));
    providerEmitter.emit("event", {
      type: AgentEventType.HookStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      hookName: "Stop",
      hookType: "stop",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.HookCompleted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      hookName: "Stop",
      exitCode: 0,
      durationMs: 42,
      didBlock: false,
    });
    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });
    await vi.waitFor(() => expect(finalizer.finalize).toHaveBeenCalledOnce());
    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    await vi.waitFor(() => {
      expect(canonicalSink.loadParentNarrativeRecovery("turn-late-hook-failure")).toEqual([
        expect.objectContaining({
          kind: "hook",
          record: expect.objectContaining({
            hook_name: "Stop",
            ended_at: expect.any(String),
            duration_ms: 42,
          }),
        }),
      ]);
    });
    expect(narrativeStore.recoverySnapshot(THREAD_ID)).toEqual([
      expect.objectContaining({ kind: "hook", record: expect.objectContaining({ hook_name: "Stop" }) }),
    ]);
    expect(hookBulk).not.toHaveBeenCalled();
    expect(published.filter((event) => (
      event.type === AgentEventType.HookStarted || event.type === AgentEventType.HookCompleted
    ))).toEqual([
      expect.objectContaining({ type: AgentEventType.HookStarted, hookName: "Stop", turnExecutionId: executionId }),
      expect.objectContaining({ type: AgentEventType.HookCompleted, hookName: "Stop", turnExecutionId: executionId, durationMs: 42 }),
    ]);

  });

  it("publishes an unmatched late completion through the normal event publisher", async () => {
    const published: AgentEvent[] = [];
    vi.mocked(broadcast).mockReset();
    const { service, providerEmitter } = await build({ onProviderEvent: (event) => published.push(event) });
    const finalizer = finalizerForAgentServiceTest(service);
    let completeFinalization!: () => void;
    vi.spyOn(finalizer, "finalize").mockReturnValue(new Promise<void>((resolve) => {
      completeFinalization = resolve;
    }));

    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.HookCompleted,
      threadId: THREAD_ID,
      hookName: "UnmatchedStop",
      exitCode: 0,
      durationMs: 1,
      didBlock: false,
    });

    expect(published.filter((event) => event.type === AgentEventType.HookCompleted)).toEqual([]);
    completeFinalization();

    await vi.waitFor(() => {
      expect(published.filter((event) => event.type === AgentEventType.HookCompleted)).toEqual([
        expect.objectContaining({
          hookName: "UnmatchedStop",
          durationMs: 1,
        }),
      ]);
    });
    expect("persistedHookId" in published.find((event) => (
      event.type === AgentEventType.HookCompleted
    ))!).toBe(false);
    const acceptedHooks = vi.mocked(broadcast).mock.calls.flatMap(([channel, payload]) => {
      if (channel !== "agent.canonical") return [];
      const frame = CanonicalAgentProgressFrameSchema().parse(payload);
      if (frame.phase !== "accepted") return [];
      return frame.events.filter((event) => event.payload.type === "publication.recorded"
        && event.payload.event.type === AgentEventType.HookCompleted);
    });
    expect(acceptedHooks).toHaveLength(0);
  });

  it("marks a non-final thought as isFinalResponse when its text equals the assistant message body", async () => {
    const { providerEmitter, thoughtBulk, service } = await build();
    const body = "FULL USER-FACING REPLY";
    providerEmitter.emit("event", { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: body, isFinalResponse: false });
    providerEmitter.emit("event", { type: AgentEventType.Message, threadId: THREAD_ID, content: body, tokens: null });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await waitForSavedNarrativeTurn(service);

    expect(thoughtBulk).toHaveBeenCalledOnce();
    const thoughts: CreateThoughtSegmentInput[] = thoughtBulk.mock.calls[0][0];
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].text).toBe(body);
    expect(thoughts[0].isFinalResponse).toBe(1);
  });

  it("drops the open thought when AssistantMessageBoundary reports isFinalResponse=true", async () => {
    const { service, providerEmitter, thoughtBulk } = await build();

    providerEmitter.emit("event", {
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      delta: "Tool-free final answer",
    });
    providerEmitter.emit("event", {
      type: AgentEventType.AssistantMessageBoundary,
      threadId: THREAD_ID,
      isFinalResponse: true,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await waitForSavedNarrativeTurn(service);

    expect(thoughtBulk).not.toHaveBeenCalled();
  });

  it("transfers boundary-final text to the assistant body owner when Message is absent", async () => {
    const { providerEmitter, thoughtBulk, service } = await build();
    const body = "Tool-free final answer";
    const messageRepo = messageRepoForAgentServiceTest(service);
    const createAssistant = vi.spyOn(messageRepo, "createAssistantIdempotent");

    providerEmitter.emit("event", {
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      delta: body,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.AssistantMessageBoundary,
      threadId: THREAD_ID,
      isFinalResponse: true,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await waitForSavedNarrativeTurn(service);

    expect(createAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ content: body }),
    );
    expect(messageRepo.listByThread(THREAD_ID, 1).messages).toEqual([
      expect.objectContaining({ role: "assistant", content: body }),
    ]);
    expect(thoughtBulk).not.toHaveBeenCalled();
  });

  it("persists preamble thought when AssistantMessageBoundary reports isFinalResponse=false", async () => {
    const { service, providerEmitter, thoughtBulk } = await build();

    providerEmitter.emit("event", {
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      delta: "Let me check that file.",
      isFinalResponse: false,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.AssistantMessageBoundary,
      threadId: THREAD_ID,
      isFinalResponse: false,
    });
    providerEmitter.emit("event", {
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      toolCallId: "tc-read",
      toolName: "Read",
      toolInput: { file_path: "/a.ts" },
    });
    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });

    await waitForSavedNarrativeTurn(service);

    expect(thoughtBulk).toHaveBeenCalledOnce();
    const thoughts: CreateThoughtSegmentInput[] = thoughtBulk.mock.calls[0][0];
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].text).toBe("Let me check that file.");
    expect(thoughts[0].isFinalResponse).toBeUndefined();
  });

  it("routes provider Codex child evidence through canonical recovery and keeps its payload out of the parent", async () => {
    const db = openMemoryDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-1", "Parent", "main", "codex", now, now);
    const published = vi.fn();
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), published);
    const { providerEmitter, service, narrativeStore } = await build({ db, canonicalSink });
    const executionId = narrativeExecutionId(service);
    const messages = new SqliteMessageRepo(db, agentStorageTestWriter(db));
    const userMessage = await messages.create(THREAD_ID, "user", "delegate", 1);
    await canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-1", providerId: "codex", createdAt: now },
      turnId: "turn-provider-parent",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      userMessage: { kind: "existing", messageId: userMessage.id },
    });

    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "spawn-from-provider",
      toolName: "Agent",
      toolInput: {},
    }, {
      collaboration: {
        kind: "spawnAgent",
        prompt: "secret child prompt",
        receiverThreadIds: ["provider-child-thread"],
      },
    }));
    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    const provisional = canonicalSink.loadCodexChildDelegation(
      THREAD_ID,
      "toolCall:spawn-from-provider",
    );
    expect(provisional?.childThread.activityState).toBe("Starting");
    expect(narrativeStore.getBufferedToolCalls(THREAD_ID).find(
      (toolCall) => toolCall.toolCallId === "spawn-from-provider",
    )?._rawToolInput).not.toHaveProperty("prompt");

    const childEvidence = {
      nativeThreadId: "provider-child-thread",
      nativeTurnId: "provider-child-turn",
      parentCollaborationItemId: "spawn-from-provider",
      prompt: "secret child prompt",
    };
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    }, { child: childEvidence }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "provider-child-tool",
      toolName: "Read",
      toolInput: { path: "secret-child-input" },
    }, { child: { ...childEvidence, nativeItemId: "provider-child-tool", itemEventKey: "started" } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "provider-child-tool",
      output: "secret-child-output",
      isError: false,
    }, { child: { ...childEvidence, nativeItemId: "provider-child-tool", itemEventKey: "completed" } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TextDelta,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      delta: "secret-child-narration",
      isFinalResponse: false,
    }, { child: { ...childEvidence, nativeItemId: "provider-child-reasoning", itemEventKey: "completed" } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.Message,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      content: "secret-child-message",
      tokens: null,
    }, { child: { ...childEvidence, nativeItemId: "provider-child-message", itemEventKey: "completed" } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.Ended,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    }, { child: childEvidence }));
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    const child = canonicalSink.loadCodexChildDelegation(
      THREAD_ID,
      "toolCall:spawn-from-provider",
    )!;
    const parentMessage = await messages.create(THREAD_ID, "assistant", "parent answer", 2);
    await canonicalSink.finishParentTurnBatched({
      threadId: THREAD_ID,
      turnId: "turn-provider-parent",
      executionId,
      providerId: "codex",
      providerIdentities: [],
      outcome: "completed",
      projection: {
        message: parentMessage,
        narrative: [
          {
            kind: "toolCall",
            sequence: 2,
            sortOrder: 0,
            record: {
              id: "spawn-from-provider",
              message_id: parentMessage.id,
              parent_tool_call_id: null,
              tool_name: "Agent",
              input_summary: JSON.stringify({ codexCollabKind: "spawnAgent" }),
              output_summary: "",
              sort_order: 0,
              started_at: now,
              completed_at: now,
              status: "completed",
            },
          },
          {
            kind: "toolCall",
            sequence: 2,
            sortOrder: 1,
            record: {
              id: "provider-child-tool",
              message_id: parentMessage.id,
              parent_tool_call_id: "spawn-from-provider",
              tool_name: "Read",
              input_summary: "secret-child-input",
              output_summary: "secret-child-output",
              started_at: now,
              completed_at: now,
              status: "completed",
              sort_order: 1,
            },
          },
        ],
      },
    });

    const childRows = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(child.childThread.id) as Array<{ payload_json: string }>;
    const parentRows = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ? AND COALESCE(json_extract(payload_json, '$.projection'), '') <> 'providerRuntimeEvent'",
    ).all(THREAD_ID) as Array<{ payload_json: string }>;
    const rawParentRows = db.query<{ thread_id: string; turn_id: string; payload_json: string }, [string]>(
      "SELECT thread_id, turn_id, payload_json FROM canonical_agent_items WHERE thread_id = ? AND json_extract(payload_json, '$.projection') = 'providerRuntimeEvent'",
    ).all(THREAD_ID);
    const parentConversation = {
      messages: messages.listByThread(THREAD_ID, 10).messages,
      tools: new ToolCallRecordRepo(db, agentStorageTestWriter(db)).listByMessage(parentMessage.id),
      thoughts: new ThoughtSegmentRepo(db, agentStorageTestWriter(db)).listByMessage(parentMessage.id),
    };
    expect(JSON.stringify(childRows)).toContain("secret-child-output");
    expect(JSON.stringify(childRows)).toContain("secret-child-message");
    expect(JSON.stringify(childRows)).toContain("secret-child-narration");
    expect(JSON.stringify(childRows)).toContain("secret child prompt");
    expect(JSON.stringify(parentRows)).not.toContain("secret-child-output");
    expect(JSON.stringify(parentRows)).not.toContain("secret-child-message");
    expect(JSON.stringify(parentRows)).not.toContain("secret-child-narration");
    expect(JSON.stringify(parentRows)).not.toContain("secret child prompt");
    for (const marker of ["secret-child-output", "secret-child-message", "secret-child-narration", "secret child prompt"]) {
      expect(JSON.stringify(parentConversation)).not.toContain(marker);
      expect(JSON.stringify(rawParentRows)).toContain(marker);
    }
    // Transport journals retain the original parent routing so worker replay can reproduce child ownership.
    expect(rawParentRows.every((row) => row.thread_id === THREAD_ID && row.turn_id === "turn-provider-parent"))
      .toBe(true);
    expect(canonicalSink.loadTurn(child.collaborationAction.target.turnId!)?.status).toBe("Interrupted");
  });

  it("registers a nested Codex child under its emitting canonical child and binds its native turn", async () => {
    const db = openMemoryDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-nested", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-nested", "Parent", "main", "codex", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const { providerEmitter, service } = await build({ db, canonicalSink });
    const executionId = narrativeExecutionId(service);
    const messages = new SqliteMessageRepo(db, agentStorageTestWriter(db));
    const userMessage = await messages.create(THREAD_ID, "user", "delegate", 1);
    await canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-nested", providerId: "codex", createdAt: now },
      turnId: "turn-nested-parent",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      userMessage: { kind: "existing", messageId: userMessage.id },
    });

    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "root-spawn",
      toolName: "Agent",
      toolInput: {},
    }, { collaboration: {
      kind: "spawnAgent",
        agentName: "Direct child",
        receiverThreadIds: ["native-direct-child"],
    } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    }, { child: {
        nativeThreadId: "native-direct-child",
        nativeTurnId: "native-direct-turn",
        parentCollaborationItemId: "root-spawn",
    } }));

    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    const directChild = canonicalSink.loadThreadByProviderIdentity({
      providerId: "codex",
      scope: "thread",
      value: "native-direct-child",
      provenance: "native",
    });
    const directTurn = directChild
      ? canonicalSink.loadTurnByProviderIdentity(directChild.id, {
          providerId: "codex",
          scope: "turn",
          value: "native-direct-turn",
          provenance: "native",
        })
      : null;
    expect(directChild).toBeTruthy();
    expect(directTurn).toMatchObject({ threadId: directChild!.id });

    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "nested-spawn",
      toolName: "Agent",
      toolInput: {},
    }, {
      collaboration: {
        kind: "spawnAgent",
        agentName: "Nested child",
        receiverThreadIds: ["native-nested-child"],
      },
      child: {
        nativeThreadId: "native-direct-child",
        nativeTurnId: "native-direct-turn",
        parentCollaborationItemId: "root-spawn",
        nativeItemId: "nested-spawn",
        itemEventKey: "started",
      },
    }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "nested-spawn",
      toolName: "Agent",
      toolInput: {},
    }, {
      collaboration: {
        kind: "spawnAgent",
        agentName: "Nested child",
        receiverThreadIds: ["native-nested-child"],
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      },
      child: {
        nativeThreadId: "native-direct-child",
        nativeTurnId: "native-direct-turn",
        parentCollaborationItemId: "root-spawn",
        nativeItemId: "nested-spawn",
        itemEventKey: "started",
      },
    }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    }, { child: {
        nativeThreadId: "native-nested-child",
        nativeTurnId: "native-nested-turn",
        parentCollaborationItemId: "nested-spawn",
    } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      reason: "completed",
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
    }, { child: {
        nativeThreadId: "native-nested-child",
        nativeTurnId: "native-nested-turn",
        parentCollaborationItemId: "nested-spawn",
        nativeItemId: "native-nested-turn",
        itemEventKey: "completed",
        outcome: "completed",
    } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "nested-spawn",
      output: "",
      isError: false,
      toolInput: {},
    }, {
      collaboration: {
        kind: "spawnAgent",
        agentName: "Nested child",
        receiverThreadIds: ["native-nested-child"],
      },
      child: {
        nativeThreadId: "native-direct-child",
        nativeTurnId: "native-direct-turn",
        parentCollaborationItemId: "root-spawn",
        nativeItemId: "nested-spawn",
        itemEventKey: "completed",
      },
    }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.Message,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      content: "direct child continues after nested spawn",
      tokens: null,
    }, { child: {
        nativeThreadId: "native-direct-child",
        nativeTurnId: "native-direct-turn",
        parentCollaborationItemId: "root-spawn",
        nativeItemId: "direct-child-follow-up",
        itemEventKey: "completed",
    } }));

    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    const directItems = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ? AND kind = 'tool-call'",
    ).all(directChild!.id) as Array<{ payload_json: string }>;
    const directItemPayloads = directItems.map((row) => JSON.parse(row.payload_json));
    expect(directItemPayloads).toContainEqual(expect.objectContaining({
      projection: "codexChildToolCall",
      toolName: "Agent",
      toolInput: expect.objectContaining({ codexCollabKind: "spawnAgent" }),
    }));
    expect(directItemPayloads.filter((payload) => (
      payload.projection === "codexChildToolCall" && payload.nativeItemId === "nested-spawn"
    ))).toHaveLength(1);

    const nestedChild = canonicalSink.loadThreadByProviderIdentity({
      providerId: "codex",
      scope: "thread",
      value: "native-nested-child",
      provenance: "native",
    });
    const nestedTurn = nestedChild
      ? canonicalSink.loadTurnByProviderIdentity(nestedChild.id, {
          providerId: "codex",
          scope: "turn",
          value: "native-nested-turn",
          provenance: "native",
        })
      : null;
    expect(nestedChild).toBeTruthy();
    expect(nestedTurn).toMatchObject({
      threadId: nestedChild!.id,
      trigger: {
        kind: "child",
        sourceThreadId: directChild!.id,
        sourceTurnId: directTurn!.id,
      },
    });
    const directPayloads = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(directChild!.id) as Array<{ payload_json: string }>;
    const nestedPayloads = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(nestedChild!.id) as Array<{ payload_json: string }>;
    const directChildContinuation = {
      projection: "message",
      message: { content: "direct child continues after nested spawn" },
    };
    const nestedSpawnResult = {
      projection: "codexChildToolResult",
      output: "",
      isError: false,
    };
    expect(directPayloads.map((row) => JSON.parse(row.payload_json))).toContainEqual(
      expect.objectContaining({
        projection: directChildContinuation.projection,
        message: expect.objectContaining(directChildContinuation.message),
      }),
    );
    expect(directPayloads.map((row) => JSON.parse(row.payload_json))).toContainEqual(
      expect.objectContaining(nestedSpawnResult),
    );
    expect(nestedPayloads.map((row) => JSON.parse(row.payload_json))).not.toContainEqual(
      expect.objectContaining({
        projection: directChildContinuation.projection,
        message: expect.objectContaining(directChildContinuation.message),
      }),
    );
    expect(nestedPayloads.map((row) => JSON.parse(row.payload_json))).not.toContainEqual(
      expect.objectContaining(nestedSpawnResult),
    );

    const roster = canonicalSink.loadSubagentRoster({ owningParentThreadId: THREAD_ID, limit: 50 });
    const rosterRows = [...roster.active, ...roster.done];
    const nestedRow = rosterRows.find((row) => row.id === nestedChild!.id);
    expect(nestedRow).toMatchObject({
      id: nestedChild!.id,
      parentThreadId: directChild!.id,
      lineage: [THREAD_ID, directChild!.id, nestedChild!.id],
      model: "gpt-5.6-sol",
      reasoning: "medium",
    });
    expect(rosterRows.filter((row) => row.parentThreadId === THREAD_ID).map((row) => row.id))
      .toEqual([directChild!.id]);
    expect(rosterRows.filter((row) => row.parentThreadId === directChild!.id).map((row) => row.id))
      .toEqual([nestedChild!.id]);
    const parentItemPayloads = db.prepare(
      "SELECT payload_json FROM canonical_agent_items WHERE thread_id = ?",
    ).all(THREAD_ID) as Array<{ payload_json: string }>;
    expect(parentItemPayloads.map((row) => JSON.parse(row.payload_json)).filter((payload) => (
      payload.projection === "codexChildRoutingFailure"
    ))).toHaveLength(0);
  });

  it("persists an actionable parent failure record when child persistence fails", async () => {
    const db = openMemoryDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-failure", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-failure", "Parent", "main", "codex", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const { providerEmitter, service } = await build({ db, canonicalSink });
    const executionId = narrativeExecutionId(service);
    const messages = new SqliteMessageRepo(db, agentStorageTestWriter(db));
    const userMessage = await messages.create(THREAD_ID, "user", "delegate", 1);
    await canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-failure", providerId: "codex", createdAt: now },
      turnId: "turn-provider-failure",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      userMessage: { kind: "existing", messageId: userMessage.id },
    });
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "spawn-failure",
      toolName: "Agent",
      toolInput: {},
    }, { collaboration: { kind: "spawnAgent", receiverThreadIds: ["native-failure-child"] } }));
    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    const provisional = canonicalSink.loadCodexChildDelegation(
      THREAD_ID,
      "toolCall:spawn-failure",
    )!;
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    }, { child: {
        nativeThreadId: "native-failure-child",
        nativeTurnId: "native-failure-turn",
        parentCollaborationItemId: "spawn-failure",
    } }));
    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    db.run("CREATE TRIGGER reject_child_item BEFORE INSERT ON canonical_agent_items WHEN NEW.thread_id != 't-narr' AND NEW.kind = 'tool-call' BEGIN SELECT RAISE(ABORT, 'injected child persistence failure'); END");
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "child-failure-tool",
      toolName: "Read",
      toolInput: { path: "child-secret" },
    }, { child: {
        nativeThreadId: "native-failure-child",
        nativeTurnId: "native-failure-turn",
        parentCollaborationItemId: "spawn-failure",
        nativeItemId: "child-failure-tool",
        itemEventKey: "started",
    } }));

    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    const parentFailure = db.prepare(`
      SELECT payload_json
      FROM canonical_agent_items
      WHERE thread_id = ? AND kind = 'error'
    `).get(THREAD_ID) as { payload_json: string } | undefined;
    expect(parentFailure).toBeDefined();
    expect(JSON.parse(parentFailure!.payload_json)).toMatchObject({
      projection: "codexChildRoutingFailure",
      status: "action-required",
      recovery: "retry-child-routing",
      reason: "injected child persistence failure",
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM canonical_agent_items WHERE thread_id = ? AND kind = 'tool-call'",
    ).get(provisional.childThread.id)).toEqual({ count: 0 });
  });

  it("persists a parent collaboration ToolUse and acknowledges its matching ToolResult", async () => {
    const db = openMemoryDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-action", "Workspace", "/workspace", now, now);
    db.prepare(
      "INSERT INTO threads (id, workspace_id, title, branch, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(THREAD_ID, "ws-action", "Parent", "main", "codex", now, now);
    const canonicalSink = new CanonicalAgentBoundary(db, agentStorageTestWriter(db), new CanonicalAgentWriterClient(agentStorageTestWriter(db)), vi.fn());
    const { providerEmitter, service } = await build({ db, canonicalSink });
    const executionId = narrativeExecutionId(service);
    const messages = new SqliteMessageRepo(db, agentStorageTestWriter(db));
    const userMessage = await messages.create(THREAD_ID, "user", "delegate", 1);
    await canonicalSink.startParentTurn({
      thread: { id: THREAD_ID, workspaceId: "ws-action", providerId: "codex", createdAt: now },
      turnId: "turn-provider-action",
      executionId,
      permissionMode: "supervised",
      providerIdentities: [],
      userMessage: { kind: "existing", messageId: userMessage.id },
    });

    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "spawn-action-child",
      toolName: "Agent",
      toolInput: {},
    }, { collaboration: {
        kind: "spawnAgent",
        receiverThreadIds: ["native-action-child"],
    } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "spawn-action-child",
      toolInput: {},
      output: "ready",
      isError: false,
    }, { collaboration: {
        kind: "spawnAgent",
        agentName: "Mendel",
        receiverThreadIds: ["native-action-child"],
    } }));
    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    expect(canonicalSink.loadSubagentRoster({ owningParentThreadId: THREAD_ID, limit: 50 }).active[0]?.identity)
      .toBe("Mendel");
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.TurnStarted,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
    }, { child: {
        nativeThreadId: "native-action-child",
        nativeTurnId: "native-action-turn",
        parentCollaborationItemId: "spawn-action-child",
    } }));
    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolUse,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "parent-message-child",
      toolName: "sendInput",
      toolInput: {},
    }, { collaboration: {
        kind: "sendInput",
        receiverThreadIds: ["native-action-child"],
        prompt: "Inspect this case.",
    } }));

    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    const dispatched = db.prepare(`
      SELECT id, source_item_id, status, target_turn_id
      FROM canonical_collaboration_actions
      WHERE source_item_id = ?
    `).get("toolCall:parent-message-child") as {
      id: string;
      source_item_id: string;
      status: string;
      target_turn_id: string | null;
    } | undefined;
    expect(dispatched).toMatchObject({
      source_item_id: "toolCall:parent-message-child",
      status: "Dispatched",
    });
    expect(dispatched?.target_turn_id).toBeTruthy();
    expect(db.prepare("SELECT thread_id, turn_id FROM canonical_agent_items WHERE id = ?")
      .get("toolCall:parent-message-child")).toMatchObject({ thread_id: THREAD_ID });

    providerEmitter.emit("event", codexRuntimeEvent({
      type: AgentEventType.ToolResult,
      threadId: THREAD_ID,
      turnExecutionId: executionId,
      toolCallId: "parent-message-child",
      toolInput: {},
      output: "delivered",
      isError: false,
    }, { collaboration: {
        kind: "sendInput",
        receiverThreadIds: ["native-action-child"],
    } }));

    await waitForAgentServiceIngressForTest(service, THREAD_ID);
    expect(db.prepare("SELECT status FROM canonical_collaboration_actions WHERE id = ?")
      .get(dispatched!.id)).toEqual({ status: "Acknowledged" });
    expect(db.prepare("SELECT target_turn_id FROM canonical_collaboration_actions WHERE id = ?")
      .get(dispatched!.id)).toEqual({ target_turn_id: dispatched!.target_turn_id });
  });

  it("rejects unsupported provider continuation evidence without starting a turn", async () => {
    const { service, canonicalSink, db } = await build();
    const executionId = narrativeExecutionId(service);
    const startParentTurn = vi.spyOn(canonicalSink, "startParentTurn");
    const projection = await commitNativeProjection(canonicalSink, db, executionId, 1, codexRuntimeEvent({
      type: AgentEventType.TurnStarted, threadId: THREAD_ID,
      turnExecutionId: "00000000-0000-4000-8000-000000000099",
    }, { continuation: {
      sourceNativeThreadId: "native-source-child", sourceNativeTurnId: "native-source-turn",
      sourceNativeItemId: "native-return-parent", targetNativeThreadId: "native-wrong-parent",
    } }));
    expect(projection.providerProjection.events).toEqual([]);
    expect(startParentTurn).not.toHaveBeenCalled();
    expect(routingDiagnostics(db)).toContainEqual(expect.objectContaining({
      projection: "codexChildRoutingFailure", reason: "continuation-evidence-not-found",
    }));
  });

  it("records a failure signal when attributed child routing lacks a delegation", async () => {
    const { service, canonicalSink, db } = await build();
    const projection = await commitNativeProjection(canonicalSink, db, narrativeExecutionId(service), 1, codexRuntimeEvent({
      type: AgentEventType.ToolUse, threadId: THREAD_ID, toolCallId: "child-failure", toolName: "Read", toolInput: {},
    }, { child: { nativeThreadId: "child-native", nativeTurnId: "child-turn", parentCollaborationItemId: "missing-parent-item" } }));
    expect(projection.providerProjection.events).toEqual([]);
    expect(routingDiagnostics(db)).toContainEqual(expect.objectContaining({
      projection: "codexChildRoutingFailure", reason: "delegation-not-found",
    }));
  });

  it("consumes every child projection kind before parent narrative persistence", async () => {
    const { service, canonicalSink, db, thoughtBulk, hookBulk, toolBulk } = await build();
    const evidence = { nativeThreadId: "child-boundary-thread", nativeTurnId: "child-boundary-turn", parentCollaborationItemId: "boundary-parent-item" };
    const events: AgentEvent[] = [
      { type: AgentEventType.Message, threadId: THREAD_ID, content: "child message", tokens: null },
      { type: AgentEventType.TextDelta, threadId: THREAD_ID, delta: "child reasoning", isFinalResponse: false },
      { type: AgentEventType.ToolUse, threadId: THREAD_ID, toolCallId: "child-boundary-tool", toolName: "Read", toolInput: {} },
      { type: AgentEventType.ToolResult, threadId: THREAD_ID, toolCallId: "child-boundary-tool", output: "child result", isError: false },
      { type: AgentEventType.Error, threadId: THREAD_ID, error: "child error" },
      { type: AgentEventType.TurnComplete, threadId: THREAD_ID, reason: "completed", costUsd: null, tokensIn: 0, tokensOut: 0 },
    ];
    for (let index = 0; index < events.length; index += 1) {
      const projection = await commitNativeProjection(canonicalSink, db, narrativeExecutionId(service), index + 1,
        codexRuntimeEvent(events[index], { child: evidence }));
      expect(projection.providerProjection.events).toEqual([]);
    }
    expect(toolBulk).not.toHaveBeenCalled();
    expect(thoughtBulk).not.toHaveBeenCalled();
    expect(hookBulk).not.toHaveBeenCalled();
    expect(new SqliteMessageRepo(db, agentStorageTestWriter(db)).listByThread(THREAD_ID, 10).messages
      .some((message) => message.content === "child message")).toBe(false);
  });

  it("fails closed when an attributed child event has no canonical owner and its diagnostic cannot save", async () => {
    const { service, canonicalSink, db } = await build();
    db.run("CREATE TRIGGER reject_child_diagnostic BEFORE INSERT ON canonical_agent_items WHEN NEW.kind = 'error' BEGIN SELECT RAISE(ABORT, 'child diagnostic failed'); END");
    await expect(commitNativeProjection(canonicalSink, db, narrativeExecutionId(service), 1, codexRuntimeEvent({
      type: AgentEventType.ToolUse, threadId: THREAD_ID, toolCallId: "child-unowned", toolName: "Read", toolInput: {},
    }, { child: { nativeThreadId: "child-unowned-thread", nativeTurnId: "child-unowned-turn", parentCollaborationItemId: "missing-parent-item" } })))
      .rejects.toThrow("child diagnostic failed");
    expect(routingDiagnostics(db)).toEqual([]);
    expect(db.query("SELECT status FROM canonical_agent_turns WHERE id = 'fixture-narrative-turn'").get()).toEqual({ status: "Running" });
  });

  it("withholds terminal provider publication when final durability fails", async () => {
    const published: AgentEvent[] = [];
    const { service, providerEmitter } = await build({ onProviderEvent: (event) => published.push(event) });
    vi.spyOn(finalizerForAgentServiceTest(service), "finalize")
      .mockRejectedValue(new Error("terminal write failed"));

    providerEmitter.emit("event", {
      type: AgentEventType.TurnComplete,
      threadId: THREAD_ID,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: 0,
    });
    await waitForAgentServiceIngressForTest(service, THREAD_ID);

    expect(published).not.toContainEqual(expect.objectContaining({
      type: AgentEventType.TurnComplete,
    }));
  });
});
