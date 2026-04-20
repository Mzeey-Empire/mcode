import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";
import type Database from "better-sqlite3";
import { AgentEventType } from "@mcode/contracts";
import type {
  AgentEvent,
  IAgentProvider,
  IProviderRegistry,
  ProviderId,
} from "@mcode/contracts";
import { openMemoryDatabase } from "../store/database";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { MessageRepo } from "../repositories/message-repo";
import { ToolCallRecordRepo } from "../repositories/tool-call-record-repo";
import { TurnSnapshotRepo } from "../repositories/turn-snapshot-repo";
import { TaskRepo } from "../repositories/task-repo";
import { AgentService } from "../services/agent-service";
import type { GitService } from "../services/git-service";
import type { AttachmentService } from "../services/attachment-service";
import type { SnapshotService } from "../services/snapshot-service";
import type { MemoryPressureService } from "../services/memory-pressure-service";
import type { ThreadService } from "../services/thread-service";
import type { SettingsService } from "../services/settings-service";

/**
 * Test harness for AgentService.sendMessage "turn started" emission.
 *
 * The provider is stubbed with an EventEmitter whose sendMessage() returns a
 * never-resolving promise, so we can assert the turnStarted event lands on the
 * EventEmitter bus BEFORE provider.sendMessage() completes.
 */
describe("AgentService.sendMessage emits TurnStarted", () => {
  let db: Database.Database;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let messageRepo: MessageRepo;
  let toolCallRecordRepo: ToolCallRecordRepo;
  let turnSnapshotRepo: TurnSnapshotRepo;
  let taskRepo: TaskRepo;
  let svc: AgentService;
  let providerStub: EventEmitter & Partial<IAgentProvider> & {
    sendMessage: ReturnType<typeof vi.fn>;
  };
  let capturedEvents: AgentEvent[];

  beforeEach(() => {
    db = openMemoryDatabase();
    threadRepo = new ThreadRepo(db);
    workspaceRepo = new WorkspaceRepo(db);
    messageRepo = new MessageRepo(db);
    toolCallRecordRepo = new ToolCallRecordRepo(db);
    turnSnapshotRepo = new TurnSnapshotRepo(db);
    taskRepo = new TaskRepo(db);

    // Capture AgentEvents emitted on the provider bus.
    capturedEvents = [];
    providerStub = Object.assign(new EventEmitter(), {
      id: "claude" as ProviderId,
      supportsCompletion: false,
      // Never resolves — we want to observe events emitted BEFORE completion.
      sendMessage: vi.fn(() => new Promise<void>(() => {})),
      stopSession: vi.fn(),
      setSdkSessionId: vi.fn(),
      shutdown: vi.fn(),
    });
    providerStub.on("event", (e: AgentEvent) => capturedEvents.push(e));

    const registryStub: IProviderRegistry = {
      resolve: () => providerStub as unknown as IAgentProvider,
      resolveAll: () => [providerStub as unknown as IAgentProvider],
      shutdown: () => {},
    };

    const gitServiceStub = {
      // process.cwd() is guaranteed to be a real absolute directory, satisfying
      // AgentService's isAbsolute/existsSync/statSync validation.
      resolveWorkingDir: vi.fn(() => process.cwd()),
    } as unknown as GitService;

    const attachmentServiceStub = {
      persist: vi.fn(async () => ({ stored: [], persisted: [] })),
    } as unknown as AttachmentService;

    const snapshotServiceStub = {
      captureRef: vi.fn(async () => "ref-before-sha"),
    } as unknown as SnapshotService;

    const memoryPressureServiceStub = {
      markActive: vi.fn(),
      markIdle: vi.fn(),
    } as unknown as MemoryPressureService;

    const settingsServiceStub = {
      get: vi.fn(async () => ({
        model: { defaults: { fallbackId: undefined } },
        agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
      })),
    } as unknown as SettingsService;

    // ThreadService is lazy-resolved via tsyringe's delay(), so a shallow stub is fine.
    const threadServiceStub = {} as unknown as ThreadService;

    svc = new AgentService(
      threadRepo,
      workspaceRepo,
      messageRepo,
      gitServiceStub,
      attachmentServiceStub,
      registryStub,
      threadServiceStub,
      toolCallRecordRepo,
      turnSnapshotRepo,
      snapshotServiceStub,
      memoryPressureServiceStub,
      taskRepo,
      settingsServiceStub,
    );
  });

  it("emits turnStarted through the provider before provider.sendMessage resolves", async () => {
    const workspace = workspaceRepo.create("test-ws", process.cwd());
    const thread = threadRepo.create(workspace.id, "Test Thread", "direct", "main", true, "claude");

    // Kick off sendMessage without awaiting — provider.sendMessage never resolves.
    void svc.sendMessage(thread.id, "hello", "default");

    // Let the async prelude (attachment persist + ref capture + settings.get) settle.
    await new Promise((r) => setTimeout(r, 10));

    const turnStarted = capturedEvents.find((e) => e.type === AgentEventType.TurnStarted);
    expect(turnStarted, "expected a turnStarted event on the provider bus").toBeDefined();
    expect(turnStarted).toMatchObject({
      type: AgentEventType.TurnStarted,
      threadId: thread.id,
    });

    expect(svc.activeThreadIds()).toContain(thread.id);

    // Provider.sendMessage must have been invoked — confirms the emit happened
    // during sendMessage flow, not via some other path.
    expect(providerStub.sendMessage).toHaveBeenCalledTimes(1);
  });
});
