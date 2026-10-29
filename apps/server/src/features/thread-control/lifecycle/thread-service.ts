/**
 * Thread lifecycle service.
 * Manages thread creation, deletion, worktree provisioning, and status transitions.
 * Extracted from apps/desktop/src/main/app-state.ts.
 */

import { delay, injectable, inject } from "tsyringe";
import { validateBranchName, logger } from "@mcode/shared";
import type { Thread, RecentThread } from "@mcode/contracts/models/thread";
import type { ThreadMode } from "@mcode/contracts/models/enums";
import type { ContextWindowMode } from "@mcode/contracts/models/settings";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { ProjectWorktreeService } from "../../projects/index.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { HandoffStorage } from "../../handoff/index.js";
import { ThreadDeletionTeardownService } from "./thread-deletion-teardown-service.js";
import { DatabaseWriteOutcomeUnknown } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { TurnResumeScheduler } from "../../agents/recovery/turn-resume-scheduler.js";

/** Receives the durable thread record before managed checkout mutation begins. */
export interface ThreadCreateLifecycle {
  onThreadPersisted(thread: Thread): Promise<void>;
}

/** Handles thread creation, deletion, worktree provisioning, and lifecycle. */
@injectable()
export class ThreadService {
  private acceptedProgress: Pick<import("../../agents/canonical/canonical-accepted-progress.js").CanonicalAcceptedProgress,
    "discardThreads" | "finishThreadDeletion" | "assertThreadDeletionSupported"> | undefined;

  /** Compose the ownership check used before any thread deletion effects. */
  bindAcceptedProgress(progress: NonNullable<ThreadService["acceptedProgress"]>): void {
    this.acceptedProgress = progress;
  }
  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(ProjectWorktreeService) private readonly projectWorktreeService: ProjectWorktreeService,
    @inject(AttachmentService) private readonly attachmentService: AttachmentService,
    @inject(HandoffStorage) private readonly handoffStorage: HandoffStorage,
    // CI watcher registration follows ThreadService construction during bootstrap.
    @inject(delay(() => ThreadDeletionTeardownService))
    private readonly threadDeletionTeardownService: Pick<ThreadDeletionTeardownService, "teardownThread" | "deletePersistentData">,
    @inject(TurnResumeScheduler, { isOptional: true }) private readonly resumeScheduler?: Pick<TurnResumeScheduler, "unschedule">,
  ) {}

  /**
   * Create a thread with optional worktree provisioning.
   * If mode is "worktree", creates a git worktree on disk and persists its path.
   * Rolls back known provisioning failures. Unknown storage outcomes remain for reconciliation.
   */
  async create(
    workspaceId: string,
    title: string,
    mode: string,
    branch: string,
    options: { branchless?: boolean; startPoint?: string; provider?: ProviderId; lifecycle?: ThreadCreateLifecycle; lineage?: Parameters<ThreadRepo["create"]>[6] } = {},
  ): Promise<Thread & { warnings?: string[] }> {
    validateBranchName(branch);

    const threadMode: ThreadMode =
      mode === "worktree" || mode === "direct"
        ? mode
        : (() => {
            throw new Error(`Unknown thread mode: ${mode}`);
          })();

    const thread = await this.threadRepo.create(
      workspaceId,
      title,
      threadMode,
      branch,
      true,
      options.provider,
      options.lineage,
      options.branchless ? "branchless" : "named",
      options.branchless ? branch : null,
    );

    if (threadMode === "worktree") {
      try {
        await options.lifecycle?.onThreadPersisted(thread);
        return await this.projectWorktreeService.provisionThreadWorktree(
          thread,
          workspaceId,
          branch,
          options,
        );
      } catch (err) {
        if (err instanceof DatabaseWriteOutcomeUnknown) throw err;
        await this.threadRepo.hardDelete(thread.id);
        throw err;
      }
    }

    return thread;
  }

  /** List non-deleted threads for a workspace. */
  list(workspaceId: string): Thread[] {
    return this.threadRepo.listByWorkspace(workspaceId);
  }

  /** List the most recently updated threads across all workspaces (joined with workspace name + path). */
  listRecent(limit?: number): RecentThread[] {
    return this.threadRepo.listRecent(limit);
  }

  /** Search threads across all workspaces by display and checkout metadata. */
  search(opts: {
    query: string;
    filters?: { status?: string[]; provider?: string[] };
    sort?: { field: "updated_at" | "created_at" | "title"; direction: "asc" | "desc" };
    limit?: number;
  }) {
    return this.threadRepo.search(opts);
  }

  /**
   * Delete a thread. Eligible managed worktrees are queued for background cleanup;
   * other threads are torn down and deleted immediately while active descendants
   * remain available as detached threads.
   */
  async delete(threadId: string, cleanupWorktree: boolean): Promise<boolean> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.deleted_at !== null) return false;
    this.acceptedProgress?.assertThreadDeletionSupported(threadId);
    await this.deleteDelegatedChildren(thread, cleanupWorktree);

    if (cleanupWorktree && thread.worktree_path) {
      // Stop the scheduled resume before asynchronous cleanup safety checks can admit it.
      await this.resumeScheduler?.unschedule(threadId);
      if (await this.projectWorktreeService.scheduleCleanup(threadId)) {
        // Disarm any resume scheduled while cleanup safety checks were pending.
        await this.resumeScheduler?.unschedule(threadId);
        return true;
      }
      logger.info("Worktree checkout kept because removal safety could not be proven", {
        threadId,
        worktreePath: thread.worktree_path,
      });
    }

    await this.threadDeletionTeardownService.teardownThread(threadId);
    const deleted = await this.threadDeletionTeardownService.deletePersistentData([threadId], async () => {
      this.attachmentService.removeForThread(threadId);
      await this.handoffStorage.deleteThreadFiles(threadId);
      return this.threadRepo.hardDelete(threadId, { preserveActiveDescendants: true });
    });
    // Disarm any resume scheduled during teardown or persistent deletion.
    await this.resumeScheduler?.unschedule(threadId);
    return deleted;
  }

  private async deleteDelegatedChildren(coordinator: Thread, cleanupWorktree: boolean): Promise<void> {
    const children = this.threadRepo.listDelegatedChildren(coordinator.id);
    const detached = new Set(await this.threadRepo.detachActiveDelegatedChildren(coordinator.id));
    for (const child of children) {
      if (child.deleted_at !== null || detached.has(child.id)) continue;
      const ownsWorktree = child.mode === "worktree" && child.worktree_managed
        && child.worktree_path !== coordinator.worktree_path;
      await this.delete(child.id, cleanupWorktree && ownsWorktree);
    }
  }

  /** Update a thread's display title. */
  updateTitle(threadId: string, title: string): Promise<boolean> {
    return this.threadRepo.updateTitle(threadId, title);
  }

  /** Persist per-thread composer settings (reasoning, mode, permission, copilot agent, context window, thinking). */
  updateSettings(
    threadId: string,
    settings: {
      reasoning_level?: string;
      interaction_mode?: string;
      orchestration_mode?: string;
      permission_mode?: string;
      context_window_mode?: ContextWindowMode | null;
      thinking?: boolean | null;
      fast_mode?: boolean | null;
      default_open_in_app?: string | null;
      auto_complete_on_merge?: boolean | null;
    },
  ): Promise<boolean> {
    return this.threadRepo.updateSettings(threadId, {
      ...(settings.reasoning_level !== undefined && { reasoning_level: settings.reasoning_level }),
      ...(settings.interaction_mode !== undefined && { interaction_mode: settings.interaction_mode }),
      ...(settings.orchestration_mode !== undefined && { orchestration_mode: settings.orchestration_mode }),
      ...(settings.permission_mode !== undefined && { permission_mode: settings.permission_mode }),
      ...("context_window_mode" in settings && { context_window_mode: settings.context_window_mode }),
      ...("thinking" in settings && { thinking: settings.thinking }),
      ...("fast_mode" in settings && { fast_mode: settings.fast_mode }),
      ...("default_open_in_app" in settings && { default_open_in_app: settings.default_open_in_app }),
      ...("auto_complete_on_merge" in settings && { auto_complete_on_merge: settings.auto_complete_on_merge }),
    });
  }

  /** Find a thread by its primary key. */
  findById(threadId: string): Thread | null {
    return this.threadRepo.findById(threadId);
  }

}
