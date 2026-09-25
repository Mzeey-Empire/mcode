import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { HandoffStorage } from "../../../handoff/index.js";
import {
  GitWorktreeService,
  RepositoryGitMutationLock,
  SandboxWorktreeCleanupPolicy,
} from "../../../projects/index.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import type { ClaudeProvider } from "../../../providers/adapters/claude/claude-provider.js";
import { ThreadDeletionTeardownService } from "../../lifecycle/thread-deletion-teardown-service.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { ThreadControlMutationReservationService } from "../../index.js";
import { CleanupWorker } from "../cleanup-worker.js";
import { CleanupJobRepo } from "../persistence/cleanup-job-repo.js";

const HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;

// Each test runs a real teardown path: a PowerShell descendant scan plus the
// 1.5s Windows handle-release delay puts every case near the 5s default.
describe("CleanupWorker sandbox worktrees", { timeout: 20_000 }, () => {
  let database: Database;
  let cleanupJobs: CleanupJobRepo;
  let threads: ThreadRepo;
  let workspaces: WorkspaceRepo;
  let gitWorktrees: GitWorktreeService;
  let cleanupPolicy: SandboxWorktreeCleanupPolicy;
  let mutationLock: RepositoryGitMutationLock;
  let threadDeletion: ThreadDeletionTeardownService;
  let worker: CleanupWorker;

  beforeEach(() => {
    database = openMemoryDatabase();
    cleanupJobs = new CleanupJobRepo(database);
    threads = new ThreadRepo(database);
    workspaces = new WorkspaceRepo(database);
    gitWorktrees = {
      removeWorktree: vi.fn().mockResolvedValue(true),
    } as unknown as GitWorktreeService;
    cleanupPolicy = {
      decide: vi.fn(async ({ worktreePath }) => ({
        action: "remove",
        worktreePath,
        branch: "feature/dirty",
      })),
      isSameSandboxPath: vi.fn((left: string, right: string) =>
        left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase()),
      resolveSandboxPath: vi.fn(async (path: string) => path),
    } as unknown as SandboxWorktreeCleanupPolicy;
    threadDeletion = {
      teardownThread: vi.fn().mockResolvedValue(undefined),
    } as unknown as ThreadDeletionTeardownService;
    mutationLock = new RepositoryGitMutationLock(HOST_RUNTIME);
    worker = new CleanupWorker(
      database,
      cleanupJobs,
      threads,
      { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider,
      gitWorktrees,
      cleanupPolicy,
      mutationLock,
      workspaces,
      { removeForThread: vi.fn() } as unknown as AttachmentService,
      { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage,
      threadDeletion,
      HOST_RUNTIME,
      new ThreadControlMutationReservationService(),
    );
  });

  function addThread(
    workspaceId: string,
    id: string,
    path: string,
    branch: string,
    scheduledDeletionAt: string | null,
  ): void {
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO threads (
        id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed,
        user_completed_at, scheduled_deletion_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'worktree', 'active', ?, 1, ?, ?, ?, ?)`,
    ).run(
      id,
      workspaceId,
      id,
      branch,
      path,
      scheduledDeletionAt ? now : null,
      scheduledDeletionAt,
      now,
      now,
    );
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
      resolve = nextResolve;
    });
    return { promise, resolve };
  }

  it("keeps a sandbox worktree and active handoff thread", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const path = "C:\\Users\\user\\.mcode\\worktrees\\repo\\feature";
    addThread(workspace.id, "expired", path, "feature/dirty", new Date(0).toISOString());
    addThread(workspace.id, "active-handoff", path, "feature/dirty", null);
    database.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?").run("expired", "active-handoff");
    const now = new Date().toISOString();
    const addCanonicalThread = database.prepare(
      `INSERT INTO canonical_agent_threads (
        id, workspace_id, parent_thread_id, root_thread_id, owning_parent_thread_id,
        provider_id, provider_identities_json, activity_state, conversation_revision,
        roster_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'claude', '[]', 'Idle', 0, 0, ?, ?)`,
    );
    addCanonicalThread.run("expired", workspace.id, null, "expired", null, now, now);
    addCanonicalThread.run("active-handoff", workspace.id, "expired", "expired", "expired", now, now);

    await worker.poll();

    expect(threads.findById("expired")).toBeNull();
    expect(threads.findById("active-handoff")).toMatchObject({ parent_thread_id: null });
    expect(
      database.prepare(
        "SELECT parent_thread_id, root_thread_id, owning_parent_thread_id FROM canonical_agent_threads WHERE id = ?",
      ).get("active-handoff"),
    ).toEqual({ parent_thread_id: null, root_thread_id: "active-handoff", owning_parent_thread_id: null });
    expect(threadDeletion.teardownThread).toHaveBeenCalledWith("expired");
    expect(threadDeletion.teardownThread).toHaveBeenCalledTimes(1);
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
  });

  it("does not remove a new worktree path from a stale cleanup job", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const stalePath = "C:\\Users\\user\\.mcode\\worktrees\\repo\\stale";
    const currentPath = "C:\\Users\\user\\.mcode\\worktrees\\repo\\current";
    addThread(workspace.id, "expired", stalePath, "feature/stale", null);
    threads.softDelete("expired");
    cleanupJobs.insert({
      thread_id: "expired",
      workspace_path: "/repo",
      worktree_path: stalePath,
      branch: "feature/stale",
    });
    database.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run(currentPath, "expired");

    await worker.poll();

    expect(threads.findById("expired")).toBeNull();
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
    expect(cleanupPolicy.decide).not.toHaveBeenCalled();
  });

  it("does not remove a path changed after cleanup validates the job", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const stalePath = "C:\\Users\\user\\.mcode\\worktrees\\repo\\stale";
    const currentPath = "C:\\Users\\user\\.mcode\\worktrees\\repo\\current";
    addThread(workspace.id, "expired", stalePath, "feature/stale", null);
    threads.softDelete("expired");
    cleanupJobs.insert({
      thread_id: "expired",
      workspace_path: "/repo",
      worktree_path: stalePath,
      branch: "feature/stale",
    });
    vi.spyOn(mutationLock, "run").mockImplementationOnce(async (_workspacePath, work) => {
      database.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run(currentPath, "expired");
      return await work();
    });

    await worker.poll();

    expect(threads.findById("expired")).toBeNull();
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
    expect(cleanupPolicy.decide).not.toHaveBeenCalled();
  });

  it("keeps a default-branch checkout and removes only the expired thread", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const path = "C:\\Users\\user\\.mcode\\worktrees\\repo\\main";
    addThread(workspace.id, "expired", path, "main", new Date(0).toISOString());
    addThread(workspace.id, "active-sibling", path, "main", null);
    vi.mocked(cleanupPolicy.decide).mockResolvedValue({
      action: "retain",
      reason: "primary-branch",
    });

    await worker.poll();

    expect(threads.findById("expired")).toBeNull();
    expect(threads.findById("active-sibling")).not.toBeNull();
    expect(threadDeletion.teardownThread).toHaveBeenCalledTimes(1);
    expect(threadDeletion.teardownThread).toHaveBeenCalledWith("expired");
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
  });

  it("keeps an external checkout and removes only the expired thread", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const path = "C:\\source\\shared-worktree";
    addThread(workspace.id, "expired", path, "feature/external", new Date(0).toISOString());
    addThread(workspace.id, "active-sibling", path, "feature/external", null);
    vi.mocked(cleanupPolicy.decide).mockResolvedValue({
      action: "retain",
      reason: "outside-sandbox",
    });

    await worker.poll();

    expect(threads.findById("expired")).toBeNull();
    expect(threads.findById("active-sibling")).not.toBeNull();
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
  });

  it("retries failed worktree removal without deleting the thread", async () => {
    const workspace = workspaces.create("Project", "/repo");
    addThread(
      workspace.id,
      "failed-removal",
      "C:\\Users\\user\\.mcode\\worktrees\\repo\\failed",
      "feature/failed",
      new Date(0).toISOString(),
    );
    vi.mocked(gitWorktrees.removeWorktree).mockResolvedValue(false);

    await worker.poll();

    expect(cleanupJobs.findByThreadId("failed-removal")).toMatchObject({
      attempts: 1,
      last_error: expect.stringContaining("still exists"),
    });
    expect(threads.findById("failed-removal")).not.toBeNull();
  });

  it("does not overlap cleanup polls while a worktree removal is running", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const removal = deferred<boolean>();
    const removalStarted = deferred<void>();
    addThread(
      workspace.id,
      "concurrent-removal",
      "C:\\Users\\user\\.mcode\\worktrees\\repo\\concurrent",
      "feature/concurrent",
      new Date(0).toISOString(),
    );
    vi.mocked(gitWorktrees.removeWorktree).mockImplementation(async () => {
      removalStarted.resolve();
      return await removal.promise;
    });

    const firstPoll = worker.poll();
    await removalStarted.promise;
    await worker.poll();

    expect(gitWorktrees.removeWorktree).toHaveBeenCalledExactlyOnceWith(
      "/repo",
      "concurrent",
      expect.objectContaining({ branchName: "feature/dirty" }),
    );

    removal.resolve(true);
    await firstPoll;
  });

  it("requeues exhausted jobs on startup so stale worktrees get retried", async () => {
    const workspace = workspaces.create("Project", "/repo");
    addThread(
      workspace.id,
      "exhausted-explicit",
      "C:\\Users\\user\\.mcode\\worktrees\\repo\\exhausted",
      "feature/exhausted",
      null,
    );
    threads.softDelete("exhausted-explicit");
    const job = cleanupJobs.insert({
      thread_id: "exhausted-explicit",
      workspace_path: "/repo",
      worktree_path: "C:\\Users\\user\\.mcode\\worktrees\\repo\\exhausted",
      branch: "feature/exhausted",
    });
    database.prepare("UPDATE cleanup_jobs SET attempts = 5 WHERE id = ?").run(job.id);

    expect(cleanupJobs.findDue(Date.now())).toHaveLength(0);

    await worker.reconcileOnStartup();
    await worker.poll();

    expect(threads.findById("exhausted-explicit")).toBeNull();
    expect(cleanupJobs.findById(job.id)).toBeNull();
    expect(gitWorktrees.removeWorktree).toHaveBeenCalledOnce();
  });

  it("restricts startup recovery and cleanup admission to the fixture workspace", async () => {
    const fixture = workspaces.create("Fixture", "/fixture");
    const user = workspaces.create("Copied user project", "/fixture-other");
    const deleting = workspaces.create("Deleting user project", "/user-deleting");
    const empty = workspaces.create("Empty deleting user project", "/user-empty");
    workspaces.softDelete(deleting.id);
    workspaces.softDelete(empty.id);
    addThread(deleting.id, "user-missing-job", "/user-worktree", "user", null);

    for (const workspace of [fixture, user]) {
      const expiredId = `${workspace.id}-expired`;
      const explicitId = `${workspace.id}-explicit`;
      addThread(workspace.id, expiredId, `${workspace.path}/expired`, "expired", new Date(0).toISOString());
      addThread(workspace.id, explicitId, `${workspace.path}/explicit`, "explicit", null);
      threads.softDelete(explicitId);
      const job = cleanupJobs.insert({
        thread_id: explicitId,
        workspace_path: workspace.path,
        worktree_path: `${workspace.path}/explicit`,
        branch: "explicit",
      });
      database.prepare("UPDATE cleanup_jobs SET attempts = 5, last_error = 'original error' WHERE id = ?")
        .run(job.id);
    }
    for (const kind of ["explicit", "retention"] as const) {
      cleanupJobs.insert({
        thread_id: `user-orphan-${kind}`,
        workspace_path: user.path,
        worktree_path: null,
        branch: null,
        kind,
      });
    }
    const userRows = () => ({
      workspaces: database.prepare("SELECT * FROM workspaces WHERE id != ? ORDER BY id").all(fixture.id),
      threads: database.prepare("SELECT * FROM threads WHERE workspace_id != ? ORDER BY id").all(fixture.id),
      jobs: database.prepare("SELECT * FROM cleanup_jobs WHERE workspace_path != ? ORDER BY id").all(fixture.path),
    });
    const before = userRows();

    worker.start(fixture.path);
    try {
      await worker.reconcileOnStartup();
      await worker.poll();

      expect(userRows()).toEqual(before);
      expect(threads.findById(`${fixture.id}-expired`)).toBeNull();
      expect(threads.findById(`${fixture.id}-explicit`)).toBeNull();
      expect(cleanupJobs.countByWorkspacePath(fixture.path)).toBe(0);
      expect(gitWorktrees.removeWorktree).toHaveBeenCalledTimes(2);
      expect(cleanupJobs.getDueCounts(Date.now(), fixture.path)).toEqual({ explicit: 0, retention: 0 });
      expect(await worker.processOneJob()).toBe(false);
      expect(userRows()).toEqual(before);
    } finally {
      await worker.shutdown();
    }
  });

  it("leaves all copied rows untouched when the fixture path has no matching workspace", async () => {
    const user = workspaces.create("Copied user project", "/user");
    addThread(user.id, "user-expired", "/user/expired", "expired", new Date(0).toISOString());
    const job = cleanupJobs.insert({
      thread_id: "user-orphan", workspace_path: user.path, worktree_path: null, branch: null,
    });
    database.prepare("UPDATE cleanup_jobs SET attempts = 5 WHERE id = ?").run(job.id);
    const threadBefore = threads.findById("user-expired");
    const jobBefore = cleanupJobs.findById(job.id);

    worker.start("/missing-fixture");
    try {
      await worker.reconcileOnStartup();
      await worker.poll();
      expect(await worker.processOneJob()).toBe(false);
      expect(threads.findById("user-expired")).toEqual(threadBefore);
      expect(cleanupJobs.findById(job.id)).toEqual(jobBefore);
      expect(cleanupJobs.count()).toBe(1);
      expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
    } finally {
      await worker.shutdown();
    }
  });

  it("deletes exhausted orphan job rows on the next poll after startup requeue", async () => {
    const job = cleanupJobs.insert({
      thread_id: "thread-already-gone",
      workspace_path: "/repo",
      worktree_path: "C:\\Users\\user\\.mcode\\worktrees\\repo\\orphan",
      branch: "feature/orphan",
    });
    database.prepare("UPDATE cleanup_jobs SET attempts = 5 WHERE id = ?").run(job.id);

    await worker.reconcileOnStartup();
    await worker.poll();

    expect(cleanupJobs.findById(job.id)).toBeNull();
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
  });

  it("blocks a retention cleanup with the underlying removal error attached", async () => {
    const workspace = workspaces.create("Project", "/repo");
    addThread(
      workspace.id,
      "blocked-retention",
      "C:\\Users\\user\\.mcode\\worktrees\\repo\\blocked",
      "feature/blocked",
      new Date(0).toISOString(),
    );
    database.prepare("UPDATE threads SET cleanup_state = 'queued' WHERE id = ?").run("blocked-retention");
    const job = cleanupJobs.insert({
      thread_id: "blocked-retention",
      workspace_path: "/repo",
      worktree_path: "C:\\Users\\user\\.mcode\\worktrees\\repo\\blocked",
      branch: "feature/blocked",
      kind: "retention",
    });
    database.prepare("UPDATE cleanup_jobs SET attempts = 4 WHERE id = ?").run(job.id);
    vi.mocked(gitWorktrees.removeWorktree).mockRejectedValue(new Error("removal timed out"));

    await worker.poll();

    expect(threads.findById("blocked-retention")).toMatchObject({
      cleanup_state: "blocked",
      cleanup_reason: expect.stringContaining("removal timed out"),
    });
    expect(cleanupJobs.findById(job.id)).toBeNull();
  });

  it("does not admit cleanup after disposal", async () => {
    const workspace = workspaces.create("Project", "/repo");
    addThread(
      workspace.id,
      "disposed-removal",
      "C:\\Users\\user\\.mcode\\worktrees\\repo\\disposed",
      "feature/disposed",
      new Date(0).toISOString(),
    );

    worker.dispose();
    await worker.poll();

    expect(threads.findById("disposed-removal")).not.toBeNull();
    expect(gitWorktrees.removeWorktree).not.toHaveBeenCalled();
  });

  it("waits for an active cleanup before shutdown completes", async () => {
    const workspace = workspaces.create("Project", "/repo");
    const removal = deferred<boolean>();
    const removalStarted = deferred<void>();
    addThread(
      workspace.id,
      "shutdown-removal",
      "C:\\Users\\user\\.mcode\\worktrees\\repo\\shutdown",
      "feature/shutdown",
      new Date(0).toISOString(),
    );
    vi.mocked(gitWorktrees.removeWorktree).mockImplementation(async () => {
      removalStarted.resolve();
      return await removal.promise;
    });

    const poll = worker.poll();
    await removalStarted.promise;
    let shutdownComplete = false;
    const shutdown = worker.shutdown().then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();

    expect(shutdownComplete).toBe(false);
    await worker.poll();
    expect(gitWorktrees.removeWorktree).toHaveBeenCalledOnce();

    removal.resolve(true);
    await poll;
    await shutdown;
    expect(shutdownComplete).toBe(true);
  });
});
