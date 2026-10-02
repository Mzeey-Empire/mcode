import "reflect-metadata";
import { CanonicalAgentProgressFrameSchema } from "@mcode/contracts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ApprovalReviewSupport, Thread, IProviderRegistry } from "@mcode/contracts";
import { supportsInternalThreadControl } from "../../turns/turn-admission-dispatch-coordinator.js";
import { createAgentServiceForTest, drainAgentServicePersistenceForTest } from "./agent-service-test-harness.js";
import { createCanonicalAgentBoundaryStub } from "../../canonical/__tests__/canonical-agent-boundary-stub.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { ProviderAvailabilityService } from "../../../providers/availability/provider-availability-service.js";
import { ProviderDisabledError } from "../../../providers/availability/provider-availability-errors.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../../projects/testing/owned-test-database.js";
import type { AgentService } from "../agent-service.js";
import type { GitService } from "../../../projects/index.js";
import type { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import type { ToolCallRecordRepo } from "../../tools/persistence/tool-call-record-repo.js";
import type { TurnSnapshotRepo } from "../../turns/persistence/turn-snapshot-repo.js";
import type { SnapshotService } from "../../../projects/diffs/snapshots/snapshot-service.js";
import type { MemoryPressureService } from "../../../../runtime/memory/memory-pressure-service.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ThreadService } from "../../../thread-control/index.js";
import * as NodeEvents from "node:events";

// Capture canonical progress published by the real service.
// without a real WebSocket server.
vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));
import { broadcast } from "../../../../application/transport/push.js";
function publishedEvents() {
  return vi.mocked(broadcast).mock.calls.flatMap(([topic, payload]) => {
    if (topic !== "agent.canonical") return [];
    const frame = CanonicalAgentProgressFrameSchema().parse(payload);
    if (frame.phase !== "accepted") return [];
    return frame.events.flatMap((envelope) => envelope.payload.type === "publication.recorded" ? [envelope.payload.event] : []);
  });
}


const THREAD_ID = "thread-abc";
const ownedFixtures: Array<{ database: OwnedTestDatabase; service: AgentService }> = [];

afterEach(async () => {
  for (const fixture of ownedFixtures.splice(0)) {
    try { await drainAgentServicePersistenceForTest(fixture.service); }
    finally { await fixture.database.close(); }
  }
});
type PersistedThreadStatus = Thread["status"] | "failed" | "idle" | "stopped";
type PersistedThread = Omit<Thread, "status"> & { status: PersistedThreadStatus };

function makeThread(overrides: Partial<PersistedThread> = {}): Thread {
  return {
    id: THREAD_ID,
    workspace_id: "ws-1",
    title: "Test thread",
    status: "idle",
    mode: "direct",
    branch: "main",
    worktree_path: null,
    model: "claude-sonnet-4-6",
    provider: "codex",
    sdk_session_id: null,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    permission_mode: null,
    last_compact_summary: null,
    parent_thread_id: null,
    forked_from_message_id: null,
    deleted_at: null,
    user_completed_at: null,
    scheduled_deletion_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Thread;
}

/**
 * Build a minimal AgentService with only the dependencies needed to test
 * the provider availability gate. All other deps are no-op stubs.
 */
function buildService({
  assertUsable = vi.fn(),
  resolveProvider = vi.fn(),
  threadStatus = "idle",
  approvalReviewSupport,
  threadControlMcp = {
    activate: vi.fn(),
    revoke: vi.fn(),
  },
}: {
  assertUsable?: ReturnType<typeof vi.fn>;
  resolveProvider?: ReturnType<typeof vi.fn>;
  threadStatus?: PersistedThreadStatus;
  approvalReviewSupport?: ApprovalReviewSupport;
  threadControlMcp?: { activate: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> };
} = {}) {
  const thread = makeThread({ status: threadStatus });
  const database = createOwnedTestDatabase();
  const { db, writer } = database;
  db.run("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)", ["ws-1", "Fixture", process.cwd()]);
  db.run("INSERT INTO threads (id, workspace_id, title, branch, provider) VALUES (?, ?, ?, ?, ?)", [THREAD_ID, "ws-1", thread.title, "main", "codex"]);
  const threadRepo = new ThreadRepo(db, writer);
  vi.spyOn(threadRepo, "findById").mockReturnValue(thread);

  const workspaceRepo = {
    findById: vi.fn(() => ({ id: "ws-1", path: process.cwd() })),
  } as unknown as WorkspaceRepo;

  const messageRepo = new MessageRepo(db, writer);

  const gitService = {
    resolveWorkingDir: vi.fn(() => process.cwd()),
    listWorktrees: vi.fn(() => []),
  } as unknown as GitService;

  const attachmentService = {
    persist: vi.fn(() => Promise.resolve({ stored: [], persisted: [] })),
  } as unknown as AttachmentService;

  const getApprovalReviewSupport = approvalReviewSupport
    ? vi.fn(async () => approvalReviewSupport)
    : undefined;
  const providerStub = Object.assign(new NodeEvents.EventEmitter(), {
    id: "codex" as const,
    supportsCompletion: true,
    sessionForkOnResume: "unsupported" as const,
    maxInputCharactersPerTurn: 16_000,
    sendTurn: vi.fn(() => Promise.resolve()),
  }, getApprovalReviewSupport ? { getApprovalReviewSupport } : {});

  const providerRegistry = {
    resolve: resolveProvider.getMockImplementation() ? resolveProvider : vi.fn(() => providerStub),
    resolveAll: vi.fn(() => []),
    shutdown: vi.fn(),
  } as unknown as IProviderRegistry;

  const threadService = {
    create: vi.fn(),
  } as unknown as ThreadService;

  const toolCallRecordRepo = {
    bulkCreate: vi.fn(),
  } as unknown as ToolCallRecordRepo;

  const turnSnapshotRepo = {
    listByThread: vi.fn(() => []),
    create: vi.fn(),
  } as unknown as TurnSnapshotRepo;

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
    assertUsable,
  } as unknown as ProviderAvailabilityService;

  const svc = createAgentServiceForTest(
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
      new NarrativeStore(
        messageRepo,
        toolCallRecordRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../conversation/narrative/persistence/thought-segment-repo.js").ThoughtSegmentRepo,
        { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../events/persistence/hook-execution-repo.js").HookExecutionRepo,
      ),
      new ParentAssistantTextCheckpointService(db, writer),
      undefined,
      threadControlMcp as never,
      undefined,
      createCanonicalAgentBoundaryStub(db, writer),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    writer,
  );
  ownedFixtures.push({ database, service: svc });
  return {
    db,
    svc,
    threadRepo,
    messageRepo,
    providerStub,
    providerRegistry,
    threadControlMcp,
    memoryPressureService,
    settingsService,
    getApprovalReviewSupport,
  };
}

describe("AgentService.sendMessage — admission gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits providerUnavailable and returns early when assertUsable throws ProviderDisabledError", async () => {
    const resolveProvider = vi.fn();
    const assertUsable = vi.fn(() => {
      throw new ProviderDisabledError("codex");
    });

    const { svc } = buildService({ assertUsable, resolveProvider });

    await expect(
      svc.sendMessage({
        threadId: THREAD_ID,
        content: "Hello",
        permissionMode: "default",
        model: "claude-sonnet-4-6",
        attachments: [],
        provider: "codex",
      }),
    ).rejects.toThrow(ProviderDisabledError);

    // Provider must NOT be resolved — no agent session started
    expect(resolveProvider).not.toHaveBeenCalled();

    // A providerUnavailable event must have been broadcast on the agent.event channel.
    // The canonical publication stamps a shared publicationId on the legacy copy.
    expect(publishedEvents()).toContainEqual(expect.objectContaining({
      type: "providerUnavailable",
      threadId: THREAD_ID,
      providerId: "codex",
      reason: "disabled",
      configuredPath: undefined,
      publicationId: expect.any(String),
    }));
  });

  it.each(["failed", "stopped", "archived", "deleted"] as const)("rejects composer sends to %s threads before persistence", async (threadStatus) => {
    const assertUsable = vi.fn();
    const { svc } = buildService({ threadStatus, assertUsable });

    await expect(svc.sendMessage({
      threadId: THREAD_ID,
      content: "Must not append",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "codex",
    })).rejects.toThrow("terminal thread");

    expect(assertUsable).not.toHaveBeenCalled();
  });

  it.each(["completed", "interrupted", "errored"] as const)("allows a direct follow-up to the %s thread through persistence and provider dispatch", async (threadStatus) => {
    const { svc, db, messageRepo, providerStub } = buildService({ threadStatus });

    await svc.sendMessage({
      threadId: THREAD_ID,
      content: "Continue from the completed turn",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "codex",
    });

    expect(messageRepo.listByThread(THREAD_ID, 100).messages).toEqual([
      expect.objectContaining({ role: "user", content: "Continue from the completed turn", sequence: 1 }),
    ]);
    expect(db.query("SELECT status FROM threads WHERE id = ?").get(THREAD_ID)).toEqual({ status: "active" });
    expect(providerStub.sendTurn).toHaveBeenCalledTimes(1);
  });

  it.each(["completed", "interrupted"] as const)("allows a fully-provenanced cross-thread send to a %s thread", async (threadStatus) => {
    const { svc, db, providerStub } = buildService({ threadStatus });

    await svc.sendMessage({
      threadId: THREAD_ID,
      content: "Delegated follow-up resumes the target task",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "codex",
      sourceThreadId: "source-thread",
      originSourceTurnId: "source-turn",
      sourceProviderId: "claude",
    });

    expect(db.query("SELECT content, sequence, origin_type, source_thread_id, source_turn_id, source_provider_id FROM messages WHERE thread_id = ?").all(THREAD_ID)).toEqual([{
      content: "Delegated follow-up resumes the target task", sequence: 1, origin_type: "thread",
      source_thread_id: "source-thread", source_turn_id: "source-turn", source_provider_id: "claude",
    }]);
    expect(db.query("SELECT status FROM threads WHERE id = ?").get(THREAD_ID)).toEqual({ status: "active" });
    expect(providerStub.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete cross-thread provenance before provider side effects", async () => {
    const assertUsable = vi.fn();
    const resolveProvider = vi.fn();
    const { svc } = buildService({ assertUsable, resolveProvider });

    await expect(svc.sendMessage({
      threadId: THREAD_ID,
      content: "Must retain the real source tuple",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "codex",
      sourceThreadId: "source-thread",
      sourceProviderId: "claude",
    })).rejects.toThrow("complete thread provenance tuple");

    expect(assertUsable).not.toHaveBeenCalled();
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it("rejects a managed required review before activation, persistence, request construction, or provider delivery", async () => {
    const requiredReview: ApprovalReviewSupport = {
      status: "required",
      supportedModes: ["manual", "automatic"],
      reason: "automatic-review-required",
      liveChangeScope: "none",
    };
    const {
      svc,
      messageRepo,
      providerStub,
      memoryPressureService,
      settingsService,
      getApprovalReviewSupport,
    } = buildService({ approvalReviewSupport: requiredReview });

    await expect(svc.sendMessage({
      threadId: THREAD_ID,
      content: "This must not start a turn",
      permissionMode: "full",
      approvalReviewMode: "automatic",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "codex",
    })).rejects.toThrow(requiredReview.reason);

    expect(getApprovalReviewSupport).toHaveBeenCalledWith({
      permissionMode: "full",
      interactionMode: "build",
      requestedMode: "automatic",
      model: "claude-sonnet-4-6",
    });
    expect(memoryPressureService.markActive).not.toHaveBeenCalled();
    expect(messageRepo.listByThread(THREAD_ID, 100).messages).toEqual([]);
    expect(settingsService.get).not.toHaveBeenCalled();
    expect(providerStub.sendTurn).not.toHaveBeenCalled();
  });
});

describe("AgentService internal MCP provider allowlist", () => {
  it.each(["claude", "codex", "cursor", "copilot"] as const)("includes %s for initial and retry activation", (provider) => {
    expect(supportsInternalThreadControl(provider)).toBe(true);
  });

  it("excludes unsupported providers", () => {
    expect(Reflect.apply(supportsInternalThreadControl, undefined, ["unknown"])).toBe(false);
  });

  it.each([
    "Spawn exactly one nested provider-native child named leaf_probe",
    "Delegate this task to a provider-native subagent",
  ])("revokes thread control at turn start for child-agent wording: %s", async (content) => {
    const { svc, threadControlMcp } = buildService();

    await svc.sendMessage({
      threadId: THREAD_ID,
      content,
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "codex",
    });

    expect(threadControlMcp.activate).not.toHaveBeenCalled();
    expect(threadControlMcp.revoke).toHaveBeenCalledWith(`mcode-${THREAD_ID}`);
  });

  it("activates thread control only for an explicit Mcode thread request", async () => {
    const { svc, threadControlMcp } = buildService();

    await svc.sendMessage({
      threadId: THREAD_ID,
      content: "Create one Mcode thread named leaf_probe",
      permissionMode: "default",
      model: "claude-sonnet-4-6",
      attachments: [],
      provider: "codex",
    });

    expect(threadControlMcp.revoke).not.toHaveBeenCalled();
    expect(threadControlMcp.activate).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: `mcode-${THREAD_ID}`,
      eligible: true,
    }));
  });
});
