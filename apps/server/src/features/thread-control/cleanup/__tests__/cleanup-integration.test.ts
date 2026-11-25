/**
 * Integration test for the full worktree cleanup flow.
 * Uses real database and repos (not mocks) to verify the end-to-end path:
 * ThreadService.delete -> CleanupJobRepo.insert -> CleanupWorker.poll -> hardDelete
 */
import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { createThreadPersistenceTestRuntime } from "../../testing/thread-persistence-test-runtime.js";
let persistenceRuntime: ReturnType<typeof createThreadPersistenceTestRuntime>;
import { CleanupJobRepo } from "../persistence/cleanup-job-repo.js";
import { ThreadRepo } from "../../persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { CleanupWorker } from "../cleanup-worker.js";
import { HandoffStorage } from "../../../handoff/index.js";
import { ThreadService } from "../../index.js";
import type { ClaudeProviderBoundary as ClaudeProvider } from "@mcode/providers";
import type { GitExecutor } from "../../../projects/git/execution/index.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import {
  ProjectWorktreeService,
  RepositoryGitMutationLock,
  type GitWorktreeService,
  type SandboxWorktreeCleanupPolicy,
  WorkspaceService,
} from "../../../projects/index.js";
import { ThreadDeletionTeardownService } from "../../lifecycle/thread-deletion-teardown-service.js";
import { getMcodeDir } from "@mcode/shared";
import { NoProjectWorkspaceSweep } from "../no-project-workspace-sweep.js";
import { ThreadStartupRepo } from "../../../thread-startup/persistence/thread-startup-repo.js";
import { ThreadStartupService } from "../../../thread-startup/thread-startup-service.js";

const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const WT_BASE = NodePath.join(getMcodeDir(), "worktrees", "integration-test");

describe("Cleanup integration", () => {
  let db: Database;
  let cleanupJobRepo: CleanupJobRepo;
  let threadRepo: ThreadRepo;
  let workspaceRepo: WorkspaceRepo;
  let threadService: ThreadService;
  let worker: CleanupWorker;
  let mockClaudeProvider: ClaudeProvider;
  let mockGitWorktrees: GitWorktreeService;
  let mockThreadDeletion: ThreadDeletionTeardownService;
  let mockCleanupPolicy: SandboxWorktreeCleanupPolicy;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let workspaceService: WorkspaceService;
  let projectWorktreeService: ProjectWorktreeService;

  beforeEach(() => {
    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    const mcodeDir = NodePath.dirname(db.filename);
    cleanupJobRepo = new CleanupJobRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);

    mockClaudeProvider = {
      waitForSessionExit: vi.fn().mockResolvedValue(undefined),
    } as unknown as ClaudeProvider;

    mockGitWorktrees = {
      createWorktree: vi.fn().mockReturnValue({ path: NodePath.join(WT_BASE, "test-wt") }),
      removeWorktree: vi.fn().mockResolvedValue(true),
      isRegisteredWorktreePath: vi.fn().mockReturnValue(true),
    } as unknown as GitWorktreeService;

    mockCleanupPolicy = {
      decide: vi.fn(async ({ worktreePath }) => ({
        action: "remove" as const,
        worktreePath,
        branch: "mcode/int-branch",
      })),
      resolveSandboxPath: vi.fn(async (path: string) => path),
      isSameSandboxPath: vi.fn((left: string, right: string) => left === right),
    } as unknown as SandboxWorktreeCleanupPolicy;
    mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    mockHandoffStorage = {
      deleteThreadFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandoffStorage;
    mockThreadDeletion = {
      teardownThread: vi.fn().mockResolvedValue(undefined),
      bindAcceptedProgress: vi.fn(),
      deletePersistentData: async <Result>(_ids: readonly string[], remove: () => Promise<Result>): Promise<Result> => remove(),
      notifyThreadsHidden: vi.fn(),
    } as unknown as ThreadDeletionTeardownService;
    projectWorktreeService = new ProjectWorktreeService(
      threadRepo,
      workspaceRepo,
      persistenceRuntime.writer,
      mockGitWorktrees,
      mockCleanupPolicy,
    );
    threadService = new ThreadService(
      threadRepo,
      projectWorktreeService,
      mockAttachmentService,
      mockHandoffStorage,
      mockThreadDeletion,
    );

    worker = new CleanupWorker(
      cleanupJobRepo,
      threadRepo,
      mockClaudeProvider,
      mockGitWorktrees,
      mockCleanupPolicy,
      new RepositoryGitMutationLock(TEST_HOST_RUNTIME),
      workspaceRepo,
      { removeForThread: vi.fn() } as unknown as AttachmentService,
      { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage,
      mockThreadDeletion,
      { run: vi.fn().mockResolvedValue(undefined) },
      threadService,
      TEST_HOST_RUNTIME,
      undefined,
      0,
      new NoProjectWorkspaceSweep(workspaceRepo, mockAttachmentService, mcodeDir),
    );

    workspaceService = new WorkspaceService(
      workspaceRepo,
      threadRepo,
      persistenceRuntime.writer,
      mockAttachmentService,
      mockThreadDeletion,
      {} as unknown as GitExecutor,
      { killByThread: vi.fn().mockResolvedValue(undefined) },
      mcodeDir,
    );
  });

  afterEach(() => {
    worker.dispose();
  });

  function ageWorkspace(id: string): void {
    db.prepare("UPDATE workspaces SET created_at = ? WHERE id = ?").run("2026-08-12T09:00:00.000Z", id);
  }

  function expireThread(id: string): void {
    db.prepare("UPDATE threads SET user_completed_at = ?, scheduled_deletion_at = ? WHERE id = ?")
      .run("2026-08-12T09:00:00.000Z", "2026-08-12T09:01:00.000Z", id);
  }

  function threadServiceWithStartupTeardown(startups: ThreadStartupService): ThreadService {
    const deletion = new ThreadDeletionTeardownService(
      threadRepo,
      { beginThreadDeletion: () => () => {}, cancelSetupForThread: async () => {} },
      { beginThreadTeardown: async () => () => {}, stopForThread: async () => {} },
      { cancelForRepoPath: async () => {} },
      { teardownThread: async () => {} },
      { teardownThread: async () => {} },
      { unwatchThreadWorktree: () => {} },
      undefined,
      startups,
      workspaceRepo,
    );
    deletion.bindAcceptedProgress({ discardThreads: async () => {}, finishThreadDeletion: () => {} });
    return new ThreadService(
      threadRepo, projectWorktreeService, mockAttachmentService, mockHandoffStorage, deletion,
    );
  }

  it("purges an expired no-project thread and removes its populated workspace", async () => {
    const workspace = await workspaceService.createNoProject(crypto.randomUUID());
    await NodeFSPromises.writeFile(NodePath.join(workspace.path, "notes.txt"), "thread notes");
    ageWorkspace(workspace.id);
    const thread = await threadRepo.create(workspace.id, "Expired", "direct", "");
    expireThread(thread.id);

    await worker.poll();

    expect(threadRepo.listAllByWorkspace(workspace.id)).toEqual([]);
    expect(workspaceRepo.findByIdIncludeDeleted(workspace.id)).toBeNull();
    await expect(NodeFSPromises.stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a shared no-project folder until the last thread is purged", async () => {
    const workspace = await workspaceService.createNoProject(crypto.randomUUID());
    ageWorkspace(workspace.id);
    const first = await threadRepo.create(workspace.id, "First", "direct", "");
    const second = await threadRepo.create(workspace.id, "Second", "direct", "");
    const notes = NodePath.join(workspace.path, "notes.txt");
    await NodeFSPromises.writeFile(notes, "shared notes");

    expireThread(first.id);
    await worker.poll();
    expect(threadRepo.listAllByWorkspace(workspace.id).map((thread) => thread.id)).toEqual([second.id]);
    expect(await NodeFSPromises.readFile(notes, "utf8")).toBe("shared notes");

    expireThread(second.id);
    await worker.poll();
    expect(threadRepo.listAllByWorkspace(workspace.id)).toEqual([]);
    expect(workspaceRepo.findByIdIncludeDeleted(workspace.id)).toBeNull();
    await expect(NodeFSPromises.stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("unlinks an orphan junction without touching its target", async ({ skip }) => {
    const workspace = await workspaceService.createNoProject(crypto.randomUUID());
    ageWorkspace(workspace.id);
    const outside = NodePath.join(NodePath.dirname(db.filename), "outside");
    await NodeFSPromises.mkdir(outside);
    await NodeFSPromises.writeFile(NodePath.join(outside, "keep.txt"), "outside data");
    await NodeFSPromises.rmdir(workspace.path);
    try {
      await NodeFSPromises.symlink(outside, workspace.path, process.platform === "win32" ? "junction" : "dir");
    } catch {
      skip();
      return;
    }

    await worker.poll();

    expect(workspaceRepo.findByIdIncludeDeleted(workspace.id)).toBeNull();
    await expect(NodeFSPromises.lstat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await NodeFSPromises.readFile(NodePath.join(outside, "keep.txt"), "utf8")).toBe("outside data");
  });

  it("removes a leftover folder from an earlier sweep that deleted only the row", async () => {
    const workspace = await workspaceService.createNoProject(crypto.randomUUID());
    await NodeFSPromises.writeFile(NodePath.join(workspace.path, "notes.txt"), "old notes");
    await workspaceRepo.hardDelete(workspace.id);

    await worker.poll();

    await expect(NodeFSPromises.lstat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a directory whose ID belongs to a soft-deleted project", async () => {
    const workspace = await workspaceRepo.create("Project", NodePath.join(NodePath.dirname(db.filename), "project"));
    const directory = NodePath.join(NodePath.dirname(db.filename), "no-project", workspace.id);
    await NodeFSPromises.mkdir(directory, { recursive: true });
    await workspaceRepo.softDelete(workspace.id);
    const file = NodePath.join(directory, "keep.txt");
    await NodeFSPromises.writeFile(file, "project data");

    await worker.poll();

    expect(await NodeFSPromises.readFile(file, "utf8")).toBe("project data");
  });

  it.each(["client-app", "uuid", "nested"])("keeps a registered project under the managed root (%s)", async (location) => {
    const entry = NodePath.join(NodePath.dirname(db.filename), "no-project", location === "client-app" ? location : crypto.randomUUID());
    const directory = location === "nested" ? NodePath.join(entry, "project") : entry;
    await NodeFSPromises.mkdir(directory, { recursive: true });
    const workspace = await workspaceRepo.create("Project", directory);
    if (location === "nested") await workspaceRepo.softDelete(workspace.id);
    const file = NodePath.join(directory, "keep.txt");
    await NodeFSPromises.writeFile(file, "project data");

    const sweep = new NoProjectWorkspaceSweep(workspaceRepo, mockAttachmentService, NodePath.dirname(db.filename));
    await sweep.run();

    expect(await NodeFSPromises.readFile(file, "utf8")).toBe("project data");
  });

  it("keeps an empty no-project workspace during the first-thread grace period", async () => {
    const workspace = await workspaceService.createNoProject(crypto.randomUUID());

    await worker.poll();
    expect(workspaceRepo.findById(workspace.id)?.path).toBe(workspace.path);
    expect(await NodeFSPromises.readdir(workspace.path)).toEqual([]);

    ageWorkspace(workspace.id);
    await worker.poll();
    expect(workspaceRepo.findByIdIncludeDeleted(workspace.id)).toBeNull();
    await expect(NodeFSPromises.stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("keeps a retryable pre-thread failure updated within seven days (seen: %s)", async (seen) => {
    const workspace = await workspaceService.createNoProject(crypto.randomUUID());
    ageWorkspace(workspace.id);
    const { reader, writer } = persistenceRuntime;
    const startups = new ThreadStartupService(new ThreadStartupRepo(reader, writer), writer);
    const startupId = crypto.randomUUID();
    await startups.start({ startupId, workspaceId: workspace.id, kind: "direct" });
    await startups.advance(startupId, "thread");
    const failed = await startups.fail(startupId, {
      code: "THREAD_CREATE_FAILED", message: "Thread creation failed", retryable: true,
    });
    if (seen) await startups.acknowledgeFailure(startupId, failed.revision);
    const now = Date.now();
    db.prepare("UPDATE thread_startups SET created_at = ?, updated_at = ? WHERE startup_id = ?").run(
      new Date(now - 8 * DAY_MS).toISOString(),
      new Date(now - 7 * DAY_MS + 60_000).toISOString(),
      startupId,
    );

    await worker.poll();

    expect(workspaceRepo.findById(workspace.id)?.id).toBe(workspace.id);
    expect(await NodeFSPromises.readdir(workspace.path)).toEqual([]);
  });

  it.each(["AGENT_FAILED", "thread_deleted"])("removes the workspace after deleting the thread for %s", async (code) => {
    const workspace = await workspaceService.createNoProject(crypto.randomUUID());
    ageWorkspace(workspace.id);
    const thread = await threadRepo.create(workspace.id, "Failed start", "direct", "");
    const { reader, writer } = persistenceRuntime;
    const startups = new ThreadStartupService(new ThreadStartupRepo(reader, writer), writer);
    const startupId = crypto.randomUUID();
    await startups.start({ startupId, workspaceId: workspace.id, kind: "direct" });
    await startups.advance(startupId, "thread");
    await startups.bindThread(startupId, thread.id);
    const failedAtAgent = code === "AGENT_FAILED";
    if (failedAtAgent) await startups.advance(startupId, "agent");
    await startups.fail(startupId, { code, message: "Startup failed", retryable: failedAtAgent });

    await worker.poll();
    expect(workspaceRepo.findById(workspace.id)?.id).toBe(workspace.id);
    expect((await NodeFSPromises.stat(workspace.path)).isDirectory()).toBe(true);

    await threadService.delete(thread.id, false);
    await worker.poll();

    expect(workspaceRepo.findByIdIncludeDeleted(workspace.id)).toBeNull();
    await expect(NodeFSPromises.stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps the workspace after deleting the thread made by a successful retry", async () => {
    const workspace = await workspaceService.createNoProject(crypto.randomUUID());
    ageWorkspace(workspace.id);
    const { reader, writer } = persistenceRuntime;
    const startups = new ThreadStartupService(new ThreadStartupRepo(reader, writer), writer);
    const failedId = crypto.randomUUID();
    await startups.start({ startupId: failedId, workspaceId: workspace.id, kind: "direct" });
    await startups.advance(failedId, "thread");
    await startups.fail(failedId, {
      code: "THREAD_CREATE_FAILED", message: "Thread creation failed", retryable: true,
    });
    const interruptedId = crypto.randomUUID();
    await startups.start({ startupId: interruptedId, workspaceId: workspace.id, kind: "direct" });
    await startups.advance(interruptedId, "thread");
    await startups.interruptNonterminalOnStartup();

    const retryId = crypto.randomUUID();
    await startups.start({ startupId: retryId, workspaceId: workspace.id, kind: "direct" });
    await startups.advance(retryId, "thread");
    const thread = await threadRepo.create(workspace.id, "Successful retry", "direct", "");
    await startups.bindThread(retryId, thread.id);
    await startups.advance(retryId, "agent");
    await startups.complete(retryId);

    expect(await threadServiceWithStartupTeardown(startups).delete(thread.id, false)).toBe(true);
    await worker.poll();

    expect(workspaceRepo.findByIdIncludeDeleted(workspace.id)).toBeNull();
    await expect(NodeFSPromises.stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["failed", "interrupted"])("sweeps the workspace when a thread-less %s startup expires", async (state) => {
    const workspace = await workspaceService.createNoProject(crypto.randomUUID());
    ageWorkspace(workspace.id);
    const { reader, writer } = persistenceRuntime;
    const startups = new ThreadStartupService(new ThreadStartupRepo(reader, writer), writer);
    const startupId = crypto.randomUUID();
    await startups.start({ startupId, workspaceId: workspace.id, kind: "direct" });
    await startups.advance(startupId, "thread");
    if (state === "failed") {
      await startups.fail(startupId, {
        code: "THREAD_CREATE_FAILED", message: "Thread creation failed", retryable: true,
      });
    } else {
      await startups.interruptNonterminalOnStartup();
    }

    const expiredAt = new Date(Date.now() - 7 * DAY_MS - 60_000).toISOString();
    db.prepare("UPDATE thread_startups SET created_at = ?, updated_at = ? WHERE startup_id = ?")
      .run(expiredAt, expiredAt, startupId);

    await worker.poll();

    expect(workspaceRepo.findByIdIncludeDeleted(workspace.id)).toBeNull();
    await expect(NodeFSPromises.stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["failed", "interrupted"])("sweeps a deleted no-project thread's folder after a %s thread phase", async (state) => {
    const workspace = await workspaceService.createNoProject(crypto.randomUUID());
    ageWorkspace(workspace.id);
    await NodeFSPromises.writeFile(NodePath.join(workspace.path, "notes.txt"), "thread notes");
    const thread = await threadRepo.create(workspace.id, "Unfinished start", "direct", "");
    const { reader, writer } = persistenceRuntime;
    const startups = new ThreadStartupService(new ThreadStartupRepo(reader, writer), writer);
    const startupId = crypto.randomUUID();
    await startups.start({ startupId, workspaceId: workspace.id, kind: "direct" });
    await startups.advance(startupId, "thread");
    await startups.bindThread(startupId, thread.id);
    await startups.appendOutput(startupId, "Thread persisted");
    if (state === "failed") {
      await startups.fail(startupId, {
        code: "THREAD_CREATE_FAILED", message: "Thread creation failed", retryable: true,
      });
    } else {
      await startups.interruptNonterminalOnStartup();
    }
    const beforeDeletion = startups.get(startupId);

    const service = threadServiceWithStartupTeardown(startups);
    expect(await service.delete(thread.id, false)).toBe(true);
    const afterDeletion = startups.get(startupId);
    await worker.poll();

    expect(workspaceRepo.findByIdIncludeDeleted(workspace.id)).toBeNull();
    await expect(NodeFSPromises.stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(afterDeletion).toMatchObject({
      state,
      phase: "thread",
      steps: beforeDeletion?.steps,
      transcript: beforeDeletion?.transcript,
      ...(state === "failed" ? { error: { code: "thread_deleted", retryable: false } } : { cancellation: "requested" }),
    });
  });

  it("full flow: delete thread -> enqueue job -> worker processes -> thread hard-deleted", async () => {
    // Setup: create workspace and a managed worktree thread
    const ws = (await workspaceRepo.create("integration-test", "/test-repo"));
    const now = new Date().toISOString();
    const wtPath = NodePath.join(WT_BASE, "feat-wt");
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'active', ?, 1, ?, ?)`,
    ).run("thread-int-1", ws.id, "Integration Thread", "mcode/int-branch", wtPath, now, now);

    // Verify thread exists
    const threadBefore = threadRepo.findById("thread-int-1");
    expect(threadBefore).not.toBeNull();
    expect(threadBefore!.status).toBe("active");

    // Step 1: ThreadService.delete enqueues a cleanup job
    const deleted = await threadService.delete("thread-int-1", true);
    expect(deleted).toBe(true);

    // Thread is soft-deleted (findById still returns it for cleanup, but listByWorkspace filters it)
    const listed = threadService.list(ws.id);
    expect(listed.find(t => t.id === "thread-int-1")).toBeUndefined();

    // Cleanup job was created
    expect(cleanupJobRepo.count()).toBe(1);
    const jobs = cleanupJobRepo.findDue(Date.now());
    expect(jobs).toHaveLength(1);
    expect(jobs[0].thread_id).toBe("thread-int-1");
    expect(jobs[0].worktree_path).toBe(wtPath);
    expect(jobs[0].branch).toBe("mcode/int-branch");

    // Step 2: Worker processes the job
    await worker.poll();

    // Verify: subprocess signalled, terminals killed, worktree removed
    expect(mockClaudeProvider.waitForSessionExit).toHaveBeenCalledWith(
      "mcode-thread-int-1",
      expect.any(Number),
    );
    expect(mockThreadDeletion.teardownThread).toHaveBeenCalledWith("thread-int-1");
    expect(mockGitWorktrees.removeWorktree).toHaveBeenCalledWith(
      expect.any(String),
      "feat-wt",
      expect.objectContaining({
        branchName: "mcode/int-branch",
        worktreePath: expect.stringContaining("feat-wt"),
      }),
    );

    // Verify: thread hard-deleted from database
    expect(threadRepo.findById("thread-int-1")).toBeNull();

    // Verify: cleanup job removed
    expect(cleanupJobRepo.count()).toBe(0);
  });

  it("delete queues cleanup without blocking on filesystem work", async () => {
    const ws = (await workspaceRepo.create("perf-test", "/test-repo-2"));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'active', ?, 1, ?, ?)`,
    ).run("thread-perf", ws.id, "Perf Thread", "mcode/perf", NodePath.join(WT_BASE, "perf-wt"), now, now);

    const result = await threadService.delete("thread-perf", true);

    expect(result).toBe(true);
    // Delete hands session and git work to the worker instead of awaiting it. A wall-clock bound
    // here only measured CI runner load.
    expect(mockClaudeProvider.waitForSessionExit).not.toHaveBeenCalled();
    expect(mockGitWorktrees.removeWorktree).not.toHaveBeenCalled();
  });

  it("retry flow: failed cleanup retries on next poll", async () => {
    const ws = (await workspaceRepo.create("retry-test", "/test-repo-3"));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'deleted', ?, 1, ?, ?)`,
    ).run("thread-retry", ws.id, "Retry Thread", "mcode/retry", NodePath.join(WT_BASE, "retry-wt"), now, now);

    (await cleanupJobRepo.insert({
      thread_id: "thread-retry",
      workspace_path: "/test-repo-3",
      worktree_path: NodePath.join(WT_BASE, "retry-wt"),
      branch: "mcode/retry",
    }));

    // First attempt: removeWorktree fails
    (mockGitWorktrees.removeWorktree as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    await worker.poll();

    // Job still exists with attempt count incremented
    const job = cleanupJobRepo.findDue(Date.now() + 60_000);
    expect(job).toHaveLength(1);
    expect(job[0].attempts).toBe(1);
    expect(job[0].last_error).toContain("still exists");

    // Thread is NOT hard-deleted (cleanup hasn't succeeded)
    expect(threadRepo.findById("thread-retry")).not.toBeNull();

    // Second attempt succeeds (next_retry_at is in the future, so fast-forward)
    (mockGitWorktrees.removeWorktree as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    db.prepare("UPDATE cleanup_jobs SET next_retry_at = 0").run();

    await worker.poll();

    // Now thread and job are gone
    expect(threadRepo.findById("thread-retry")).toBeNull();
    expect(cleanupJobRepo.count()).toBe(0);
  });

  it("retention cleanup of a coordinator deletes its finished delegated child instead of listing it", async () => {
    const ws = (await workspaceRepo.create("retention-test", "/test-repo-5"));
    const wtPath = NodePath.join(WT_BASE, "coordinator-wt");
    const coordinator = await threadRepo.create(ws.id, "Coordinator", "worktree", "mcode/coordinator");
    const child = await threadRepo.create(ws.id, "Council seat", "worktree", "mcode/coordinator", false, "codex", {
      delegation: { coordinatorThreadId: coordinator.id, creatorTurnId: "turn", creatorToolCallId: "call" },
    });
    await threadRepo.updateWorktreePath(coordinator.id, wtPath);
    await threadRepo.updateWorktreePath(child.id, wtPath);
    db.prepare("UPDATE threads SET user_completed_at = ?, scheduled_deletion_at = ? WHERE id = ?")
      .run("2026-08-12T09:00:00.000Z", "2026-08-12T09:01:00.000Z", coordinator.id);

    await worker.poll();

    expect(threadRepo.findById(coordinator.id)).toBeNull();
    expect(threadService.list(ws.id).map((thread) => thread.title)).not.toContain("Council seat");
    expect(threadRepo.findById(child.id)).toBeNull();
    expect(mockGitWorktrees.removeWorktree).toHaveBeenCalledWith(
      "/test-repo-5",
      "coordinator-wt",
      expect.objectContaining({ worktreePath: wtPath }),
    );
  });

  it("retention cleanup of a coordinator detaches its running delegated child as a visible thread", async () => {
    const ws = await workspaceRepo.create("retention-running-test", "/test-repo-running");
    const coordinator = await threadRepo.create(ws.id, "Coordinator", "direct", "main");
    const child = await threadRepo.create(ws.id, "Running council seat", "direct", "main", true, "codex", {
      delegation: { coordinatorThreadId: coordinator.id, creatorTurnId: "turn", creatorToolCallId: "call" },
    });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO canonical_agent_threads
      (id, workspace_id, root_thread_id, provider_id, activity_state, created_at, updated_at)
      VALUES (?, ?, ?, 'codex', 'Active', ?, ?)`).run(child.id, ws.id, child.id, now, now);
    db.prepare(`INSERT INTO canonical_agent_turns
      (id, thread_id, execution_id, status, trigger_json, permission_mode, created_at, updated_at)
      VALUES ('running-turn', ?, 'running-execution', 'Running', '{"kind":"user"}', 'supervised', ?, ?)`)
      .run(child.id, now, now);
    db.prepare("UPDATE threads SET user_completed_at = ?, scheduled_deletion_at = ? WHERE id = ?")
      .run("2026-08-12T09:00:00.000Z", "2026-08-12T09:01:00.000Z", coordinator.id);

    await worker.poll();

    expect(threadRepo.findById(coordinator.id)).toBeNull();
    expect(threadRepo.findById(child.id)).toMatchObject({
      delegation_coordinator_thread_id: null,
      status: "active",
    });
    expect(threadService.list(ws.id).map((thread) => thread.id)).toEqual([child.id]);
  });

  it("retention cleanup processes delegated children of another completed coordinator sharing the worktree", async () => {
    const ws = await workspaceRepo.create("linked-coordinators-test", "/test-repo-linked");
    const wtPath = NodePath.join(WT_BASE, "linked-coordinators-wt");
    const due = await threadRepo.create(ws.id, "Due coordinator", "worktree", "mcode/linked");
    const linked = await threadRepo.create(ws.id, "Linked coordinator", "worktree", "mcode/linked");
    const child = await threadRepo.create(ws.id, "Finished council seat", "direct", "main", true, "codex", {
      delegation: { coordinatorThreadId: linked.id, creatorTurnId: "turn", creatorToolCallId: "call" },
    });
    await threadRepo.updateWorktreePath(due.id, wtPath);
    await threadRepo.updateWorktreePath(linked.id, wtPath);
    db.prepare("UPDATE threads SET user_completed_at = ?, scheduled_deletion_at = ? WHERE id = ?")
      .run("2026-08-12T09:00:00.000Z", "2026-08-12T09:01:00.000Z", due.id);
    db.prepare("UPDATE threads SET user_completed_at = ?, scheduled_deletion_at = ? WHERE id = ?")
      .run("2026-08-12T09:00:00.000Z", "2099-08-12T09:01:00.000Z", linked.id);

    await worker.poll();

    expect(threadRepo.findById(due.id)).toBeNull();
    expect(threadRepo.findById(linked.id)).toBeNull();
    expect(threadService.list(ws.id).map((thread) => thread.id)).not.toContain(child.id);
    expect(threadRepo.findById(child.id)).toBeNull();
  });

  it("retention cleanup keeps a shared worktree for a running delegated child", async () => {
    const ws = await workspaceRepo.create("retention-shared-test", "/test-repo-shared");
    const wtPath = NodePath.join(WT_BASE, "running-shared-wt");
    const coordinator = await threadRepo.create(ws.id, "Coordinator", "worktree", "mcode/shared");
    const child = await threadRepo.create(ws.id, "Running council seat", "worktree", "mcode/shared", false, "codex", {
      delegation: { coordinatorThreadId: coordinator.id, creatorTurnId: "turn", creatorToolCallId: "call" },
    });
    await threadRepo.updateWorktreePath(coordinator.id, wtPath);
    await threadRepo.updateWorktreePath(child.id, wtPath);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO canonical_agent_threads
      (id, workspace_id, root_thread_id, provider_id, activity_state, created_at, updated_at)
      VALUES (?, ?, ?, 'codex', 'Active', ?, ?)`).run(child.id, ws.id, child.id, now, now);
    db.prepare(`INSERT INTO canonical_agent_turns
      (id, thread_id, execution_id, status, trigger_json, permission_mode, created_at, updated_at)
      VALUES ('running-turn', ?, 'running-execution', 'Running', '{"kind":"user"}', 'supervised', ?, ?)`)
      .run(child.id, now, now);
    db.prepare("UPDATE threads SET user_completed_at = ?, scheduled_deletion_at = ? WHERE id = ?")
      .run("2026-08-12T09:00:00.000Z", "2026-08-12T09:01:00.000Z", coordinator.id);

    await worker.poll();

    expect(threadRepo.findById(coordinator.id)).toBeNull();
    expect(threadService.list(ws.id)).toMatchObject([{ id: child.id, status: "active" }]);
    expect(threadRepo.findById(child.id)).toMatchObject({ delegation_coordinator_thread_id: null });
    expect(mockGitWorktrees.removeWorktree).not.toHaveBeenCalled();
  });

  it("duplicate delete is idempotent (INSERT OR IGNORE)", async () => {
    const ws = (await workspaceRepo.create("dup-test", "/test-repo-4"));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO threads
        (id, workspace_id, title, branch, mode, status, worktree_path, worktree_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'worktree', 'active', ?, 1, ?, ?)`,
    ).run("thread-dup", ws.id, "Dup Thread", "mcode/dup", NodePath.join(WT_BASE, "dup-wt"), now, now);

    // Delete twice - should not throw or create duplicate jobs
    await threadService.delete("thread-dup", true);
    // Second delete: thread is already soft-deleted, but if called again it's safe
    await threadService.delete("thread-dup", true);

    // Only one cleanup job exists (UNIQUE constraint + INSERT OR IGNORE)
    expect(cleanupJobRepo.count()).toBe(1);
  });

  it("start() preserves retry counters from the previous session", async () => {
    // Simulate a stale job from a previous app session
    const job = (await cleanupJobRepo.insert({
      thread_id: "thread-stale",
      workspace_path: "/old-repo",
      worktree_path: NodePath.join(WT_BASE, "stale-wt"),
      branch: null,
    }));
    (await cleanupJobRepo.recordFailure(job.id, "previous failure"));
    (await cleanupJobRepo.recordFailure(job.id, "another failure"));
    (await cleanupJobRepo.recordFailure(job.id, "yet another"));

    const before = cleanupJobRepo.findById(job.id)!;
    expect(before.attempts).toBe(3);
    expect(before.next_retry_at).toBeGreaterThan(0);

    // Simulate app restart: start() must preserve the persisted retry schedule.
    worker.start();

    const after = cleanupJobRepo.findById(job.id)!;
    expect(after.attempts).toBe(3);
    expect(after.next_retry_at).toBe(before.next_retry_at);
  });

  describe("Workspace deletion - full lifecycle", () => {
    it("completes two-phase delete: soft-delete → worker drains → hard-delete", async () => {
      const ws = (await workspaceRepo.create("Full Test", "/tmp/full"));
      const direct = (await threadRepo.create(ws.id, "Direct", "direct", "main"));
      const wt1 = (await threadRepo.create(ws.id, "WT1", "worktree", "feat/a"));
      const wt2 = (await threadRepo.create(ws.id, "WT2", "worktree", "feat/b"));
      db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
        .run("/tmp/full/.worktrees/a", wt1.id);
      db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
        .run("/tmp/full/.worktrees/b", wt2.id);

      // Phase 1: workspace service delete
      await workspaceService.delete(ws.id);

      // Direct thread is hard-deleted immediately
      expect(threadRepo.findById(direct.id)).toBeNull();
      // Worktree threads are soft-deleted with pending jobs
      expect(cleanupJobRepo.countByWorkspacePath("/tmp/full")).toBe(2);
      // Workspace is soft-deleted (not visible in listAll)
      expect(workspaceRepo.listAll().find((w) => w.id === ws.id)).toBeUndefined();

      // Phase 2: worker processes first job
      await worker.processOneJob();

      // One job remaining, workspace still in DB
      expect(cleanupJobRepo.countByWorkspacePath("/tmp/full")).toBe(1);
      expect(db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id)).toBeDefined();

      // Phase 2 continued: worker processes second job
      await worker.processOneJob();

      // Zero jobs remaining, workspace hard-deleted
      expect(cleanupJobRepo.countByWorkspacePath("/tmp/full")).toBe(0);
      expect(db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id)).toBeNull();
    });
  });
});
