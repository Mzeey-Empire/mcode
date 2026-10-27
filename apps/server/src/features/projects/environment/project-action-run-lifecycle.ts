import { logger } from "@mcode/shared";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import type { ProjectActionRunRepo } from "./persistence/project-action-run-repo.js";
import type { ProjectActionRunPublisher } from "./project-action-run-publisher.js";
import type { ActiveProjectAction, ProjectActionSlotState } from "./project-action-types.js";

/** Persists Project Action finalization transitions for active slots. */
export class ProjectActionRunLifecycle {
  constructor(
    private readonly runs: Pick<ProjectActionRunRepo, "updateIfCurrent">,
    private readonly active: Map<string, ProjectActionSlotState>,
    private readonly publisher: Pick<ProjectActionRunPublisher, "publish">,
    private readonly timestamp: () => string,
  ) {}

  /** Maps a terminal exit into one retained final Action run. */
  async finish(slot: string, runId: string, exitCode: number | null): Promise<void> {
    const active = this.runningSlot(slot, runId);
    if (!active) return;
    const finalRun = finalRunFor(active, exitCode, this.timestamp());
    active.run = finalRun;
    active.pendingFinalization = finalRun;
    active.state = "pending-finalization";
    await this.retryPendingFinalization(slot, active);
  }

  /** Retries the one retained final run until the durable slot update succeeds. */
  async retryPendingFinalization(slot: string, active: ActiveProjectAction): Promise<void> {
    const finalRun = active.pendingFinalization;
    if (active.state !== "pending-finalization" || !finalRun) return;
    const persisted = await this.persistFinalization(active, finalRun);
    if (persisted === null || this.active.get(slot) !== active) return;
    this.active.delete(slot);
    if (persisted) this.publisher.publish(finalRun);
  }

  private runningSlot(slot: string, runId: string): ActiveProjectAction | null {
    const active = this.active.get(slot);
    if (!active || active.state !== "running" || active.run.runId !== runId) return null;
    return active;
  }

  private async persistFinalization(
    active: ActiveProjectAction,
    finalRun: WorkspaceEnvironmentActionRun,
  ): Promise<boolean | null> {
    try {
      return await this.runs.updateIfCurrent(finalRun);
    } catch (error) {
      logger.warn("Project Action finalization persistence failed; retaining the slot for retry", {
        threadId: active.threadId,
        actionId: active.actionId,
        runId: finalRun.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

function finalRunFor(
  active: ActiveProjectAction,
  exitCode: number | null,
  finishedAt: string,
): WorkspaceEnvironmentActionRun {
  const interrupted = active.stopping || exitCode === 130 || exitCode === 0xC000013A || exitCode === -1073741510;
  const status = interrupted ? "interrupted" : exitCode === 0 ? "completed" : "failed";
  return {
    ...active.run,
    revision: active.run.revision + 1,
    status,
    port: active.run.port ? { ...active.run.port, reachable: false } : null,
    finishedAt,
    exitCode: status === "interrupted" ? null : exitCode,
  };
}
