import "reflect-metadata";
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../testing/owned-test-database.js";
import { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { CleanupJobRepo } from "../../../thread-control/cleanup/persistence/cleanup-job-repo.js";
import { FakeGitExecutor } from "../../git/execution/index.js";
import type { GitWorktreeService } from "../../git/git-worktree-service.js";
import type { SandboxWorktreeCleanupPolicy } from "../../worktrees/sandbox-worktree-cleanup-policy.js";
import { ProjectWorktreeService } from "../../worktrees/project-worktree-service.js";
import { WorkspaceService } from "../workspace-service.js";
import { projectLifecycleWriteOperations } from "../project-lifecycle-write-operations.js";

const harnesses: Array<{ owned: OwnedTestDatabase; reader: Database }> = [];
afterEach(async () => {
  for (const { owned, reader } of harnesses.splice(0)) {
    await owned.writer.barrier();
    reader.close(true);
    await owned.close();
  }
});

async function harness() {
  const owned = createOwnedTestDatabase();
  const reader = openReadOnlyDatabase(owned.db.filename);
  harnesses.push({ owned, reader });
  const workspaces = new WorkspaceRepo(reader, owned.writer);
  const threads = new ThreadRepo(reader, owned.writer);
  const cleanup = new CleanupJobRepo(reader, owned.writer);
  const workspace = await workspaces.create("Fixture", "/fixture");
  const removeForThread = vi.fn();
  const teardownThread = vi.fn(async (_id: string) => undefined);
  const deletion = {
    teardownThread,
    deletePersistentData: async <Result>(_ids: readonly string[], remove: () => Promise<Result>) => remove(),
  };
  const service = new WorkspaceService(workspaces, threads, owned.writer, { removeForThread }, deletion, new FakeGitExecutor());
  const git: Pick<GitWorktreeService, "createWorktree" | "removeWorktree"> = {
    createWorktree: vi.fn(async () => ({ name: "test", path: "/fixture/.worktrees/test", branch: "feature/test", managed: true, createdBranch: true, warnings: [] })),
    removeWorktree: vi.fn(async () => true),
  };
  const policy: Pick<SandboxWorktreeCleanupPolicy, "decide"> = {
    decide: vi.fn<Pick<SandboxWorktreeCleanupPolicy, "decide">["decide"]>(async ({ worktreePath }) => ({ action: "remove", worktreePath, branch: "feature/test" })),
  };
  const worktreeService = new ProjectWorktreeService(threads, workspaces, owned.writer, git, policy);
  return { ...owned, reader, workspaces, threads, cleanup, workspace, service, removeForThread, teardownThread, git, policy, worktreeService };
}

describe("project lifecycle commands through the actual SQLite owner", () => {
  it("rolls back the workspace, threads, lineage, and cleanup admission together on save failure", async () => {
    const { db, writer, workspace, workspaces, threads, cleanup } = await harness();
    const thread = await threads.create(workspace.id, "Fixture thread", "worktree", "feature/test");
    await threads.updateWorktreePath(thread.id, "/fixture/.worktrees/test");
    const other = await workspaces.create("Other", "/other-fixture");
    const fork = await threads.create(other.id, "External fork", "direct", "main", false, "codex", { parentThreadId: thread.id, forkedFromMessageId: "fixture-message" });
    db.run("CREATE TRIGGER reject_project_cleanup BEFORE INSERT ON cleanup_jobs BEGIN SELECT RAISE(ABORT, 'forced cleanup failure'); END");
    await expect(writer.execute(projectLifecycleWriteOperations.beginWorkspaceDeletion, [workspace.id])).rejects.toThrow("forced cleanup failure");
    expect(workspaces.findById(workspace.id)).not.toBeNull();
    expect(threads.findById(thread.id)?.deleted_at).toBeNull();
    expect(threads.findById(fork.id)?.parent_thread_id).toBe(thread.id);
    expect(cleanup.countByWorkspacePath(workspace.path)).toBe(0);
  });

  it("commits cleanup before runtime teardown and removes direct attachments after durable deletion", async () => {
    const { workspace, threads, workspaces, cleanup, service, teardownThread, removeForThread } = await harness();
    const direct = await threads.create(workspace.id, "Direct", "direct", "main");
    const worktree = await threads.create(workspace.id, "Worktree", "worktree", "feature/test");
    await threads.updateWorktreePath(worktree.id, "/fixture/.worktrees/test");
    teardownThread.mockImplementation(async () => {
      expect(workspaces.findById(workspace.id)).toBeNull();
      expect(threads.findById(direct.id)?.deleted_at).toEqual(expect.any(String));
      expect(threads.findById(worktree.id)?.deleted_at).toEqual(expect.any(String));
      expect(cleanup.countByWorkspacePath(workspace.path)).toBe(1);
    });
    removeForThread.mockImplementation((threadId) => expect(threads.findById(threadId)).toBeNull());
    expect(await service.delete(workspace.id)).toBe(true);
    expect(teardownThread).toHaveBeenCalledTimes(2);
    expect(removeForThread).toHaveBeenCalledExactlyOnceWith(direct.id);
    expect(threads.findById(worktree.id)).not.toBeNull();
    expect(workspaces.findByIdIncludeDeleted(workspace.id)).not.toBeNull();
    expect(await service.delete(workspace.id)).toBe(false);
  });

  it("rolls back forced closure deletion and retains files when its final workspace deletion fails", async () => {
    const { db, service, workspace, threads, cleanup, workspaces, removeForThread } = await harness();
    const thread = await threads.create(workspace.id, "Worktree", "worktree", "feature/test");
    await cleanup.insert({ thread_id: thread.id, workspace_path: workspace.path, worktree_path: "/fixture/.worktrees/test", branch: "feature/test" });
    db.run("CREATE TRIGGER reject_workspace_remove BEFORE DELETE ON workspaces BEGIN SELECT RAISE(ABORT, 'forced workspace failure'); END");
    await expect(service.forceDelete(workspace.id)).rejects.toThrow("forced workspace failure");
    expect(cleanup.countByWorkspacePath(workspace.path)).toBe(1);
    expect(workspaces.findById(workspace.id)).not.toBeNull();
    expect(threads.findById(thread.id)).not.toBeNull();
    expect(removeForThread).not.toHaveBeenCalled();
    db.run("DROP TRIGGER reject_workspace_remove");
    expect(await service.forceDelete(workspace.id)).toBe(true);
    expect(workspaces.findById(workspace.id)).toBeNull();
    expect(cleanup.countByWorkspacePath(workspace.path)).toBe(0);
    expect(removeForThread).toHaveBeenCalledExactlyOnceWith(thread.id);
  });

  it("rolls back path and status together, then removes the uncommitted Git checkout", async () => {
    const { db, workspace, threads, worktreeService, git } = await harness();
    const thread = await threads.create(workspace.id, "Provisioning", "worktree", "feature/test");
    await threads.updateStatus(thread.id, "paused");
    db.run("CREATE TRIGGER reject_worktree_status BEFORE UPDATE OF status ON threads WHEN NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'forced status failure'); END");
    await expect(worktreeService.provisionThreadWorktree(thread, workspace.id, "feature/test")).rejects.toThrow("forced status failure");
    expect(threads.findById(thread.id)).toMatchObject({ status: "paused", worktree_path: null });
    expect(git.removeWorktree).toHaveBeenCalledTimes(1);
    db.run("DROP TRIGGER reject_worktree_status");
    const committed = await worktreeService.provisionThreadWorktree(thread, workspace.id, "feature/test");
    expect(committed).toEqual(threads.findById(thread.id));
    expect(committed).toMatchObject({ status: "active", worktree_path: "/fixture/.worktrees/test" });
    expect(git.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("admits worktree cleanup and soft deletion together with rollback on either failure", async () => {
    const { db, workspace, threads, cleanup, worktreeService } = await harness();
    const thread = await threads.create(workspace.id, "Cleanup", "worktree", "feature/test");
    await threads.updateWorktreePath(thread.id, "/fixture/.worktrees/test");
    db.run("CREATE TRIGGER reject_thread_cleanup BEFORE UPDATE OF deleted_at ON threads BEGIN SELECT RAISE(ABORT, 'forced soft deletion failure'); END");
    await expect(worktreeService.scheduleCleanup(thread.id)).rejects.toThrow("forced soft deletion failure");
    expect(cleanup.countByWorkspacePath(workspace.path)).toBe(0);
    expect(threads.findById(thread.id)?.deleted_at).toBeNull();
    db.run("DROP TRIGGER reject_thread_cleanup");
    expect(await worktreeService.scheduleCleanup(thread.id)).toBe(true);
    expect(cleanup.countByWorkspacePath(workspace.path)).toBe(1);
    expect(threads.findById(thread.id)?.deleted_at).toEqual(expect.any(String));
  });

  it("rejects cleanup if its inspected checkout changes while external policy evaluation is running", async () => {
    const { workspace, threads, cleanup, worktreeService, policy } = await harness();
    const thread = await threads.create(workspace.id, "Changed checkout", "worktree", "feature/test");
    await threads.updateWorktreePath(thread.id, "/fixture/.worktrees/test");
    let inspections = 0;
    vi.mocked(policy.decide).mockImplementation(async ({ worktreePath }) => {
      inspections += 1;
      if (inspections === 2) await threads.updateWorktreePath(thread.id, "/fixture/.worktrees/changed");
      return { action: "remove", worktreePath, branch: "feature/test" };
    });
    expect(await worktreeService.scheduleCleanup(thread.id)).toBe(false);
    expect(cleanup.countByWorkspacePath(workspace.path)).toBe(0);
    expect(threads.findById(thread.id)).toMatchObject({ deleted_at: null, worktree_path: "/fixture/.worktrees/changed" });
  });
});
