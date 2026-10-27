import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { createThreadPersistenceTestRuntime } from "../../testing/thread-persistence-test-runtime.js";
let persistenceRuntime: ReturnType<typeof createThreadPersistenceTestRuntime>;
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../../agents/conversation/persistence/message-repo.js";
import { getDefaultSettings, type CompletedThreadRetentionDays, type Settings } from "@mcode/contracts/models/settings";
import type { AgentService } from "../../../agents/index.js";
import type { ApprovalService } from "../../../agents/approvals/approval-service.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import type { ThreadTeardownService } from "../thread-teardown-service.js";
import { ThreadControlMutationReservationService } from "../../authority/thread-control-mutation-reservation-service.js";
import { ThreadCompletionService } from "../thread-completion-service.js";
import { CleanupJobRepo } from "../../cleanup/persistence/cleanup-job-repo.js";
import { createMockApproval } from "@mcode/contracts/testing";
import { broadcast } from "../../../../application/transport/push.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));



describe("ThreadCompletionService", () => {
  let db: Database;
  let threadRepo: ThreadRepo;
  let agentService: AgentService;
  let permissions: ApprovalService;
  let teardownService: ThreadTeardownService;
  let settingsService: SettingsService;
  let service: ThreadCompletionService;
  let threadId: string;
  let cleanupJobRepo: CleanupJobRepo;
  let now: Date;
  let settings: Settings;
  let settingsListener: ((settings: Settings) => void) | null;
  let activeThreadIds: ReturnType<typeof vi.fn<() => string[]>>;
  let mutationReservations: ThreadControlMutationReservationService;

  beforeEach(async () => {
    vi.mocked(broadcast).mockClear();
    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    const workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    cleanupJobRepo = new CleanupJobRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadId = (await threadRepo.create(
      (await workspaceRepo.create("Test", "/tmp/test", true)).id,
      "Complete me",
      "direct",
      "main",
    )).id;
    activeThreadIds = vi.fn(() => []);
    agentService = {
      runtimeAccess: () => ({ activeThreadIds }),
    } as unknown as AgentService;
    permissions = {
      listPendingApprovals: vi.fn(() => []),
    } as unknown as ApprovalService;
    teardownService = {
      teardownThread: vi.fn().mockResolvedValue(undefined),
    } as unknown as ThreadTeardownService;
    now = new Date("2026-08-12T08:00:00.000Z");
    settings = getDefaultSettings();
    settingsListener = null;
    settingsService = {
      get: vi.fn(() => settings),
      on: vi.fn((_event, listener) => {
        settingsListener = listener;
        return () => {
          settingsListener = null;
        };
      }),
    } as unknown as SettingsService;
    mutationReservations = new ThreadControlMutationReservationService();
    service = new ThreadCompletionService(
      threadRepo,
      agentService,
      permissions,
      teardownService,
      mutationReservations,
      settingsService,
      () => now,
      cleanupJobRepo,
    );
    service.start();
  });

  async function applyRetention(retentionDays: CompletedThreadRetentionDays): Promise<void> {
    settings = {
      ...settings,
      thread: {
        completion: {
          ...settings.thread.completion,
          retentionDays,
        },
      },
    };
    settingsListener?.(settings);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await persistenceRuntime.writer.barrier();
    await Promise.resolve();
  }

  it("persists completion separately from runtime status and releases resources", async () => {
    const completed = await service.complete(threadId);

    expect(completed).toMatchObject({
      ok: true,
      thread: {
        status: "active",
        user_completed_at: "2026-08-12T08:00:00.000Z",
        scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
      },
    });
    expect(completed).toEqual({ ok: true, thread: threadRepo.findById(threadId) });
    expect(teardownService.teardownThread).toHaveBeenCalledWith(threadId);
  });

  it("keeps the first completion deadline when completion repeats", async () => {
    const first = await service.complete(threadId);
    const second = await service.complete(threadId);

    expect(second).toEqual(first);
    expect(second).toMatchObject({ ok: true, thread: { user_completed_at: "2026-08-12T08:00:00.000Z" } });
    expect(vi.mocked(broadcast).mock.calls.filter(([channel]) => channel === "thread.lifecycleChanged")).toHaveLength(1);
    expect(teardownService.teardownThread).toHaveBeenCalledTimes(1);
  });

  it("publishes a manual completion without the automatic marker", async () => {
    await service.complete(threadId);

    const pushes = vi.mocked(broadcast).mock.calls.filter(([channel]) => channel === "thread.lifecycleChanged");
    expect(pushes).toEqual([["thread.lifecycleChanged", { thread: threadRepo.findById(threadId) }]]);
  });

  it("disables automatic deletion when the setting is Never", async () => {
    await applyRetention(null);

    const completed = await service.complete(threadId);

    expect(completed).toMatchObject({ ok: true, thread: { scheduled_deletion_at: null } });
  });

  it("recalculates existing deadlines from their original completion timestamps", async () => {
    const changed = vi.fn();
    service.onDeadlineChanges(changed);
    await service.complete(threadId);

    await applyRetention(10);

    const recalculated = threadRepo.findById(threadId);
    expect(recalculated?.user_completed_at).toBe("2026-08-12T08:00:00.000Z");
    expect(recalculated?.scheduled_deletion_at).toBe("2026-08-22T08:00:00.000Z");
    expect(changed).toHaveBeenCalledWith([recalculated]);
  });

  it("preserves blocked cleanup state while recalculating its deadline", async () => {
    db.prepare(
      `UPDATE threads
          SET user_completed_at = ?, scheduled_deletion_at = ?, cleanup_state = 'blocked', cleanup_reason = 'dirty'
        WHERE id = ?`,
    ).run(now.toISOString(), "2026-08-13T08:00:00.000Z", threadId);

    await applyRetention(10);

    expect(threadRepo.findById(threadId)).toMatchObject({
      scheduled_deletion_at: "2026-08-22T08:00:00.000Z",
      cleanup_state: "blocked",
      cleanup_reason: "dirty",
    });
    expect(cleanupJobRepo.findByThreadId(threadId)).toBeNull();
  });

  it("recalculates large histories in bounded batches", async () => {
    const updateSpy = vi.spyOn(threadRepo, "updateCompletedThreadDeadlines");
    const workspaceId = threadRepo.findById(threadId)!.workspace_id;
    for (let index = 0; index < 101; index += 1) {
      const id = (await threadRepo.create(workspaceId, `Completed ${index}`, "direct", "main")).id;
      (await threadRepo.complete(id, now.toISOString(), "2026-08-15T08:00:00.000Z"));
    }

    await applyRetention(10);

    await vi.waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(2);
    });
    expect(updateSpy.mock.calls.every(([updates]) => updates.length <= 100)).toBe(true);
  });

  it("shortens a future deadline from its original completion timestamp", async () => {
    await service.complete(threadId);

    await applyRetention(2);

    expect(threadRepo.findById(threadId)?.scheduled_deletion_at).toBe(
      "2026-08-14T08:00:00.000Z",
    );
  });

  it("cancels every pending deadline without reopening completed threads", async () => {
    const secondThreadId = (await threadRepo.create(
      threadRepo.findById(threadId)!.workspace_id,
      "Also complete",
      "direct",
      "main",
    )).id;
    await service.complete(threadId);
    await service.complete(secondThreadId);
    db.prepare("UPDATE threads SET cleanup_state = 'queued' WHERE id = ?").run(threadId);
    db.prepare(
      `INSERT INTO cleanup_jobs
        (id, thread_id, workspace_path, worktree_path, branch, kind, attempts, next_retry_at, created_at)
       VALUES ('retention-cancel', ?, '/repo', NULL, 'main', 'retention', 0, 0, 1)`,
    ).run(threadId);

    await applyRetention(null);

    expect(threadRepo.findById(threadId)).toMatchObject({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: null,
      cleanup_state: null,
      cleanup_reason: null,
    });
    expect(threadRepo.findById(secondThreadId)).toMatchObject({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: null,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM cleanup_jobs WHERE thread_id = ?").get(threadId),
    ).toEqual({ count: 0 });
  });

  it("gives a newly overdue thread 24 hours after retention becomes shorter", async () => {
    await applyRetention(10);
    now = new Date("2026-08-05T08:00:00.000Z");
    await service.complete(threadId);
    now = new Date("2026-08-12T08:00:00.000Z");

    await applyRetention(3);

    expect(threadRepo.findById(threadId)?.scheduled_deletion_at).toBe(
      "2026-08-13T08:00:00.000Z",
    );
  });

  it("does not move deadlines when the same setting is applied again", async () => {
    const changed = vi.fn();
    service.onDeadlineChanges(changed);
    await service.complete(threadId);

    await applyRetention(3);

    expect(threadRepo.findById(threadId)?.scheduled_deletion_at).toBe(
      "2026-08-15T08:00:00.000Z",
    );
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps recalculated deadlines after the service restarts", async () => {
    await service.complete(threadId);
    await applyRetention(10);
    service.stop();
    const persistedDeadline = threadRepo.findById(threadId)?.scheduled_deletion_at;
    const restarted = new ThreadCompletionService(
      threadRepo,
      agentService,
      permissions,
      teardownService,
      new ThreadControlMutationReservationService(),
      settingsService,
      () => new Date("2026-08-20T08:00:00.000Z"),
      cleanupJobRepo,
    );

    restarted.start();

    expect(threadRepo.findById(threadId)?.scheduled_deletion_at).toBe(persistedDeadline);
  });

  it("keeps completion committed when runtime resource release fails", async () => {
    vi.mocked(teardownService.teardownThread).mockRejectedValueOnce(
      new Error("terminal teardown failed"),
    );

    await expect(service.complete(threadId)).resolves.toMatchObject({ ok: true, thread: { cleanup_state: "blocked" } });

    expect(threadRepo.findById(threadId)).toMatchObject({
      user_completed_at: "2026-08-12T08:00:00.000Z",
      scheduled_deletion_at: "2026-08-15T08:00:00.000Z",
      cleanup_state: "blocked",
      cleanup_reason: "terminal teardown failed",
    });
  });

  it("releases every registered server-side resource owner", async () => {
    const releaseCiWatcher = vi.fn().mockResolvedValue(undefined);
    service.registerResourceOwner("ci-watcher", releaseCiWatcher);

    await service.complete(threadId);

    expect(releaseCiWatcher).toHaveBeenCalledOnce();
    expect(releaseCiWatcher).toHaveBeenCalledWith(threadId);
  });

  it("leaves resources untouched when completion persistence fails", async () => {
    const releaseBarrier = vi.fn();
    const releaseOwner = vi.fn().mockResolvedValue(releaseBarrier);
    service.registerResourceOwner("workspace-environment", releaseOwner);
    vi.spyOn(threadRepo, "complete").mockResolvedValueOnce(null);

    await expect(service.complete(threadId)).rejects.toThrow(`Thread not found: ${threadId}`);

    expect(releaseOwner).not.toHaveBeenCalled();
    expect(releaseBarrier).not.toHaveBeenCalled();
    expect(threadRepo.findById(threadId)?.user_completed_at).toBeNull();
  });

  it("releases a completed resource-owner barrier when another resource fails", async () => {
    const releaseBarrier = vi.fn();
    service.registerResourceOwner("workspace-environment", vi.fn().mockResolvedValue(releaseBarrier));
    service.registerResourceOwner("broken-owner", vi.fn().mockRejectedValue(new Error("release failed")));

    await expect(service.complete(threadId)).resolves.toMatchObject({ ok: true, thread: { cleanup_state: "blocked" } });

    expect(releaseBarrier).toHaveBeenCalledOnce();
    expect(threadRepo.findById(threadId)?.user_completed_at).toBe("2026-08-12T08:00:00.000Z");
  });

  it("releases registered thread resources after completion commits", async () => {
    const cancelSetup = vi.fn().mockResolvedValue(undefined);
    service.registerResourceOwner("workspace-environment", cancelSetup);

    await service.complete(threadId);

    expect(cancelSetup).toHaveBeenCalledWith(threadId);
    expect(threadRepo.findById(threadId)?.user_completed_at).toBe(now.toISOString());
  });

  it("exposes committed completion while releasing runtime resources", async () => {
    let observedCompletion: string | null | undefined;
    service.registerResourceOwner("completion-observer", async (id) => {
      observedCompletion = threadRepo.findById(id)?.user_completed_at;
    });

    await service.complete(threadId);

    expect(observedCompletion).toBe("2026-08-12T08:00:00.000Z");
  });

  it("rejects completion while the thread is running", async () => {
    activeThreadIds.mockReturnValue([threadId]);

    await expect(service.complete(threadId)).resolves.toEqual({ ok: false, refusal: "running" });
    expect(threadRepo.findById(threadId)?.user_completed_at).toBeNull();
    expect(teardownService.teardownThread).not.toHaveBeenCalled();
  });

  it("rejects completion while permission is pending", async () => {
    vi.mocked(permissions.listPendingApprovals).mockReturnValue([
      createMockApproval({ requestId: "permission-1", threadId }),
    ]);

    await expect(service.complete(threadId)).resolves.toEqual({ ok: false, refusal: "approval-pending" });
    expect(threadRepo.findById(threadId)?.user_completed_at).toBeNull();
  });

  it("reopens the thread and cancels its pending deletion", async () => {
    await service.complete(threadId);

    const reopened = (await service.reopen(threadId));

    expect(reopened.user_completed_at).toBeNull();
    expect(reopened.scheduled_deletion_at).toBeNull();
    expect(threadRepo.findById(threadId)).toEqual(reopened);
  });

  it("atomically cancels queued retention cleanup when the user reopens", async () => {
    await service.complete(threadId);
    db.prepare("UPDATE threads SET cleanup_state = 'queued' WHERE id = ?").run(threadId);
    db.prepare(
      `INSERT INTO cleanup_jobs
        (id, thread_id, workspace_path, worktree_path, branch, kind, attempts, next_retry_at, created_at)
       VALUES ('cleanup-1', ?, '/repo', NULL, 'main', 'retention', 0, 0, 1)`,
    ).run(threadId);

    const reopened = (await service.reopen(threadId));

    expect(reopened).toMatchObject({
      user_completed_at: null,
      scheduled_deletion_at: null,
      cleanup_state: null,
      cleanup_reason: null,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM cleanup_jobs WHERE thread_id = ?").get(threadId),
    ).toEqual({ count: 0 });
  });

  it("returns one conflict after destructive cleanup starts", async () => {
    await service.complete(threadId);
    db.prepare("UPDATE threads SET cleanup_state = 'running' WHERE id = ?").run(threadId);

    await expect(service.reopen(threadId)).rejects.toThrow("Thread cleanup has already started");
    expect(threadRepo.findById(threadId)).toMatchObject({
      cleanup_state: "running",
      user_completed_at: expect.any(String),
    });
  });

  it("allows reopening after retry exhaustion has removed the cleanup job", async () => {
    await service.complete(threadId);
    db.prepare(
      "UPDATE threads SET cleanup_state = 'blocked', cleanup_reason = ? WHERE id = ?",
    ).run("Cleanup failed after 5 attempts.", threadId);

    expect((await service.reopen(threadId))).toMatchObject({
      cleanup_state: null,
      user_completed_at: null,
    });
    expect(cleanupJobRepo.findByThreadId(threadId)).toBeNull();
    expect(threadRepo.findById(threadId)).toMatchObject({
      cleanup_state: null,
      user_completed_at: null,
    });
  });

  it("allows reopen when cleanup is blocked before destructive work starts", async () => {
    await service.complete(threadId);
    db.prepare("UPDATE threads SET cleanup_state = 'blocked' WHERE id = ?").run(threadId);

    expect((await service.reopen(threadId))).toMatchObject({
      cleanup_state: null,
      user_completed_at: null,
    });
  });

  it("counts blocked completed retention candidates", async () => {
    db.prepare(
      `UPDATE threads
          SET user_completed_at = ?, scheduled_deletion_at = ?, cleanup_state = 'blocked'
        WHERE id = ?`,
    ).run(now.toISOString(), now.toISOString(), threadId);
    const second = (await threadRepo.create(
      threadRepo.findById(threadId)!.workspace_id,
      "Second blocked",
      "direct",
      "main",
    ));
    db.prepare(
      `UPDATE threads
          SET user_completed_at = ?, scheduled_deletion_at = ?, cleanup_state = 'blocked'
        WHERE id = ?`,
    ).run(now.toISOString(), now.toISOString(), second.id);

    expect(service.cleanupBlockedCount()).toEqual({ count: 2 });
  });

  it("requeues one blocked thread and rebuilds its retention job atomically", async () => {
    db.prepare(
      `UPDATE threads
          SET user_completed_at = ?, scheduled_deletion_at = ?, cleanup_state = 'blocked'
        WHERE id = ?`,
    ).run(now.toISOString(), now.toISOString(), threadId);
    const oldJob = (await cleanupJobRepo.insert({
      thread_id: threadId,
      workspace_path: "/tmp/test",
      worktree_path: null,
      branch: "main",
      kind: "retention",
    }));
    (await cleanupJobRepo.recordFailure(oldJob.id, "old failure"));

    const queued = await service.retryCleanup(threadId);
    const rebuilt = cleanupJobRepo.findByThreadId(threadId);
    expect(queued.cleanup_state).toBe("queued");
    expect(rebuilt).toMatchObject({ kind: "retention", attempts: 0, next_retry_at: 0 });
    expect(rebuilt?.id).not.toBe(oldJob.id);
  });

  it("rejects retry for a thread that is not blocked", async () => {
    const initial = threadRepo.findById(threadId);
    await expect(service.retryCleanup(threadId)).rejects.toThrow();
    expect(threadRepo.findById(threadId)).toEqual(initial);
    db.prepare(
      `UPDATE threads
          SET user_completed_at = ?, scheduled_deletion_at = ?, cleanup_state = 'queued'
        WHERE id = ?`,
    ).run(now.toISOString(), now.toISOString(), threadId);
    const queued = threadRepo.findById(threadId);
    await expect(service.retryCleanup(threadId)).rejects.toThrow();
    expect(threadRepo.findById(threadId)).toEqual(queued);
    expect(cleanupJobRepo.findByThreadId(threadId)).toBeNull();
  });

  it("preserves conversation, attachments, and repository identity", async () => {
    const messageRepo = new MessageRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    (await messageRepo.create(threadId, "user", "Keep this context", 1, [{
      id: "attachment-1",
      name: "context.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    }]));
    (await threadRepo.updateWorktreePath(threadId, "C:/repo/worktree"));

    await service.complete(threadId);

    expect(messageRepo.listByThread(threadId, 10).messages).toEqual([
      expect.objectContaining({
        content: "Keep this context",
        attachments: [expect.objectContaining({ id: "attachment-1" })],
      }),
    ]);
    expect(threadRepo.findById(threadId)).toMatchObject({
      branch: "main",
      worktree_path: "C:/repo/worktree",
    });
  });

  it("serializes competing lifecycle requests", async () => {
    const [first, second] = await Promise.allSettled([
      service.complete(threadId),
      service.complete(threadId),
    ]);

    expect(first).toMatchObject({ status: "fulfilled", value: { ok: true } });
    expect(second).toEqual({ status: "fulfilled", value: { ok: false, refusal: "busy" } });
    expect(threadRepo.findById(threadId)?.user_completed_at).toBe("2026-08-12T08:00:00.000Z");
  });

  it("refuses a thread with an existing mutation reservation", async () => {
    mutationReservations.reserve(threadId, "reopening");

    await expect(service.complete(threadId)).resolves.toEqual({ ok: false, refusal: "busy" });

    expect(threadRepo.findById(threadId)?.user_completed_at).toBeNull();
    expect(teardownService.teardownThread).not.toHaveBeenCalled();
  });
});
