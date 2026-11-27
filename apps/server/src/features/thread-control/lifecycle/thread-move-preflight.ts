import type { ThreadMovePreflight } from "@mcode/contracts/ws/methods";
import { folderHasFiles } from "../../projects/files/folder-has-files.js";
import type { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { noProjectRetentionDeadline } from "../../projects/persistence/workspace-store.js";
import type { ThreadRepo } from "../persistence/thread-repo.js";
import { isOpenNoProjectThread } from "../persistence/thread-store.js";

/**
 * Answers what the move dialog shows before the user commits. The answer is display only: the move
 * itself rechecks every fact under its reservation, so a stale read can mislead the dialog but not the move.
 */
export class ThreadMovePreflightService {
  constructor(
    private readonly threads: Pick<ThreadRepo, "findById" | "listAllByWorkspace">,
    private readonly workspaces: Pick<WorkspaceRepo, "findById">,
    private readonly now = () => new Date(),
  ) {}

  /** Read the old folder's state for an open No project thread, or null when the thread cannot move. */
  async read(threadId: string): Promise<ThreadMovePreflight | null> {
    const thread = this.threads.findById(threadId);
    const workspace = thread && this.workspaces.findById(thread.workspace_id);
    if (!isOpenNoProjectThread(thread, workspace ?? null) || !workspace) return null;
    const others = this.threads.listAllByWorkspace(workspace.id)
      .filter((candidate) => candidate.id !== threadId && candidate.deleted_at === null);
    return {
      hasFiles: await folderHasFiles(workspace.path),
      otherThreadsInFolder: { count: others.length, titles: others.map((candidate) => candidate.title) },
      deadline: noProjectRetentionDeadline(this.now().toISOString()),
    };
  }
}
