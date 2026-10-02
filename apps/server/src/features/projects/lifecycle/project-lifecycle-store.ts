import type { Database } from "bun:sqlite";
import type { Thread, Workspace } from "@mcode/contracts";
import { WorkspaceStore } from "../persistence/workspace-store.js";
import { ThreadStore } from "../../thread-control/persistence/thread-store.js";
import { CleanupJobStore } from "../../thread-control/cleanup/persistence/cleanup-job-store.js";

/** Applies project lifecycle decisions entirely on the database owner's connection. */
export class ProjectLifecycleStore {
  private readonly workspaces: WorkspaceStore;
  private readonly threads: ThreadStore;
  private readonly cleanup: CleanupJobStore;

  constructor(private readonly db: Database) {
    this.workspaces = new WorkspaceStore(db);
    this.threads = new ThreadStore(db);
    this.cleanup = new CleanupJobStore(db);
  }

  /** Bump both recent activity and sidebar ordering in one committed decision. */
  reuseWorkspace(workspaceId: string): Workspace | null {
    return this.db.transaction(() => {
      if (!this.workspaces.findById(workspaceId)) return null;
      this.workspaces.touch(workspaceId);
      this.workspaces.prependToSortOrder(workspaceId);
      return this.workspaces.findById(workspaceId);
    })();
  }

  /** Mark the workspace and every thread deleted together with required cleanup jobs. */
  beginWorkspaceDeletion(workspaceId: string): { threadIds: string[] } | null {
    return this.db.transaction(() => {
      if (!this.workspaces.softDelete(workspaceId)) return null;
      const workspace = this.workspaces.findByIdIncludeDeleted(workspaceId);
      if (!workspace) throw new Error("Deleted workspace disappeared during its transition");
      this.threads.nullifyExternalLineage(workspaceId);
      const allThreads = this.threads.listAllByWorkspace(workspaceId);
      for (const thread of allThreads) if (!thread.deleted_at) this.threads.softDelete(thread.id);
      const worktrees = this.threads.findWorktreeThreadsByWorkspace(workspaceId);
      this.cleanup.insertBatch(worktrees.map((thread) => ({
        thread_id: thread.id,
        workspace_path: workspace.path,
        worktree_path: thread.worktree_path,
        branch: thread.branch,
      })));
      return { threadIds: allThreads.map((thread) => thread.id) };
    })();
  }

  /** Remove direct threads and finish an empty cleanup ledger after producers have stopped. */
  finishWorkspaceDeletion(workspaceId: string): string[] {
    return this.db.transaction(() => {
      const workspace = this.workspaces.findByIdIncludeDeleted(workspaceId);
      if (!workspace) return [];
      if (!workspace.deleted_at) throw new Error("Workspace deletion was not admitted");
      const worktrees = new Set(this.threads.findWorktreeThreadsByWorkspace(workspaceId).map((thread) => thread.id));
      const directThreads = this.threads.listAllByWorkspace(workspaceId).filter((thread) => !worktrees.has(thread.id));
      for (const thread of directThreads) this.threads.hardDelete(thread.id);
      if (this.cleanup.countByWorkspacePath(workspace.path) === 0) this.workspaces.hardDelete(workspaceId);
      return directThreads.map((thread) => thread.id);
    })();
  }

  /** Abandon queued filesystem cleanup and remove the complete durable workspace closure. */
  forceDeleteWorkspace(workspaceId: string): { deleted: boolean; threadIds: string[] } {
    return this.db.transaction(() => {
      this.threads.nullifyExternalLineage(workspaceId);
      const threads = this.threads.listAllByWorkspace(workspaceId);
      for (const thread of threads) this.cleanup.deleteByThreadId(thread.id);
      return { deleted: this.workspaces.hardDelete(workspaceId), threadIds: threads.map((thread) => thread.id) };
    })();
  }

  /** Persist a newly provisioned path and active status without reviving a deleted thread. */
  persistProvisionedWorktree(threadId: string, workspaceId: string, worktreePath: string): Thread | null {
    return this.db.transaction(() => {
      const thread = this.threads.findById(threadId);
      if (!thread || thread.workspace_id !== workspaceId || thread.deleted_at !== null) return null;
      if (!this.threads.updateWorktreePath(threadId, worktreePath) || !this.threads.updateStatus(threadId, "active")) {
        throw new Error("Provisioned worktree could not persist its complete thread state");
      }
      return this.threads.findById(threadId);
    })();
  }

  /** Commit explicit cleanup admission and thread deletion against the inspected worktree. */
  scheduleWorktreeCleanup(threadId: string, workspaceId: string, workspacePath: string, worktreePath: string, branch: string | null): boolean {
    return this.db.transaction(() => {
      const thread = this.threads.findById(threadId);
      const workspace = this.workspaces.findById(workspaceId);
      if (!thread || !workspace || workspace.path !== workspacePath || thread.workspace_id !== workspaceId
        || thread.deleted_at !== null || thread.worktree_path !== worktreePath) return false;
      this.cleanup.insert({ thread_id: threadId, workspace_path: workspacePath, worktree_path: worktreePath, branch });
      if (!this.threads.softDelete(threadId)) throw new Error("Cleanup thread disappeared during admission");
      return true;
    })();
  }
}
