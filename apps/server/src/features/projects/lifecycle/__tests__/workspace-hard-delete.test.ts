import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import { createThreadPersistenceTestRuntime } from "../../../thread-control/testing/thread-persistence-test-runtime.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { CleanupJobRepo } from "../../../thread-control/cleanup/persistence/cleanup-job-repo.js";
import {
  RepositoryGitMutationLock,
  type GitWorktreeService,
  type SandboxWorktreeCleanupPolicy,
  WorkspaceService,
} from "../../index.js";
import { AttachmentService } from "../../../attachments/storage/attachment-service.js";
import { CleanupWorker } from "../../../thread-control/cleanup/cleanup-worker.js";
import { HandoffStorage } from "../../../handoff/index.js";
import type { ThreadDeletionTeardownService } from "../../../thread-control/lifecycle/thread-deletion-teardown-service.js";
import type { ClaudeProvider } from "../../../providers/adapters/claude/claude-provider.js";
import { killDescendantsByName } from "../../../../runtime/process/containment/process-kill.js";
import type { GitExecutor } from "../../git/execution/index.js";

let persistenceRuntime: ReturnType<typeof createThreadPersistenceTestRuntime>;
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const mockGitExecutor = { exec: vi.fn() } as unknown as GitExecutor;
const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;
const cleanupFixtureRoots = vi.hoisted(() => [
  "/tmp/active", "/tmp/deleted", "/tmp/deleting", "/tmp/direct", "/tmp/empty",
  "/tmp/empty-del", "/tmp/fast", "/tmp/gone-ws", "/tmp/nonexistent", "/tmp/orphan",
  "/tmp/same", "/tmp/source", "/tmp/stuck", "/tmp/target", "/tmp/test-ws", "/tmp/ws", "/tmp/wt",
]);

function isCleanupFixturePath(path: NodeFS.PathLike): boolean {
  const value = String(path);
  return cleanupFixtureRoots.some((root) => value === root || value.startsWith(`${root}/`));
}

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: NodeFS.PathLike) => isCleanupFixturePath(path) || actual.existsSync(path)),
  };
});
vi.mock("../../../../runtime/process/containment/process-kill.js", () => ({
  killDescendantsByName: vi.fn().mockResolvedValue(undefined),
}));

function setCleanupPathExists(exists: boolean): void {
  vi.mocked(NodeFS.existsSync).mockImplementation((path) => (
    isCleanupFixturePath(path) ? exists : actualFs.existsSync(path)
  ));
}

function createCleanupGitWorktreeServiceMock(): GitWorktreeService {
  return {
    removeWorktree: vi.fn().mockResolvedValue(true),
    isRegisteredWorktreePath: vi.fn().mockReturnValue(true),
  } as unknown as GitWorktreeService;
}

function createSandboxWorktreeCleanupPolicyMock(): SandboxWorktreeCleanupPolicy {
  return {
    decide: vi.fn(async ({ worktreePath }) => ({
      action: "remove" as const,
      worktreePath,
      branch: null,
    })),
    resolveSandboxPath: vi.fn(async (path: string) => path),
    isSameSandboxPath: vi.fn((left: string, right: string) => left === right),
  } as unknown as SandboxWorktreeCleanupPolicy;
}

function createThreadDeletionTeardownServiceMock(): ThreadDeletionTeardownService {
  return {
    teardownThread: vi.fn().mockResolvedValue(undefined),
    bindAcceptedProgress: vi.fn(),
    deletePersistentData: async <Result>(_ids: readonly string[], remove: () => Promise<Result>): Promise<Result> => remove(),
  } as unknown as ThreadDeletionTeardownService;
}

describe("WorkspaceRepo - soft/hard delete", () => {
  let db: Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;

  beforeEach(() => {
    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
  });

  it("softDelete sets deleted_at and returns true", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/test-ws"));
    const result = (await workspaceRepo.softDelete(ws.id));
    expect(result).toBe(true);

    // Direct DB check - row still exists but has deleted_at set
    const row = db.prepare("SELECT deleted_at FROM workspaces WHERE id = ?").get(ws.id) as { deleted_at: string | null } | undefined;
    expect(row).toEqual({ deleted_at: expect.any(String) });
  });

  it("softDelete returns false for non-existent workspace", async () => {
    const result = (await workspaceRepo.softDelete("non-existent-id"));
    expect(result).toBe(false);
  });

  it("listAll excludes soft-deleted workspaces", async () => {
    const ws1 = (await workspaceRepo.create("Active", "/tmp/active"));
    const ws2 = (await workspaceRepo.create("Deleted", "/tmp/deleted"));
    (await workspaceRepo.softDelete(ws2.id));

    const list = workspaceRepo.listAll();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(ws1.id);
  });

  it("findById returns null for soft-deleted workspace", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/test-ws"));
    (await workspaceRepo.softDelete(ws.id));
    expect(workspaceRepo.findById(ws.id)).toBeNull();
  });

  it("findByPath returns null for soft-deleted workspace", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/test-ws"));
    (await workspaceRepo.softDelete(ws.id));
    expect(workspaceRepo.findByPath("/tmp/test-ws")).toBeNull();
  });

  it("findDeletingWorkspaces returns only soft-deleted workspaces", async () => {
    (await workspaceRepo.create("Active", "/tmp/active"));
    const ws2 = (await workspaceRepo.create("Deleting", "/tmp/deleting"));
    (await workspaceRepo.softDelete(ws2.id));

    const deleting = workspaceRepo.findDeleting();
    expect(deleting).toHaveLength(1);
    expect(deleting[0].id).toBe(ws2.id);
  });

  it("hardDelete permanently removes the workspace row", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/test-ws"));
    (await workspaceRepo.softDelete(ws.id));
    const result = (await workspaceRepo.hardDelete(ws.id));
    expect(result).toBe(true);

    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeNull();
  });

  it("hardDelete cascades to all threads (active and soft-deleted)", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/test-ws"));
    (await threadRepo.create(ws.id, "Thread 1", "direct", "main"));
    const t2 = (await threadRepo.create(ws.id, "Thread 2", "worktree", "feat/x"));
    (await threadRepo.softDelete(t2.id));

    (await workspaceRepo.hardDelete(ws.id));

    const threads = db.prepare("SELECT id FROM threads WHERE workspace_id = ?").all(ws.id);
    expect(threads).toHaveLength(0);
  });
});

describe("ThreadRepo - workspace deletion helpers", () => {
  let db: Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;

  beforeEach(() => {
    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
  });

  it("findWorktreeThreadsByWorkspace returns threads with worktree_path set", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/test-ws"));
    (await threadRepo.create(ws.id, "Direct", "direct", "main"));
    const t2 = (await threadRepo.create(ws.id, "Worktree", "worktree", "feat/x"));
    // Simulate worktree path being set after creation
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/test-ws/.worktrees/feat-x", t2.id);

    const results = threadRepo.findWorktreeThreadsByWorkspace(ws.id);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(t2.id);
    expect(results[0].worktree_path).toBe("/tmp/test-ws/.worktrees/feat-x");
  });

  it("findWorktreeThreadsByWorkspace includes soft-deleted threads", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/test-ws"));
    const t1 = (await threadRepo.create(ws.id, "WT Thread", "worktree", "feat/y"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/wt", t1.id);
    (await threadRepo.softDelete(t1.id));

    const results = threadRepo.findWorktreeThreadsByWorkspace(ws.id);
    expect(results).toHaveLength(1);
  });

  it("listAllByWorkspace returns both active and soft-deleted threads", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/test-ws"));
    (await threadRepo.create(ws.id, "Active", "direct", "main"));
    const t2 = (await threadRepo.create(ws.id, "Deleted", "direct", "main"));
    (await threadRepo.softDelete(t2.id));

    const all = threadRepo.listAllByWorkspace(ws.id);
    expect(all).toHaveLength(2);
  });
});

describe("CleanupJobRepo - workspace helpers", () => {
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;

  beforeEach(() => {
    persistenceRuntime = createThreadPersistenceTestRuntime();
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    cleanupJobRepo = new CleanupJobRepo(persistenceRuntime.reader, persistenceRuntime.writer);
  });

  it("insertBatch creates multiple cleanup jobs in one transaction", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    const t1 = (await threadRepo.create(ws.id, "T1", "worktree", "feat/a"));
    const t2 = (await threadRepo.create(ws.id, "T2", "worktree", "feat/b"));

    (await cleanupJobRepo.insertBatch([
      { thread_id: t1.id, workspace_path: "/tmp/ws", worktree_path: "/tmp/ws/.worktrees/a", branch: "feat/a" },
      { thread_id: t2.id, workspace_path: "/tmp/ws", worktree_path: "/tmp/ws/.worktrees/b", branch: "feat/b" },
    ]));

    const count = cleanupJobRepo.countByWorkspacePath("/tmp/ws");
    expect(count).toBe(2);
  });

  it("insertBatch skips threads that already have a cleanup job", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    const t1 = (await threadRepo.create(ws.id, "T1", "worktree", "feat/a"));

    // Insert one job directly
    (await cleanupJobRepo.insert({
      thread_id: t1.id, workspace_path: "/tmp/ws", worktree_path: "/tmp/ws/.worktrees/a", branch: "feat/a",
    }));

    // Batch should not fail on duplicate thread_id
    (await cleanupJobRepo.insertBatch([
      { thread_id: t1.id, workspace_path: "/tmp/ws", worktree_path: "/tmp/ws/.worktrees/a", branch: "feat/a" },
    ]));

    const count = cleanupJobRepo.countByWorkspacePath("/tmp/ws");
    expect(count).toBe(1);
  });

  it("countByWorkspacePath returns 0 when no jobs exist for the path", () => {
    const count = cleanupJobRepo.countByWorkspacePath("/tmp/nonexistent");
    expect(count).toBe(0);
  });
});

describe("WorkspaceService.delete - two-phase orchestration", () => {
  let db: Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let workspaceService: WorkspaceService;
  let mockAttachmentService: AttachmentService;

  beforeEach(() => {
    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    cleanupJobRepo = new CleanupJobRepo(persistenceRuntime.reader, persistenceRuntime.writer);

    mockAttachmentService = {
      removeForThread: vi.fn(),
    } as unknown as AttachmentService;

    workspaceService = new WorkspaceService(
      workspaceRepo,
      threadRepo,
      persistenceRuntime.writer,
      mockAttachmentService,
      createThreadDeletionTeardownServiceMock(),
      mockGitExecutor,
    );
  });

  it("immediately hides workspace from listing", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    await workspaceService.delete(ws.id);
    expect(workspaceRepo.listAll()).toHaveLength(0);
  });

  it("soft-deletes all active threads", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    (await threadRepo.create(ws.id, "T1", "direct", "main"));
    (await threadRepo.create(ws.id, "T2", "direct", "main"));

    await workspaceService.delete(ws.id);

    const threads = threadRepo.listAllByWorkspace(ws.id);
    expect(threads.every((t) => t.deleted_at !== null)).toBe(true);
  });

  it("enqueues cleanup jobs for threads with worktrees", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    const t1 = (await threadRepo.create(ws.id, "WT", "worktree", "feat/x"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/feat-x", t1.id);

    await workspaceService.delete(ws.id);

    expect(cleanupJobRepo.countByWorkspacePath("/tmp/ws")).toBe(1);
  });

  it("hard-deletes workspace immediately when no worktree threads exist", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    (await threadRepo.create(ws.id, "Direct", "direct", "main"));

    await workspaceService.delete(ws.id);

    // Workspace should be fully gone
    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeNull();
  });

  it("keeps workspace in soft-deleted state when worktree cleanup is pending", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    const t1 = (await threadRepo.create(ws.id, "WT", "worktree", "feat/x"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/feat-x", t1.id);

    await workspaceService.delete(ws.id);

    // Workspace row still exists (soft-deleted, waiting for cleanup)
    const row = db.prepare("SELECT deleted_at FROM workspaces WHERE id = ?").get(ws.id) as { deleted_at: string | null } | undefined;
    expect(row).toEqual({ deleted_at: expect.any(String) });
  });

  it("removes attachments for non-worktree threads before hard-deleting them", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    const t1 = (await threadRepo.create(ws.id, "Direct", "direct", "main"));

    await workspaceService.delete(ws.id);

    expect(mockAttachmentService.removeForThread).toHaveBeenCalledWith(t1.id);
  });

  it("handles workspace with no threads (immediate hard-delete)", async () => {
    const ws = (await workspaceRepo.create("Empty", "/tmp/empty"));
    await workspaceService.delete(ws.id);

    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeNull();
  });

  it("does not enqueue duplicate cleanup jobs for already-soft-deleted threads with pending jobs", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    const t1 = (await threadRepo.create(ws.id, "WT", "worktree", "feat/x"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/feat-x", t1.id);

    // Pre-existing cleanup job (thread was individually deleted before workspace delete)
    (await threadRepo.softDelete(t1.id));
    (await cleanupJobRepo.insert({
      thread_id: t1.id, workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/feat-x", branch: "feat/x",
    }));

    await workspaceService.delete(ws.id);

    // Should still be 1 job, not 2
    expect(cleanupJobRepo.countByWorkspacePath("/tmp/ws")).toBe(1);
  });

  it("returns false for non-existent workspace", async () => {
    const result = await workspaceService.delete("fake-id");
    expect(result).toBe(false);
  });
});

describe("CleanupWorker - attachment cleanup and workspace finalization", () => {
  let db: Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let mockClaudeProvider: ClaudeProvider;
  let mockGitWorktrees: GitWorktreeService;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let worker: CleanupWorker;

  beforeEach(() => {
    setCleanupPathExists(true);
    vi.mocked(killDescendantsByName).mockClear();

    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    cleanupJobRepo = new CleanupJobRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);

    mockClaudeProvider = {
      waitForSessionExit: vi.fn().mockResolvedValue(undefined),
    } as unknown as ClaudeProvider;

    mockGitWorktrees = createCleanupGitWorktreeServiceMock();

    mockAttachmentService = {
      removeForThread: vi.fn(),
    } as unknown as AttachmentService;

    mockHandoffStorage = {
      deleteThreadFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandoffStorage;

    worker = new CleanupWorker(
      cleanupJobRepo,
      threadRepo,
      mockClaudeProvider,
      mockGitWorktrees,
      createSandboxWorktreeCleanupPolicyMock(),
      new RepositoryGitMutationLock(TEST_HOST_RUNTIME),
      workspaceRepo,
      mockAttachmentService,
      mockHandoffStorage,
      createThreadDeletionTeardownServiceMock(),
      TEST_HOST_RUNTIME,
    );
  });

  afterEach(() => {
    worker.dispose();
  });

  it("calls removeForThread during job execution", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    const t1 = (await threadRepo.create(ws.id, "WT", "worktree", "feat/x"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/feat-x", t1.id);
    (await threadRepo.softDelete(t1.id));

    (await cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/feat-x",
      branch: "feat/x",
    }));

    await worker.processOneJob();

    expect(mockAttachmentService.removeForThread).toHaveBeenCalledWith(t1.id);
  });

  it("hard-deletes workspace after last cleanup job completes", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    (await workspaceRepo.softDelete(ws.id));

    const t1 = (await threadRepo.create(ws.id, "WT", "worktree", "feat/x"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/feat-x", t1.id);
    (await threadRepo.softDelete(t1.id));

    (await cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/feat-x",
      branch: "feat/x",
    }));

    await worker.processOneJob();

    // Workspace should now be fully gone
    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeNull();
  });

  it("does NOT hard-delete workspace if other cleanup jobs remain", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    (await workspaceRepo.softDelete(ws.id));

    const t1 = (await threadRepo.create(ws.id, "T1", "worktree", "feat/a"));
    const t2 = (await threadRepo.create(ws.id, "T2", "worktree", "feat/b"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/a", t1.id);
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/b", t2.id);
    (await threadRepo.softDelete(t1.id));
    (await threadRepo.softDelete(t2.id));

    (await cleanupJobRepo.insert({ thread_id: t1.id, workspace_path: "/tmp/ws", worktree_path: "/tmp/ws/.worktrees/a", branch: "feat/a" }));
    (await cleanupJobRepo.insert({ thread_id: t2.id, workspace_path: "/tmp/ws", worktree_path: "/tmp/ws/.worktrees/b", branch: "feat/b" }));

    // Process only one job
    await worker.processOneJob();

    // Workspace should still exist (one job remaining)
    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeDefined();
  });
});

describe("CleanupWorker - startup reconciliation", () => {
  let db: Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let mockClaudeProvider: ClaudeProvider;
  let mockGitWorktrees: GitWorktreeService;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let worker: CleanupWorker;

  beforeEach(() => {
    setCleanupPathExists(true);

    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    cleanupJobRepo = new CleanupJobRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);

    mockClaudeProvider = {
      waitForSessionExit: vi.fn().mockResolvedValue(undefined),
    } as unknown as ClaudeProvider;

    mockGitWorktrees = createCleanupGitWorktreeServiceMock();

    mockAttachmentService = {
      removeForThread: vi.fn(),
    } as unknown as AttachmentService;

    mockHandoffStorage = {
      deleteThreadFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandoffStorage;

    worker = new CleanupWorker(
      cleanupJobRepo,
      threadRepo,
      mockClaudeProvider,
      mockGitWorktrees,
      createSandboxWorktreeCleanupPolicyMock(),
      new RepositoryGitMutationLock(TEST_HOST_RUNTIME),
      workspaceRepo,
      mockAttachmentService,
      mockHandoffStorage,
      createThreadDeletionTeardownServiceMock(),
      TEST_HOST_RUNTIME,
    );
  });

  afterEach(() => {
    worker.dispose();
  });

  it("enqueues missing cleanup jobs for soft-deleted workspaces on startup", async () => {
    const ws = (await workspaceRepo.create("Orphan", "/tmp/orphan"));
    const t1 = (await threadRepo.create(ws.id, "WT", "worktree", "feat/x"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/orphan/.worktrees/x", t1.id);
    (await threadRepo.softDelete(t1.id));
    (await workspaceRepo.softDelete(ws.id));

    // No cleanup job exists (simulating crash after soft-delete)
    expect(cleanupJobRepo.countByWorkspacePath("/tmp/orphan")).toBe(0);

    (await worker.reconcileOnStartup());

    expect(cleanupJobRepo.countByWorkspacePath("/tmp/orphan")).toBe(1);
  });

  it("hard-deletes soft-deleted workspace with no remaining threads or jobs", async () => {
    const ws = (await workspaceRepo.create("Empty Deleted", "/tmp/empty-del"));
    (await workspaceRepo.softDelete(ws.id));
    // No threads at all

    (await worker.reconcileOnStartup());

    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id);
    expect(row).toBeNull();
  });

  it("does not touch active workspaces during reconciliation", async () => {
    const ws = (await workspaceRepo.create("Active", "/tmp/active"));
    (await threadRepo.create(ws.id, "Thread", "direct", "main"));

    (await worker.reconcileOnStartup());

    expect(workspaceRepo.findById(ws.id)).not.toBeNull();
  });
});

describe("CleanupWorker - shared branch protection", () => {
  let db: Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let mockClaudeProvider: ClaudeProvider;
  let mockGitWorktrees: GitWorktreeService;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let mockCleanupPolicy: ReturnType<typeof createSandboxWorktreeCleanupPolicyMock>;
  let worker: CleanupWorker;

  beforeEach(() => {
    setCleanupPathExists(true);
    vi.mocked(killDescendantsByName).mockClear();

    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    cleanupJobRepo = new CleanupJobRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);

    mockClaudeProvider = { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider;
    mockGitWorktrees = createCleanupGitWorktreeServiceMock();
    mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    mockHandoffStorage = { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage;
    mockCleanupPolicy = createSandboxWorktreeCleanupPolicyMock();

    worker = new CleanupWorker(
      cleanupJobRepo, threadRepo, mockClaudeProvider, mockGitWorktrees, mockCleanupPolicy, new RepositoryGitMutationLock(TEST_HOST_RUNTIME), workspaceRepo, mockAttachmentService, mockHandoffStorage, createThreadDeletionTeardownServiceMock(), TEST_HOST_RUNTIME);
  });

  afterEach(() => { worker.dispose(); });

  it("requests forced branch deletion even when another thread uses the branch", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    const t1 = (await threadRepo.create(ws.id, "T1", "worktree", "feat/shared"));
    const t2 = (await threadRepo.create(ws.id, "T2", "worktree", "feat/shared"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run("/tmp/ws/.worktrees/t1", t1.id);
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run("/tmp/ws/.worktrees/t2", t2.id);
    (await threadRepo.softDelete(t1.id));

    (await cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/t1",
      branch: "feat/shared",
    }));
    vi.mocked(mockCleanupPolicy.decide).mockResolvedValue({
      action: "remove",
      worktreePath: "/tmp/ws/.worktrees/t1",
      branch: "feat/shared",
    });

    await worker.processOneJob();

    expect(mockGitWorktrees.removeWorktree).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ branchName: "feat/shared", forceDeleteBranch: true }),
    );
  });

  it("deletes the branch when no other active thread uses it", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    const t1 = (await threadRepo.create(ws.id, "T1", "worktree", "feat/solo"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run("/tmp/ws/.worktrees/t1", t1.id);
    (await threadRepo.softDelete(t1.id));

    (await cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/t1",
      branch: "feat/solo",
    }));
    vi.mocked(mockCleanupPolicy.decide).mockResolvedValue({
      action: "remove",
      worktreePath: "/tmp/ws/.worktrees/t1",
      branch: "feat/solo",
    });

    await worker.processOneJob();

    expect(mockGitWorktrees.removeWorktree).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ branchName: "feat/solo", forceDeleteBranch: true }),
    );
  });
});

describe("WorkspaceService.delete - runtime teardown", () => {
  let db: Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let workspaceService: WorkspaceService;
  let mockAttachmentService: AttachmentService;
  let mockThreadDeletion: ThreadDeletionTeardownService;

  beforeEach(() => {
    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);

    mockAttachmentService = {
      removeForThread: vi.fn(),
    } as unknown as AttachmentService;

    mockThreadDeletion = createThreadDeletionTeardownServiceMock();

    workspaceService = new WorkspaceService(
      workspaceRepo,
      threadRepo,
      persistenceRuntime.writer,
      mockAttachmentService,
      mockThreadDeletion,
      mockGitExecutor,
    );
  });

  it("tears down threads with and without a saved session identity", async () => {
    const ws = (await workspaceRepo.create("Active", "/tmp/active"));
    const t1 = (await threadRepo.create(ws.id, "Running", "direct", "main"));
    const t2 = (await threadRepo.create(ws.id, "Admission pending", "direct", "main"));
    db.prepare("UPDATE threads SET sdk_session_id = ? WHERE id = ?")
      .run("session-123", t1.id);

    await workspaceService.delete(ws.id);

    expect(mockThreadDeletion.teardownThread).toHaveBeenCalledWith(t1.id);
    expect(mockThreadDeletion.teardownThread).toHaveBeenCalledWith(t2.id);
    expect(mockThreadDeletion.teardownThread).toHaveBeenCalledTimes(2);
  });

  it("retains workspace data when runtime teardown fails", async () => {
    const ws = (await workspaceRepo.create("Active", "/tmp/active"));
    const t1 = (await threadRepo.create(ws.id, "Running", "direct", "main"));
    db.prepare("UPDATE threads SET sdk_session_id = ? WHERE id = ?")
      .run("session-123", t1.id);

    const failure = new Error("runtime teardown failed");
    vi.mocked(mockThreadDeletion.teardownThread).mockRejectedValue(failure);

    await expect(workspaceService.delete(ws.id)).rejects.toBe(failure);
    expect(workspaceRepo.listAll()).toHaveLength(0);
    expect(db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id)).toEqual({ id: ws.id });
    expect(db.prepare("SELECT id FROM threads WHERE id = ?").get(t1.id)).toEqual({ id: t1.id });
    expect(mockAttachmentService.removeForThread).not.toHaveBeenCalled();
  });
});

describe("Workspace delete - cross-workspace fork lineage", () => {
  let db: Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let workspaceService: WorkspaceService;
  let mockAttachmentService: AttachmentService;

  beforeEach(() => {
    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    workspaceService = new WorkspaceService(
      workspaceRepo,
      threadRepo,
      persistenceRuntime.writer,
      mockAttachmentService,
      createThreadDeletionTeardownServiceMock(),
      mockGitExecutor,
    );
  });

  it("nullifies forked_from_message_id on threads in other workspaces", async () => {
    const wsX = (await workspaceRepo.create("Source", "/tmp/source"));
    const wsY = (await workspaceRepo.create("Target", "/tmp/target"));

    const tA = (await threadRepo.create(wsX.id, "Parent", "direct", "main"));
    const tB = (await threadRepo.create(wsY.id, "Fork", "direct", "main", true, "claude", {
      parentThreadId: tA.id,
      forkedFromMessageId: "msg-123",
    }));

    await workspaceService.delete(wsX.id);

    const updatedTB = threadRepo.findById(tB.id);
    expect(updatedTB!.parent_thread_id).toBeNull();
    expect(updatedTB!.forked_from_message_id).toBeNull();
  });

  it("does not nullify lineage within the same workspace (handled by cascade)", async () => {
    const ws = (await workspaceRepo.create("Same", "/tmp/same"));
    const t1 = (await threadRepo.create(ws.id, "Parent", "direct", "main"));
    const t2 = (await threadRepo.create(ws.id, "Fork", "direct", "main", true, "claude", {
      parentThreadId: t1.id,
      forkedFromMessageId: "msg-456",
    }));

    await workspaceService.delete(ws.id);

    // Both threads should be gone (cascade from workspace hardDelete)
    const row = db.prepare("SELECT id FROM threads WHERE id = ?").get(t2.id);
    expect(row).toBeNull();
  });
});

describe("CleanupWorker - exhausted retries", () => {
  let db: Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let worker: CleanupWorker;

  beforeEach(() => {
    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    cleanupJobRepo = new CleanupJobRepo(persistenceRuntime.reader, persistenceRuntime.writer);

    worker = new CleanupWorker(
      cleanupJobRepo,
      threadRepo,
      { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider,
      { removeWorktree: vi.fn().mockResolvedValue(true), isRegisteredWorktreePath: vi.fn().mockReturnValue(true) } as unknown as GitWorktreeService,
      createSandboxWorktreeCleanupPolicyMock(),
      new RepositoryGitMutationLock(TEST_HOST_RUNTIME),
      workspaceRepo,
      { removeForThread: vi.fn() } as unknown as AttachmentService,
      { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage,
      createThreadDeletionTeardownServiceMock(),
      TEST_HOST_RUNTIME,
    );
  });

  afterEach(() => { worker.dispose(); });

  it("finds stuck workspaces when all jobs exhausted retries", async () => {
    const ws = (await workspaceRepo.create("Stuck", "/tmp/stuck"));
    (await workspaceRepo.softDelete(ws.id));

    const t1 = (await threadRepo.create(ws.id, "WT", "worktree", "feat/x"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/stuck/.worktrees/x", t1.id);
    (await threadRepo.softDelete(t1.id));

    (await cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/stuck",
      worktree_path: "/tmp/stuck/.worktrees/x",
      branch: "feat/x",
    }));
    // Set attempts to 5 (max)
    db.prepare("UPDATE cleanup_jobs SET attempts = 5 WHERE thread_id = ?").run(t1.id);

    const stuckWorkspaces = worker.findStuckWorkspaces();
    expect(stuckWorkspaces).toHaveLength(1);
    expect(stuckWorkspaces[0].workspaceId).toBe(ws.id);
  });
});

describe("CleanupWorker - missing directory handling", () => {
  let db: Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let mockClaudeProvider: ClaudeProvider;
  let mockGitWorktrees: GitWorktreeService;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let worker: CleanupWorker;

  beforeEach(() => {
    setCleanupPathExists(true);
    vi.mocked(killDescendantsByName).mockClear();

    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    cleanupJobRepo = new CleanupJobRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);

    mockClaudeProvider = { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider;
    mockGitWorktrees = createCleanupGitWorktreeServiceMock();
    mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    mockHandoffStorage = { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage;

    worker = new CleanupWorker(
      cleanupJobRepo, threadRepo, mockClaudeProvider, mockGitWorktrees, createSandboxWorktreeCleanupPolicyMock(), new RepositoryGitMutationLock(TEST_HOST_RUNTIME), workspaceRepo, mockAttachmentService, mockHandoffStorage, createThreadDeletionTeardownServiceMock(), TEST_HOST_RUNTIME);
  });

  afterEach(() => { worker.dispose(); });

  it("treats non-existent worktree directory as successful cleanup", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    const t1 = (await threadRepo.create(ws.id, "WT", "worktree", "feat/x"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/gone", t1.id);
    (await threadRepo.softDelete(t1.id));

    (await cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/gone",
      branch: "feat/x",
    }));

    // Both workspace and worktree paths missing
    setCleanupPathExists(false);

    await worker.processOneJob();

    // Thread should still be hard-deleted (cleanup succeeded)
    const thread = db.prepare("SELECT id FROM threads WHERE id = ?").get(t1.id);
    expect(thread).toBeNull();
    // Cleanup job should be removed
    expect(cleanupJobRepo.countByWorkspacePath("/tmp/ws")).toBe(0);
  });

  it("cleans a managed worktree when its workspace path is missing", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/gone-ws"));
    const t1 = (await threadRepo.create(ws.id, "WT", "worktree", "feat/x"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/gone-ws/.worktrees/x", t1.id);
    (await threadRepo.softDelete(t1.id));

    (await cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/gone-ws",
      worktree_path: "/tmp/gone-ws/.worktrees/x",
      branch: "feat/x",
    }));

    setCleanupPathExists(false);

    await worker.processOneJob();

    // Should complete without error, thread hard-deleted
    const thread = db.prepare("SELECT id FROM threads WHERE id = ?").get(t1.id);
    expect(thread).toBeNull();
    expect(mockGitWorktrees.removeWorktree).toHaveBeenCalledWith(
      "/tmp/gone-ws",
      "x",
      expect.objectContaining({ worktreePath: "/tmp/gone-ws/.worktrees/x" }),
    );
  });
});

describe("CleanupWorker - idempotent retry", () => {
  let db: Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let mockClaudeProvider: ClaudeProvider;
  let mockGitWorktrees: GitWorktreeService;
  let mockAttachmentService: AttachmentService;
  let mockHandoffStorage: HandoffStorage;
  let worker: CleanupWorker;

  beforeEach(() => {
    setCleanupPathExists(true);
    vi.mocked(killDescendantsByName).mockClear();

    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    cleanupJobRepo = new CleanupJobRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);

    mockClaudeProvider = { waitForSessionExit: vi.fn().mockResolvedValue(undefined) } as unknown as ClaudeProvider;
    mockGitWorktrees = createCleanupGitWorktreeServiceMock();
    mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    mockHandoffStorage = { deleteThreadFiles: vi.fn().mockResolvedValue(undefined) } as unknown as HandoffStorage;

    worker = new CleanupWorker(
      cleanupJobRepo, threadRepo, mockClaudeProvider, mockGitWorktrees, createSandboxWorktreeCleanupPolicyMock(), new RepositoryGitMutationLock(TEST_HOST_RUNTIME), workspaceRepo, mockAttachmentService, mockHandoffStorage, createThreadDeletionTeardownServiceMock(), TEST_HOST_RUNTIME);
  });

  afterEach(() => { worker.dispose(); });

  it("does not fail when retrying after attachment dir was already removed", async () => {
    const ws = (await workspaceRepo.create("Test", "/tmp/ws"));
    const t1 = (await threadRepo.create(ws.id, "WT", "worktree", "feat/x"));
    db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
      .run("/tmp/ws/.worktrees/x", t1.id);
    (await threadRepo.softDelete(t1.id));

    (await cleanupJobRepo.insert({
      thread_id: t1.id,
      workspace_path: "/tmp/ws",
      worktree_path: "/tmp/ws/.worktrees/x",
      branch: "feat/x",
    }));

    // First call: attachment removal succeeds, but removeWorktree returns false
    (mockGitWorktrees.removeWorktree as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    await worker.processOneJob();
    // Job should still exist (recorded failure - worktree still exists)
    expect(cleanupJobRepo.countByWorkspacePath("/tmp/ws")).toBe(1);

    // Reset retry backoff so the job is eligible immediately on the next poll
    db.prepare("UPDATE cleanup_jobs SET next_retry_at = 0").run();

    // Second call: removeWorktree succeeds this time
    (mockGitWorktrees.removeWorktree as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    await worker.processOneJob();
    // Should succeed this time
    expect(cleanupJobRepo.countByWorkspacePath("/tmp/ws")).toBe(0);
  });
});

describe("Workspace delete - zero-worktree fast path", () => {
  let db: Database;
  let workspaceRepo: WorkspaceRepo;
  let threadRepo: ThreadRepo;
  let cleanupJobRepo: CleanupJobRepo;
  let workspaceService: WorkspaceService;
  let mockAttachmentService: AttachmentService;

  beforeEach(() => {
    db = (persistenceRuntime = createThreadPersistenceTestRuntime()).database;
    workspaceRepo = new WorkspaceRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    threadRepo = new ThreadRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    cleanupJobRepo = new CleanupJobRepo(persistenceRuntime.reader, persistenceRuntime.writer);
    mockAttachmentService = { removeForThread: vi.fn() } as unknown as AttachmentService;
    workspaceService = new WorkspaceService(
      workspaceRepo,
      threadRepo,
      persistenceRuntime.writer,
      mockAttachmentService,
      createThreadDeletionTeardownServiceMock(),
      mockGitExecutor,
    );
  });

  it("hard-deletes workspace with only direct-mode threads before deletion resolves", async () => {
    const ws = (await workspaceRepo.create("Direct Only", "/tmp/direct"));
    (await threadRepo.create(ws.id, "T1", "direct", "main"));
    (await threadRepo.create(ws.id, "T2", "direct", "develop"));
    const t3 = (await threadRepo.create(ws.id, "T3", "direct", "main"));
    (await threadRepo.softDelete(t3.id));

    await workspaceService.delete(ws.id);

    // Everything should be gone from DB
    expect(db.prepare("SELECT COUNT(*) AS c FROM workspaces WHERE id = ?").get(ws.id)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM threads WHERE workspace_id = ?").get(ws.id)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM cleanup_jobs WHERE workspace_path = ?").get("/tmp/direct")).toEqual({ c: 0 });

    // Attachments removed for each thread
    expect(mockAttachmentService.removeForThread).toHaveBeenCalledTimes(3);
  });

  it("completes without a cleanup worker", async () => {
    const ws = (await workspaceRepo.create("Fast", "/tmp/fast"));
    (await threadRepo.create(ws.id, "T", "direct", "main"));

    const before = Date.now();
    await workspaceService.delete(ws.id);
    const elapsed = Date.now() - before;

    expect(elapsed).toBeLessThan(100);
    expect(cleanupJobRepo.countByWorkspacePath("/tmp/fast")).toBe(0);
  });
});
