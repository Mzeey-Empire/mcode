/**
 * Workspace CRUD service.
 * Orchestrates two-phase workspace deletion: soft-delete + async cleanup.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { injectable, inject, delay } from "tsyringe";
import type { Workspace } from "@mcode/contracts";
import { WorkspaceRepo } from "../persistence/workspace-repo.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { ThreadDeletionTeardownService } from "../../thread-control/lifecycle/thread-deletion-teardown-service.js";
import { logger } from "@mcode/shared";
import type { GitExecutor } from "../git/execution/index.js";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { projectLifecycleWriteOperations } from "./project-lifecycle-write-operations.js";
import { TerminalBackend, TERMINAL_BACKEND_TOKEN } from "../../terminal/backends/terminal-backend.js";

/** Handles workspace creation, rename, listing, and two-phase deletion. */
@injectable()
export class WorkspaceService {
  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter,
    @inject(AttachmentService) private readonly attachmentService: Pick<AttachmentService, "removeForThread">,
    @inject(delay(() => ThreadDeletionTeardownService)) private readonly threadDeletion: Pick<ThreadDeletionTeardownService, "teardownThread" | "deletePersistentData">,
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject(TERMINAL_BACKEND_TOKEN) private readonly terminals: Pick<TerminalBackend, "killByThread">,
  ) {}

  /**
   * Create a new workspace, or return the existing one if the path is already registered.
   * Detects whether the path is a git repository and stores the result.
   * If a soft-deleted workspace occupies the path and cleanup has finished (no threads
   * remain), it is evicted automatically. If cleanup is still in progress, force-deletes
   * the stale workspace so the user can re-add immediately.
   */
  async create(name: string, path: string): Promise<Workspace> {
    const existing = this.workspaceRepo.findByPath(path);
    if (existing) {
      const current = await this.writer.execute(projectLifecycleWriteOperations.reuseWorkspace, [existing.id]);
      if (!current) throw new Error("Workspace was deleted while it was being reopened");
      return current;
    }

    // A soft-deleted workspace may still occupy this path. findByPath filters those
    // out, but the UNIQUE constraint will block the insert. The repo-level create
    // evicts only if no threads remain; if it can't, force-delete here.
    const stale = this.workspaceRepo.findDeletingByPath(path);
    if (stale) {
      await this.forceDelete(stale.id);
    }

    const isGitRepo = await this.detectGitRepo(path);
    return this.workspaceRepo.create(name, path, isGitRepo);
  }

  /**
   * Persist a new sidebar index for a workspace (zero-based). Other connected
   * clients receive `workspace.orderChanged` and should refresh the list.
   */
  async reorder(id: string, newIndex: number): Promise<void> {
    await this.workspaceRepo.reorderToIndex(id, newIndex);
  }

  /** List all workspaces ordered by ascending sidebar `sort_order`. */
  list(): Workspace[] {
    return this.workspaceRepo.listAll();
  }

  /** Rename an existing workspace without changing its filesystem path. */
  async rename(id: string, name: string): Promise<Workspace> {
    const workspace = await this.workspaceRepo.rename(id, name);
    if (!workspace) {
      throw new Error(`Workspace not found: ${id}`);
    }
    return workspace;
  }

  /**
   * Two-phase workspace deletion.
   * Phase 1: soft-delete workspace + threads, enqueue cleanup jobs, and stop their runtimes.
   * Phase 2 (async via CleanupWorker): drain jobs, then hard-delete workspace.
   *
   * Returns false if the workspace does not exist.
   */
  async delete(id: string): Promise<boolean> {
    const admitted = await this.writer.execute(projectLifecycleWriteOperations.beginWorkspaceDeletion, [id]);
    if (!admitted) return false;
    await this.terminals.killByThread(id);
    for (const threadId of admitted.threadIds) await this.threadDeletion.teardownThread(threadId);
    const deleted = await this.threadDeletion.deletePersistentData(admitted.threadIds,
      () => this.writer.execute(projectLifecycleWriteOperations.finishWorkspaceDeletion, [id]));
    for (const threadId of deleted) this.attachmentService.removeForThread(threadId);
    return true;
  }

  /**
   * Force-delete a workspace, abandoning any pending filesystem cleanup.
   * Stops owned runtimes and settles their active saves before removing DB records.
   * Orphaned worktree directories may remain on disk.
   */
  async forceDelete(id: string): Promise<boolean> {
    const threads = this.threadRepo.listAllByWorkspace(id);

    await this.terminals.killByThread(id);
    for (const thread of threads) await this.threadDeletion.teardownThread(thread.id);
    const committed = await this.threadDeletion.deletePersistentData(threads.map((thread) => thread.id),
      () => this.writer.execute(projectLifecycleWriteOperations.forceDeleteWorkspace, [id]));
    for (const threadId of committed.threadIds) this.attachmentService.removeForThread(threadId);
    return committed.deleted;
  }

  /** Find a workspace by its primary key. Returns null if not found. */
  findById(id: string): Workspace | null {
    return this.workspaceRepo.findById(id);
  }

  /** Bump updated_at for a workspace so it sorts to the top of the recent list. */
  async touch(id: string): Promise<void> {
    await this.workspaceRepo.touch(id);
  }

  /** Update the is_git_repo flag on a workspace record. */
  async setIsGitRepo(id: string, isGitRepo: boolean): Promise<void> {
    await this.workspaceRepo.setIsGitRepo(id, isGitRepo);
  }

  /** Check whether a filesystem path is inside a git repository. */
  private async detectGitRepo(path: string): Promise<boolean> {
    try {
      await this.gitExecutor.exec(["-C", path, "rev-parse", "--git-dir"]);
      return true;
    } catch {
      // Fall back to filesystem check when git is unavailable or fails to run
      // (e.g. git not in PATH in the server process on some platforms).
      if (NodeFS.existsSync(NodePath.join(path, ".git"))) {
        return true;
      }
      logger.info("WorkspaceService: path is not a git repo", { path });
      return false;
    }
  }
}
