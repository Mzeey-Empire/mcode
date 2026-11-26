import type { ThreadMoveInput, ThreadMoveResult } from "@mcode/contracts/ws/methods";
import { broadcast } from "../../../application/transport/push.js";
import type { TurnRuntimeController } from "../../agents/orchestration/turn-runtime-controller.js";
import type { GitRepositoryService } from "../../projects/git/git-repository-service.js";
import type { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import type { ThreadControlMutationReservationService } from "../authority/thread-control-mutation-reservation-service.js";
import type { ThreadRepo } from "../persistence/thread-repo.js";
import { isOpenNoProjectThread } from "../persistence/thread-store.js";

/** Coordinates one Local move with the same reservation that guards turn admission. */
export class ThreadMoveService {
  constructor(
    private readonly threads: ThreadRepo,
    private readonly workspaces: WorkspaceRepo,
    private readonly reservations: ThreadControlMutationReservationService,
    private readonly git: Pick<GitRepositoryService, "getCurrentBranchAt">,
    private readonly runtime: Pick<TurnRuntimeController, "evictThreadProviderSessions">,
    private readonly now = () => new Date(),
  ) {}

  /** Move one open No project thread and publish its new placement after commit. */
  async moveToProject({ threadId, workspaceId }: ThreadMoveInput): Promise<ThreadMoveResult> {
    const token = this.reservations.reserve(threadId, "moving");
    if (!token) {
      const holder = this.reservations.get(threadId)?.state;
      return { status: "busy", reason: holder === "pendingApproval" ? "needs-approval" : "running" };
    }
    try {
      return await this.moveReservedThread(threadId, workspaceId);
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.reservations.release(threadId, token);
    }
  }

  private async moveReservedThread(threadId: string, workspaceId: string): Promise<ThreadMoveResult> {
    const thread = this.threads.findById(threadId);
    if (!isOpenNoProjectThread(thread, thread && this.workspaces.findById(thread.workspace_id))) {
      return { status: "not-no-project" };
    }
    const project = this.workspaces.findById(workspaceId);
    if (project?.kind !== "project") return { status: "destination-missing" };
    const branch = project.is_git_repo ? await this.git.getCurrentBranchAt(project.path) : "main";
    if (!branch) return { status: "failed", error: "The project root has no current branch" };
    await this.runtime.evictThreadProviderSessions(threadId);
    const result = await this.threads.moveToProject(threadId, project, branch, this.now().toISOString());
    if (result.status !== "moved") return result;
    broadcast("thread.movedToProject", { threadId, thread: result.thread, marker: result.marker });
    return { status: "moved", thread: result.thread };
  }
}
