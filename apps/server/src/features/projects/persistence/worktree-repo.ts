import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { WorktreeStore } from "./worktree-store.js";
import { worktreeWriteOperations } from "./worktree-write-operations.js";
export type { RegisteredWorktree, RegisteredWorktreeInput, InternalRegisteredWorktree } from "./worktree-store.js";
export { STALE_WORKTREE_RETENTION_DAYS } from "./worktree-store.js";

/** Read-only queries and committed mutations for WorktreeRepo. */
@injectable()
export class WorktreeRepo {
  private readonly reader: WorktreeStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new WorktreeStore(db);
  }

  reconcile(workspaceId: Parameters<WorktreeStore["reconcile"]>[0], worktrees: Parameters<WorktreeStore["reconcile"]>[1]): Promise<ReturnType<WorktreeStore["reconcile"]>> {
    return this.writer.execute(worktreeWriteOperations.reconcile, [workspaceId, worktrees]);
  }

  list(workspaceId: Parameters<WorktreeStore["list"]>[0]): ReturnType<WorktreeStore["list"]> {
    return this.reader.list(workspaceId);
  }

  findCurrentById(workspaceId: Parameters<WorktreeStore["findCurrentById"]>[0], worktreeId: Parameters<WorktreeStore["findCurrentById"]>[1]): ReturnType<WorktreeStore["findCurrentById"]> {
    return this.reader.findCurrentById(workspaceId, worktreeId);
  }

  register(workspaceId: Parameters<WorktreeStore["register"]>[0], worktree: Parameters<WorktreeStore["register"]>[1]): Promise<ReturnType<WorktreeStore["register"]>> {
    return this.writer.execute(worktreeWriteOperations.register, [workspaceId, worktree]);
  }
}
