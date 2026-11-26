import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import { WS_METHODS } from "@mcode/contracts/ws/methods";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { broadcast } from "../../../application/transport/push.js";
import { isWithinWorkspaceRoot, resolveNoProjectRoot } from "../../projects/lifecycle/workspace-path.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";

const FIRST_THREAD_GRACE_MS = 10 * 60 * 1000;
// Bound retention because the client may never report that the user gave up.
const STARTUP_RETRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Removes abandoned workspaces after thread cleanup has finished. */
@injectable()
export class NoProjectWorkspaceSweep {
  constructor(
    @inject(WorkspaceRepo) private readonly workspaces: WorkspaceRepo,
    @inject(AttachmentService) private readonly attachments: Pick<AttachmentService, "removeForThread">,
    @inject("McodeDir") private readonly mcodeDir: string,
  ) {}

  /** Claim each workspace before touching files that a newly created thread could use. */
  async run(): Promise<void> {
    const now = Date.now();
    const createdBefore = new Date(now - FIRST_THREAD_GRACE_MS).toISOString();
    const retryUpdatedSince = new Date(now - STARTUP_RETRY_RETENTION_MS).toISOString();
    for (const workspace of this.workspaces.findRemovableNoProject(createdBefore, retryUpdatedSince)) {
      if (!await this.workspaces.deleteRemovableNoProject(workspace.id, createdBefore, retryUpdatedSince)) continue;
      this.attachments.removeForThread(workspace.id);
      broadcast("workspace.deleted", { workspaceId: workspace.id });
    }
    await this.removeOrphanedEntries();
  }

  private async removeOrphanedEntries(): Promise<void> {
    const storedRoot = NodePath.join(this.mcodeDir, "no-project");
    try {
      const root = await resolveNoProjectRoot(storedRoot);
      const idSchema = WS_METHODS()["workspace.createNoProject"].params.shape.id;
      for (const id of await NodeFSPromises.readdir(root)) {
        if (idSchema.safeParse(id).success) await this.removeOrphanedEntry(root, storedRoot, id);
      }
    } catch (error) {
      if (!isMissing(error)) logger.warn("Could not read the No project root", { path: storedRoot, error });
    }
  }

  private async removeOrphanedEntry(root: string, storedRoot: string, id: string): Promise<void> {
    const path = NodePath.join(root, id);
    try {
      const entry = await NodeFSPromises.lstat(path);
      if (!entry.isSymbolicLink() && !entry.isDirectory()) return;
      // Creation inserts the row before making the folder, and cleanup deletes the row first.
      if (this.workspaces.findByIdIncludeDeleted(id)) return;
      if (await this.hasRegisteredPath(path, NodePath.join(storedRoot, id))) return;
      if (entry.isSymbolicLink()) {
        await NodeFSPromises.unlink(path);
      } else {
        await NodeFSPromises.rm(path, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isMissing(error)) logger.warn("Could not remove no-project workspace folder", { path, error });
    }
  }

  private async hasRegisteredPath(path: string, storedPath: string): Promise<boolean> {
    for (const registeredPath of this.workspaces.listPathsIncludeDeleted()) {
      if (isWithinWorkspaceRoot(path, registeredPath) || isWithinWorkspaceRoot(storedPath, registeredPath)) return true;
      // Older registrations can use a filesystem alias or Windows short path.
      try {
        if (isWithinWorkspaceRoot(path, await NodeFSPromises.realpath(registeredPath))) return true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
