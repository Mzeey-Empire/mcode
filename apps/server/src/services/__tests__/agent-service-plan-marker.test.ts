import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { container } from "tsyringe";
import type Database from "better-sqlite3";
import type { Thread, IProviderRegistry } from "@mcode/contracts";
import { openMemoryDatabase } from "../../store/database.js";
import { ThreadRepo } from "../../repositories/thread-repo.js";
import { WorkspaceRepo } from "../../repositories/workspace-repo.js";
import { MessageRepo } from "../../repositories/message-repo.js";
import { PlanQuestionAnswersRepo } from "../../repositories/plan-question-answers-repo.js";
import { ToolCallRecordRepo } from "../../repositories/tool-call-record-repo.js";
import { TurnSnapshotRepo } from "../../repositories/turn-snapshot-repo.js";
import { TaskRepo } from "../../repositories/task-repo.js";
import { AgentService } from "../agent-service.js";
import { ProviderAvailabilityService } from "../provider-availability-service.js";
import type { GitService } from "../git-service.js";
import type { AttachmentService } from "../attachment-service.js";
import type { SnapshotService } from "../snapshot-service.js";
import type { MemoryPressureService } from "../memory-pressure-service.js";
import type { SettingsService } from "../settings-service.js";
import type { ThreadService } from "../thread-service.js";
import { EventEmitter } from "events";

// Stub broadcast so we can assert push events without a real WebSocket server.
vi.mock("../../transport/push.js", () => ({ broadcast: vi.fn() }));
import { broadcast } from "../../transport/push.js";

/**
 * Build an AgentService against a real in-memory SQLite DB so the marker
 * transaction can be exercised end-to-end (FK enforcement + rollback).
 */
function buildService(db: Database.Database) {
  container.reset();
  container.registerInstance("Database", db);

  const threadRepo = container.resolve(ThreadRepo);
  const workspaceRepo = container.resolve(WorkspaceRepo);
  const messageRepo = container.resolve(MessageRepo);
  const planQuestionAnswersRepo = container.resolve(PlanQuestionAnswersRepo);
  const toolCallRecordRepo = container.resolve(ToolCallRecordRepo);
  const turnSnapshotRepo = container.resolve(TurnSnapshotRepo);
  const taskRepo = container.resolve(TaskRepo);

  const gitService = {
    resolveWorkingDir: vi.fn(() => process.cwd()),
    listWorktrees: vi.fn(() => []),
  } as unknown as GitService;

  const attachmentService = {
    persist: vi.fn(() => Promise.resolve({ stored: [], persisted: [] })),
  } as unknown as AttachmentService;

  // Provider stub: extends EventEmitter (matches real provider shape) and
  // resolves sendMessage immediately so the turn "completes" without I/O.
  const providerStub = Object.assign(new EventEmitter(), {
    id: "claude" as const,
    supportsCompletion: true,
    sessionForkOnResume: "unsupported" as const,
    maxInputCharactersPerTurn: 16_000,
    sendMessage: vi.fn(() => Promise.resolve()),
    setSdkSessionId: vi.fn(),
  });
  const providerRegistry = {
    resolve: vi.fn(() => providerStub),
    resolveAll: vi.fn(() => []),
    shutdown: vi.fn(),
  } as unknown as IProviderRegistry;

  const threadService = { create: vi.fn() } as unknown as ThreadService;

  const snapshotService = {
    captureRef: vi.fn(() => Promise.resolve("abc123")),
    getFilesChanged: vi.fn(() => Promise.resolve([])),
  } as unknown as SnapshotService;

  const memoryPressureService = {
    markActive: vi.fn(),
    markIdle: vi.fn(),
  } as unknown as MemoryPressureService;

  const settingsService = {
    get: vi.fn(() =>
      Promise.resolve({
        model: { defaults: { fallbackId: undefined, contextWindow: "auto", thinking: false } },
        agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
        provider: { enabled: {}, cli: {} },
      }),
    ),
    on: vi.fn(),
  } as unknown as SettingsService;

  const availability = {
    assertUsable: vi.fn(),
  } as unknown as ProviderAvailabilityService;

  const svc = new AgentService(
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    attachmentService,
    providerRegistry,
    threadService,
    toolCallRecordRepo,
    { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../repositories/thought-segment-repo.js").ThoughtSegmentRepo,
    { bulkCreate: () => {}, create: () => ({}), listByMessage: () => [], countByMessage: () => 0 } as unknown as import("../../repositories/hook-execution-repo.js").HookExecutionRepo,
    turnSnapshotRepo,
    snapshotService,
    db,
    memoryPressureService,
    taskRepo,
    settingsService,
    availability,
    planQuestionAnswersRepo,
    { orchestrate: vi.fn() } as any,
    { write: vi.fn(), copyAttachments: vi.fn(() => []), deleteThreadFiles: vi.fn() } as any,
  );

  return { svc, threadRepo, workspaceRepo, messageRepo, planQuestionAnswersRepo };
}

describe("AgentService.sendMessage — plan-questions answered marker", () => {
  let db: Database.Database;
  let thread: Thread;
  let assistantMessageId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openMemoryDatabase();
    const { workspaceRepo, threadRepo, messageRepo } = buildService(db);
    const ws = workspaceRepo.create("test-ws", process.cwd(), false);
    thread = threadRepo.create(ws.id, "thread", "direct", "main");
    // Pre-existing assistant message that contains the plan-questions fence.
    const assistantMsg = messageRepo.create(
      thread.id,
      "assistant",
      "```plan-questions\n[]\n```",
      1,
    );
    assistantMessageId = assistantMsg.id;
  });

  it("marks the plan-questions message answered when markPlanAnswerForMessageId is set", async () => {
    const { svc, planQuestionAnswersRepo } = buildService(db);

    await svc.sendMessage(
      thread.id,
      "my answers",
      "default",
      "claude-sonnet-4-6",
      [],
      undefined,
      "claude",
      undefined, // interactionMode
      undefined, // maxBudgetUsd
      undefined, // maxTurns
      undefined, // copilotAgent
      undefined, // contextWindowMode
      undefined, // thinking
      undefined, // codexFastMode
      assistantMessageId, // markPlanAnswerForMessageId
    );

    expect(planQuestionAnswersRepo.isAnswered(assistantMessageId)).toBe(true);
  });

  it("does not mark anything when markPlanAnswerForMessageId is unset (regression guard)", async () => {
    const { svc, planQuestionAnswersRepo } = buildService(db);

    await svc.sendMessage(
      thread.id,
      "regular message",
      "default",
      "claude-sonnet-4-6",
      [],
      undefined,
      "claude",
    );

    expect(planQuestionAnswersRepo.listAnsweredForThread(thread.id)).toEqual([]);
  });

  it("answerQuestions marks the latest plan-questions message answered", async () => {
    const { svc, planQuestionAnswersRepo } = buildService(db);

    await svc.answerQuestions(thread.id, [
      { questionId: "q1", selectedOptionId: "opt1", freeText: null },
    ]);

    expect(planQuestionAnswersRepo.isAnswered(assistantMessageId)).toBe(true);
  });

  it("answerQuestions still sends when no plan-questions message exists", async () => {
    // Fresh thread/workspace with NO plan-questions assistant message.
    const { svc, workspaceRepo, threadRepo, planQuestionAnswersRepo } =
      buildService(db);
    const ws2 = workspaceRepo.create("plain-ws", `${process.cwd()}#alt`, false);
    const plainThread = threadRepo.create(ws2.id, "plain", "direct", "main");

    await expect(
      svc.answerQuestions(plainThread.id, [
        { questionId: "q1", selectedOptionId: null, freeText: "anything" },
      ]),
    ).resolves.toBeUndefined();

    expect(planQuestionAnswersRepo.listAnsweredForThread(plainThread.id)).toEqual([]);
  });

  it("broadcasts plan.answered after the marker tx commits", async () => {
    const { svc } = buildService(db);

    await svc.sendMessage(
      thread.id,
      "my answers",
      "default",
      "claude-sonnet-4-6",
      [],
      undefined,
      "claude",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      assistantMessageId,
    );

    expect(broadcast).toHaveBeenCalledWith("plan.answered", {
      threadId: thread.id,
      assistantMessageId,
    });
  });

  it("does not broadcast plan.answered when no marker was set", async () => {
    const { svc } = buildService(db);

    await svc.sendMessage(
      thread.id,
      "regular message",
      "default",
      "claude-sonnet-4-6",
      [],
      undefined,
      "claude",
    );

    const calls = (broadcast as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "plan.answered",
    );
    expect(calls).toEqual([]);
  });

  it("does not broadcast plan.answered when the marker tx rolls back", async () => {
    const { svc } = buildService(db);

    await expect(
      svc.sendMessage(
        thread.id,
        "answers that should NOT persist",
        "default",
        "claude-sonnet-4-6",
        [],
        undefined,
        "claude",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "non-existent-message-id",
      ),
    ).rejects.toThrow();

    const calls = (broadcast as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "plan.answered",
    );
    expect(calls).toEqual([]);
  });

  it("rolls back the user message when the marker insert fails (FK violation)", async () => {
    const { svc, messageRepo, planQuestionAnswersRepo } = buildService(db);
    const beforeCount =
      messageRepo.listByThread(thread.id, 100).messages.length;

    // Pass an unknown message id so the FK rejects the marker insert.
    // The user-message INSERT must roll back as part of the same transaction.
    await expect(
      svc.sendMessage(
        thread.id,
        "answers that should NOT persist",
        "default",
        "claude-sonnet-4-6",
        [],
        undefined,
        "claude",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "non-existent-message-id",
      ),
    ).rejects.toThrow();

    const afterCount =
      messageRepo.listByThread(thread.id, 100).messages.length;
    expect(afterCount).toBe(beforeCount);
    expect(planQuestionAnswersRepo.listAnsweredForThread(thread.id)).toEqual([]);
  });
});
