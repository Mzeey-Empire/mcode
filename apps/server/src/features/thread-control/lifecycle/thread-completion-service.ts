import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type { CompletedThreadRetentionDays, Settings, Thread } from "@mcode/contracts";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { AgentService } from "../../agents/index.js";
import { AgentPermissionService } from "../../agents/permissions/agent-permission-service.js";
import { SettingsService } from "../../settings/settings-service.js";
import { ThreadTeardownService } from "./thread-teardown-service.js";
import { ThreadControlMutationReservationService } from "../authority/thread-control-mutation-reservation-service.js";
import { CleanupJobRepo } from "../cleanup/persistence/cleanup-job-repo.js";

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
    @inject(AgentService) private readonly agentService: AgentService,
    @inject(AgentPermissionService) private readonly permissions: AgentPermissionService,
    @inject(ThreadTeardownService) private readonly teardownService: ThreadTeardownService,
    @inject(ThreadControlMutationReservationService)
    private readonly mutationReservations: ThreadControlMutationReservationService,
    @inject(SettingsService) private readonly settingsService: SettingsService,
    @inject("ThreadCompletionClock", { isOptional: true })
    private readonly clock: (() => Date) | undefined,
    @inject(CleanupJobRepo)
    private readonly cleanupJobRepo: CleanupJobRepo,
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
  async complete(threadId: string): Promise<Thread> {
    const token = this.mutationReservations.reserve(threadId, "completing");
    if (!token) throw new Error(`Thread has a pending mutation: ${threadId}`);

    try {
      const thread = this.requireThread(threadId);
      if (thread.user_completed_at !== null) return thread;
      this.assertCompletable(threadId);
      const { failures, barriers } = await this.releaseThreadResources(threadId);
      try {
        this.throwOnCompletionFailures(threadId, failures);
        return await this.persistCompletion(thread);
      } finally {
        for (const release of barriers) release();
      }
    } finally {
      this.mutationReservations.release(threadId, token);
    }
  }

  private assertCompletable(threadId: string): void {
    if (this.agentService.runtimeAccess().activeThreadIds().includes(threadId)) {
      throw new Error("Thread cannot be completed while it is running");
    }
    if (this.permissions.listPendingPermissions(threadId).length > 0) {
      throw new Error("Thread cannot be completed while permission is pending");
    }
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

  private throwOnCompletionFailures(threadId: string, failures: PromiseRejectedResult[]): void {
    if (failures.length === 0) return;
    throw new Error(
      `Thread completion failed for ${threadId}: ${failures.map(completionFailureMessage).join("; ")}`,
    );
  }

  private async persistCompletion(thread: Thread): Promise<Thread> {
    const completedAt = this.clock?.() ?? new Date();
    const retentionDays = this.retentionDays(this.settingsService.get());
    const scheduledDeletionAt = retentionDays === null
      ? null
      : new Date(completedAt.getTime() + retentionDays * DAY_MS).toISOString();
    const completed = await this.threadRepo.complete(thread.id, completedAt.toISOString(), scheduledDeletionAt);
    if (!completed) throw new Error(`Thread not found: ${thread.id}`);
    return completed;
  }

  /** Reopen a completed thread and cancel its pending automatic deletion. */
  async reopen(threadId: string): Promise<Thread> {
    const token = this.mutationReservations.reserve(threadId, "reopening");
    if (!token) throw new Error(`Thread has a pending mutation: ${threadId}`);

    try {
      this.requireThread(threadId);
      const reopened = await this.threadRepo.reopen(threadId, (this.clock?.() ?? new Date()).toISOString());
      if (!reopened) {
        const current = this.threadRepo.findById(threadId);
        if (
          current?.cleanup_state === "running"
          || (current?.cleanup_state === "blocked" && this.threadRepo.hasRetentionCleanupJob(threadId))
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
