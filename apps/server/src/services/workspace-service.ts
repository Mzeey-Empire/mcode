/**
 * Workspace CRUD service.
 * Thin orchestration layer over WorkspaceRepo with git detection.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { injectable, inject } from "tsyringe";
import type { Workspace } from "@mcode/contracts";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { logger } from "@mcode/shared";

/** Handles workspace creation, listing, and deletion. */
@injectable()
export class WorkspaceService {
  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
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

  /** Delete a workspace by ID. Returns true if the workspace was removed. */
  delete(id: string): boolean {
    return this.workspaceRepo.remove(id);
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
