import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { broadcast } from "../../../application/transport/push.js";
import { noProjectIdFromFolderName } from "../../projects/lifecycle/no-project-folder-name.js";
import type { WorkspaceMoveService } from "../../projects/lifecycle/workspace-move-service.js";
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
    // A class token is always constructible, so `isOptional` only takes effect on a string alias.
    @inject("WorkspaceMoveRetention", { isOptional: true })
    private readonly moves?: Pick<WorkspaceMoveService, "cleanExpiredSources" | "protectsFolder">,
  ) {}

  /** Claim each workspace before touching files that a newly created thread could use. */
  async run(): Promise<void> {
    const now = Date.now();
    const sweptAt = new Date(now).toISOString();
    const createdBefore = new Date(now - FIRST_THREAD_GRACE_MS).toISOString();
    const retryUpdatedSince = new Date(now - STARTUP_RETRY_RETENTION_MS).toISOString();
    await this.workspaces.retainMovedOutNoProject(sweptAt);
    for (const workspace of this.workspaces.findRemovableNoProject(createdBefore, retryUpdatedSince, sweptAt)) {
      if (!await this.workspaces.deleteRemovableNoProject(workspace.id, createdBefore, retryUpdatedSince, sweptAt)) continue;
      this.attachments.removeForThread(workspace.id);
      broadcast("workspace.deleted", { workspaceId: workspace.id });
    }
    await this.moves?.cleanExpiredSources(sweptAt);
    await this.removeOrphanedEntries();
  }

  private async removeOrphanedEntries(): Promise<void> {
    const storedRoot = NodePath.join(this.mcodeDir, "no-project");
    try {
      const root = await resolveNoProjectRoot(storedRoot);
      for (const name of await NodeFSPromises.readdir(root)) {
        const id = noProjectIdFromFolderName(name);
        if (id !== null) await this.removeOrphanedEntry(root, storedRoot, name, id);
      }
    } catch (error) {
      if (!isMissing(error)) logger.warn("Could not read the No project root", { path: storedRoot, error });
    }
  }

  private async removeOrphanedEntry(root: string, storedRoot: string, name: string, id: string): Promise<void> {
    const path = NodePath.join(root, name);
    try {
      const entry = await NodeFSPromises.lstat(path);
      if (!entry.isSymbolicLink() && !entry.isDirectory()) return;
      // Creation inserts the row before making the folder, and cleanup deletes the row first.
      if (this.workspaces.findByIdIncludeDeleted(id)) return;
      if (await this.hasRegisteredPath(path, NodePath.join(storedRoot, name))) return;
      if (entry.isSymbolicLink()) {
        await NodeFSPromises.unlink(path);
      } else {
        if ((await NodeFSPromises.readdir(path)).some((name) => name.startsWith(".mcode-move-"))) return;
        await NodeFSPromises.rm(path, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isMissing(error)) logger.warn("Could not remove no-project workspace folder", { path, error });
    }
  }

  private async hasRegisteredPath(path: string, storedPath: string): Promise<boolean> {
    if (this.moves?.protectsFolder(path)) return true;
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
