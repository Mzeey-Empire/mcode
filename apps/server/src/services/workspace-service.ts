/**
 * Workspace CRUD service.
 * Orchestrates two-phase workspace deletion: soft-delete + async cleanup.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { injectable, inject } from "tsyringe";
import type { Workspace } from "@mcode/contracts";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { ThreadRepo } from "../repositories/thread-repo";
import { CleanupJobRepo } from "../repositories/cleanup-job-repo";
import { AttachmentService } from "./attachment-service";
import { AgentService } from "./agent-service.js";
import { logger } from "@mcode/shared";

/** Handles workspace creation, listing, and two-phase deletion. */
@injectable()
export class WorkspaceService {
  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(CleanupJobRepo) private readonly cleanupJobRepo: CleanupJobRepo,
    @inject(AttachmentService) private readonly attachmentService: AttachmentService,
    @inject(AgentService) private readonly agentService: AgentService,
  ) {}

  /**
   * Create a new workspace, or return the existing one if the path is already registered.
   * Detects whether the path is a git repository and stores the result.
   * Handles the case where the workspace still exists in the DB (e.g., after a failed
   * delete or stale client state) to prevent UNIQUE constraint errors on re-add.
   */
  create(name: string, path: string): Workspace {
    const existing = this.workspaceRepo.findByPath(path);
    if (existing) {
      this.workspaceRepo.touch(existing.id);
      this.workspaceRepo.prependToSortOrder(existing.id);
      return this.workspaceRepo.findById(existing.id)!;
    }
    const isGitRepo = this.detectGitRepo(path);
    return this.workspaceRepo.create(name, path, isGitRepo);
  }

  /**
   * Persist a new sidebar index for a workspace (zero-based). Other connected
   * clients receive `workspace.orderChanged` and should refresh the list.
   */
  reorder(id: string, newIndex: number): void {
    this.workspaceRepo.reorderToIndex(id, newIndex);
  }

  /** List all workspaces ordered by ascending sidebar `sort_order`. */
  list(): Workspace[] {
    return this.workspaceRepo.listAll();
  }

  /**
   * Two-phase workspace deletion.
   * Phase 1 (synchronous): soft-delete workspace + threads, enqueue cleanup jobs.
   * Phase 2 (async via CleanupWorker): drain jobs, then hard-delete workspace.
   *
   * Returns false if the workspace does not exist.
   */
  delete(id: string): boolean {
    // Attempt soft-delete. If workspace doesn't exist or is already deleted, bail.
    if (!this.workspaceRepo.softDelete(id)) {
      return false;
    }

    const workspacePath = this.getWorkspacePathForCleanup(id);

    // Nullify cross-workspace fork lineage before threads are deleted
    this.threadRepo.nullifyExternalLineage(id);

    // Gather all threads (active + already-soft-deleted) that have a worktree
    const worktreeThreads = this.threadRepo.findWorktreeThreadsByWorkspace(id);

    // Get all threads regardless of status
    const allThreads = this.threadRepo.listAllByWorkspace(id);

    // Signal all active agent sessions to stop (fire-and-forget)
    const activeThreads = allThreads.filter((t) => t.sdk_session_id);
    for (const thread of activeThreads) {
      this.agentService.stopSession(thread.id).catch(() => {
        logger.debug("Failed to stop session during workspace delete", { threadId: thread.id });
      });
    }

    // Separate threads by whether they need async worktree cleanup
    const worktreeThreadIds = new Set(worktreeThreads.map((t) => t.id));
    const directThreads = allThreads.filter((t) => !worktreeThreadIds.has(t.id));

    // Soft-delete all threads that aren't already deleted
    for (const thread of allThreads) {
      if (!thread.deleted_at) {
        this.threadRepo.softDelete(thread.id);
      }
    }

    // Enqueue cleanup jobs for worktree threads (batch, skips duplicates)
    if (worktreeThreads.length > 0 && workspacePath) {
      this.cleanupJobRepo.insertBatch(
        worktreeThreads.map((t) => ({
          thread_id: t.id,
          workspace_path: workspacePath,
          worktree_path: t.worktree_path!,
          branch: t.branch,
        })),
      );
    }

    // For direct threads (no worktree), clean up attachments and hard-delete now
    for (const thread of directThreads) {
      this.attachmentService.removeForThread(thread.id);
      this.threadRepo.hardDelete(thread.id);
    }

    // If no worktree cleanup is pending, hard-delete the workspace immediately
    const pendingJobs = workspacePath
      ? this.cleanupJobRepo.countByWorkspacePath(workspacePath)
      : 0;

    if (pendingJobs === 0) {
      this.workspaceRepo.hardDelete(id);
    }

    return true;
  }

  /**
   * Force-delete a workspace, abandoning any pending filesystem cleanup.
   * Removes all DB records immediately. Orphaned worktree directories may remain on disk.
   */
  forceDelete(id: string): boolean {
    const threads = this.threadRepo.listAllByWorkspace(id);
    for (const t of threads) {
      this.cleanupJobRepo.deleteByThreadId(t.id);
      this.attachmentService.removeForThread(t.id);
    }
    return this.workspaceRepo.hardDelete(id);
  }

  /** Find a workspace by its primary key. Returns null if not found. */
  findById(id: string): Workspace | null {
    return this.workspaceRepo.findById(id);
  }

  /** Bump updated_at for a workspace so it sorts to the top of the recent list. */
  touch(id: string): void {
    this.workspaceRepo.touch(id);
  }

  /** Update the is_git_repo flag on a workspace record. */
  setIsGitRepo(id: string, isGitRepo: boolean): void {
    this.workspaceRepo.setIsGitRepo(id, isGitRepo);
  }

  /** Retrieve workspace path even if soft-deleted (uses unfiltered repo lookup). */
  private getWorkspacePathForCleanup(id: string): string | null {
    const ws = this.workspaceRepo.findByIdIncludeDeleted(id);
    return ws?.path ?? null;
  }

  /** Check whether a filesystem path is inside a git repository. */
  private detectGitRepo(path: string): boolean {
    try {
      execFileSync("git", ["-C", path, "rev-parse", "--git-dir"], {
        stdio: "pipe",
        windowsHide: true,
      });
      return true;
    } catch {
      // Fall back to filesystem check when git is unavailable or fails to run
      // (e.g. git not in PATH in the server process on some platforms).
      if (existsSync(join(path, ".git"))) {
        return true;
      }
      logger.info("WorkspaceService: path is not a git repo", { path });
      return false;
    }
  }
}
