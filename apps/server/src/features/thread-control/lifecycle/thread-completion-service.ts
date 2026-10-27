import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type { CompletedThreadRetentionDays, Settings } from "@mcode/contracts/models/settings";
import type { Thread } from "@mcode/contracts/models/thread";
import type { ThreadCompletionRefusal, ThreadCompletionResult } from "@mcode/contracts/ws/methods";
import { ThreadRepo, type ThreadCompletedBy } from "../persistence/thread-repo.js";
import { AgentService } from "../../agents/index.js";
import { ApprovalService } from "../../agents/approvals/approval-service.js";
import { SettingsService } from "../../settings/settings-service.js";
import { ThreadTeardownService } from "./thread-teardown-service.js";
import { ThreadControlMutationReservationService } from "../authority/thread-control-mutation-reservation-service.js";
import { CleanupJobRepo } from "../cleanup/persistence/cleanup-job-repo.js";
import { CompletionHolds } from "./completion-holds.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const OVERDUE_SAFETY_MS = DAY_MS;
const RETENTION_RECALCULATION_BATCH_SIZE = 100;

type ThreadResourceOwnerRelease = void | (() => void);

function completionFailureMessage(result: PromiseRejectedResult): string {
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

/** Owns durable user completion and reopen transitions for one thread. */
@injectable()
export class ThreadCompletionService {
  private retentionRecalculation: Promise<void> = Promise.resolve();
  private readonly resourceOwners = new Map<string, (threadId: string) => Promise<ThreadResourceOwnerRelease>>();
  private deadlineChangesListener: ((threads: readonly Thread[]) => void) | null = null;
  private lastRetentionDays: CompletedThreadRetentionDays | undefined;
  private unsubscribeSettings: (() => void) | null = null;
  private retentionRecalculationGeneration = 0;

  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(AgentService) private readonly agentService: {
      runtimeAccess(): Pick<ReturnType<AgentService["runtimeAccess"]>, "activeThreadIds">;
    },
    @inject(ApprovalService) private readonly permissions: Pick<ApprovalService, "listPendingApprovals">,
    @inject(ThreadTeardownService) private readonly teardownService: Pick<ThreadTeardownService, "teardownThread">,
    @inject(ThreadControlMutationReservationService)
    private readonly mutationReservations: ThreadControlMutationReservationService,
    @inject(SettingsService) private readonly settingsService: Pick<SettingsService, "get" | "on">,
    @inject("ThreadCompletionClock", { isOptional: true })
    private readonly clock: (() => Date) | undefined,
    @inject(CleanupJobRepo)
    private readonly cleanupJobRepo: CleanupJobRepo,
    @inject(CompletionHolds) private readonly completionHolds: CompletionHolds = new CompletionHolds(),
  ) {}

  /** Start retention reconciliation for settings changes. */
  start(): void {
    if (this.unsubscribeSettings) return;
    const initialSettings = this.settingsService.get();
    this.lastRetentionDays = this.retentionDays(initialSettings);
    this.unsubscribeSettings = this.settingsService.on("change", (settings) => {
      const nextRetentionDays = this.retentionDays(settings);
      const previousRetentionDays = this.lastRetentionDays;
      if (previousRetentionDays === undefined) {
        this.lastRetentionDays = nextRetentionDays;
        return;
      }
      this.lastRetentionDays = nextRetentionDays;
      if (previousRetentionDays !== nextRetentionDays) {
        const generation = ++this.retentionRecalculationGeneration;
        this.retentionRecalculation = this.retentionRecalculation
          .then(() => this.recalculateDeadlineBatch(previousRetentionDays, nextRetentionDays, null, generation))
          .catch((error: unknown) => {
            logger.error("Thread retention deadline recalculation failed", { error: error instanceof Error ? error.message : String(error) });
          });
      }
    });
  }

  /** Stop retention reconciliation for settings changes. */
  stop(): void {
    this.completionHolds.stop();
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.retentionRecalculationGeneration += 1;
  }

  /** Stop new recalculations and await already admitted retention effects before writer shutdown. */
  async shutdown(): Promise<void> {
    this.stop();
    await this.retentionRecalculation;
  }

  /** Register the push publisher for recalculated thread deadlines. */
  onDeadlineChanges(listener: (threads: readonly Thread[]) => void): void {
    this.deadlineChangesListener = listener;
  }

  /** Register a thread-owned resource release that may retain a lifecycle barrier through completion. */
  registerResourceOwner(name: string, release: (threadId: string) => Promise<ThreadResourceOwnerRelease>): void {
    if (this.resourceOwners.has(name)) {
      throw new Error(`Thread resource owner is already registered: ${name}`);
    }
    this.resourceOwners.set(name, release);
  }

  /** Complete an idle thread and release its thread-owned runtime resources. */
  complete(threadId: string, holdMs = 0, completedBy?: ThreadCompletedBy): Promise<ThreadCompletionResult> {
    return this.completionHolds.complete(threadId, holdMs, () => this.commitCompletion(threadId, completedBy));
  }

  private async commitCompletion(threadId: string, completedBy: ThreadCompletedBy | undefined): Promise<ThreadCompletionResult> {
    const token = this.mutationReservations.reserve(threadId, "completing");
    if (!token) return { ok: false, refusal: "busy" };

    try {
      const thread = this.requireThread(threadId);
      if (thread.user_completed_at !== null) return { ok: true, thread };
      const refusal = this.assertCompletable(threadId);
      if (refusal) return { ok: false, refusal };
      const completed = await this.persistCompletion(thread, completedBy);
      return { ok: true, thread: await this.releaseResourcesBeforeAdmissionReopens(completed) };
    } finally {
      this.mutationReservations.release(threadId, token);
    }
  }

  private async releaseResourcesBeforeAdmissionReopens(completed: Thread): Promise<Thread> {
    const { failures, barriers } = await this.releaseThreadResources(completed.id);
    try {
      return await this.reportCleanupFailures(completed, failures);
    } finally {
      for (const release of barriers) release();
    }
  }

  private assertCompletable(threadId: string): ThreadCompletionRefusal | null {
    if (this.agentService.runtimeAccess().activeThreadIds().includes(threadId)) {
      return "running";
    }
    if (this.permissions.listPendingApprovals(threadId).length > 0) {
      return "approval-pending";
    }
    return null;
  }

  private async releaseThreadResources(threadId: string): Promise<{
    failures: PromiseRejectedResult[];
    barriers: Array<() => void>;
  }> {
    const releases = await Promise.allSettled([
      this.teardownService.teardownThread(threadId),
      ...[...this.resourceOwners.values()].map((release) => release(threadId)),
    ]);
    return {
      failures: releases.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      ),
      barriers: releases.flatMap((result) =>
        result.status === "fulfilled" && typeof result.value === "function" ? [result.value] : [],
      ),
    };
  }

  private async reportCleanupFailures(thread: Thread, failures: PromiseRejectedResult[]): Promise<Thread> {
    if (failures.length === 0) return thread;
    const reason = failures.map(completionFailureMessage).join("; ");
    logger.error("Completed thread resource cleanup failed", { threadId: thread.id, reason });
    const blocked = await this.threadRepo.blockRetentionCleanup(thread.id, reason);
    if (!blocked) throw new Error(`Thread not found: ${thread.id}`);
    return blocked;
  }

  private async persistCompletion(thread: Thread, completedBy: ThreadCompletedBy | undefined): Promise<Thread> {
    const completedAt = this.clock?.() ?? new Date();
    const retentionDays = this.retentionDays(this.settingsService.get());
    const scheduledDeletionAt = retentionDays === null
      ? null
      : new Date(completedAt.getTime() + retentionDays * DAY_MS).toISOString();
    const completed = await this.threadRepo.complete(thread.id, completedAt.toISOString(), scheduledDeletionAt, completedBy);
    if (!completed) throw new Error(`Thread not found: ${thread.id}`);
    return completed;
  }

  /** Reopen a completed thread and cancel its pending automatic deletion. */
  async reopen(threadId: string): Promise<Thread> {
    if (this.completionHolds.cancel(threadId)) return this.requireThread(threadId);
    const token = this.mutationReservations.reserve(threadId, "reopening");
    if (!token) throw new Error(`Thread has a pending mutation: ${threadId}`);

    try {
      this.requireThread(threadId);
      const reopened = await this.threadRepo.reopen(threadId, (this.clock?.() ?? new Date()).toISOString());
      if (!reopened) {
        const current = this.requireThread(threadId);
        if (
          current.cleanup_state === "running"
          || (current.cleanup_state === "blocked" && this.threadRepo.hasRetentionCleanupJob(threadId))
        ) {
          throw new Error("Thread cleanup has already started");
        }
        throw new Error(`Thread not found: ${threadId}`);
      }
      return reopened;
    } finally {
      this.mutationReservations.release(threadId, token);
    }
  }

  /** Return the number of completed retention candidates waiting for retry. */
  cleanupBlockedCount(): { count: number } {
    return { count: this.cleanupJobRepo.countBlockedRetentionCandidates() };
  }

  /** Atomically requeue one blocked completed thread for retention cleanup. */
  async retryCleanup(threadId: string): Promise<Thread> {
    const token = this.mutationReservations.reserve(threadId, "cleaning");
    if (!token) throw new Error(`Thread cleanup is already running: ${threadId}`);

    try {
      const thread = this.requireThread(threadId);
      if (thread.user_completed_at === null) {
        throw new Error("Thread is not completed");
      }
      if (thread.cleanup_state === "running") {
        throw new Error("Thread cleanup is already running");
      }
      if (thread.cleanup_state !== "blocked") {
        throw new Error("Thread cleanup is not blocked");
      }
      if (!await this.cleanupJobRepo.requeueBlockedRetention(threadId)) {
        throw new Error("Thread cleanup is no longer blocked");
      }
      const queued = this.threadRepo.findById(threadId);
      if (!queued) throw new Error(`Thread not found: ${threadId}`);
      return queued;
    } finally {
      this.mutationReservations.release(threadId, token);
    }
  }

  private requireThread(threadId: string): Thread {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.deleted_at !== null) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    return thread;
  }

  private retentionDays(settings: Settings): CompletedThreadRetentionDays {
    return settings.thread.completion.retentionDays;
  }

  private async recalculateDeadlineBatch(
    previousRetentionDays: CompletedThreadRetentionDays,
    nextRetentionDays: CompletedThreadRetentionDays,
    afterId: string | null,
    generation: number,
  ): Promise<void> {
    if (generation !== this.retentionRecalculationGeneration) return;
    const now = this.clock?.() ?? new Date();
    const nowMs = now.getTime();
    const safetyDeadline = new Date(nowMs + OVERDUE_SAFETY_MS).toISOString();
    const shorter = nextRetentionDays !== null
      && (previousRetentionDays === null || nextRetentionDays < previousRetentionDays);
    const records = this.threadRepo.listCompletedRetentionRecords(
      afterId,
      RETENTION_RECALCULATION_BATCH_SIZE,
    );
    const updates = records.flatMap((record) => {
      const calculatedDeadline = nextRetentionDays === null
        ? null
        : new Date(
          new Date(record.userCompletedAt).getTime() + nextRetentionDays * DAY_MS,
        ).toISOString();
      const newlyOverdue = shorter
        && calculatedDeadline !== null
        && new Date(calculatedDeadline).getTime() <= nowMs
        && (
          record.scheduledDeletionAt === null
          || new Date(record.scheduledDeletionAt).getTime() > nowMs
        );
      const nextScheduledDeletionAt = newlyOverdue ? safetyDeadline : calculatedDeadline;
      return nextScheduledDeletionAt === record.scheduledDeletionAt
        ? []
        : [{ ...record, nextScheduledDeletionAt }];
    });
    const changed = await this.threadRepo.updateCompletedThreadDeadlines(updates);
    if (changed.length > 0) this.deadlineChangesListener?.(changed);
    if (generation !== this.retentionRecalculationGeneration) return;
    if (records.length < RETENTION_RECALCULATION_BATCH_SIZE) return;
    const nextAfterId = records.at(-1)!.id;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await this.recalculateDeadlineBatch(previousRetentionDays, nextRetentionDays, nextAfterId, generation);
  }
}
