import type { ScheduledTurnRetry, TurnRetryScheduleParams } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { TurnRecoveryService } from "./turn-recovery-service.js";
import { TurnRecoveryError } from "./turn-recovery-error.js";
import type { TurnRetryScheduleRow, TurnRetryScheduleStore } from "./turn-retry-schedule-store.js";

const MAX_DELAY_MS = 2_147_483_647;
const MAX_SCHEDULE_MS = 31 * 24 * 60 * 60 * 1_000;
const BOOT_GRACE_MS = 15 * 60 * 1_000;
type RetryTimer = ReturnType<typeof setTimeout> | number;

/** Clock and timers are supplied together so deadlines can be tested without wall-clock waits. */
export interface TurnRetrySchedulerClock {
  now(): number;
  setTimeout(callback: () => Promise<void>, delay: number): RetryTimer;
  clearTimeout(timer: RetryTimer): void;
}

type ArmedRetry = { row: TurnRetryScheduleRow; timer?: RetryTimer };

const systemClock: TurnRetrySchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(() => { void callback(); }, delay).unref(),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Restores and executes explicit retry intents, using the same admission path as immediate retry. */
export class TurnRetryScheduler {
  private readonly armed = new Map<string, ArmedRetry>();
  private readonly firing = new Set<Promise<void>>();

  constructor(
    private readonly store: TurnRetryScheduleStore,
    private readonly recovery: Pick<TurnRecoveryService, "requireRetryableTurn" | "retryErroredTurn">,
    private readonly dispatch: Parameters<TurnRecoveryService["retryErroredTurn"]>[1],
    private publish: (event: { threadId: string; retry: ScheduledTurnRetry | null }) => void,
    private readonly clock: TurnRetrySchedulerClock = systemClock,
  ) {}

  /** Bind the application's combined WebSocket and desktop push publisher before startup. */
  onChange(publish: (event: { threadId: string; retry: ScheduledTurnRetry | null }) => void): void {
    this.publish = publish;
  }

  /** Persist a validated deadline and replace the thread's previous timer. */
  async schedule(input: TurnRetryScheduleParams): Promise<ScheduledTurnRetry> {
    const turn = this.recovery.requireRetryableTurn(input);
    const now = this.clock.now();
    const delay = Date.parse(input.at) - now;
    if (!Number.isFinite(delay) || delay <= 0) {
      throw new TurnRecoveryError("TURN_RECOVERY_SCHEDULE_INVALID_TIME", "Retry must be scheduled in the future");
    }
    if (delay > MAX_SCHEDULE_MS) {
      throw new TurnRecoveryError("TURN_RECOVERY_SCHEDULE_TOO_FAR", "Retry cannot be scheduled more than 31 days ahead");
    }
    this.disarm(input.threadId);
    const entry: ArmedRetry = { row: { threadId: input.threadId, turnId: input.turnId,
      executionId: turn.executionId, runAt: input.at, createdAt: new Date(now).toISOString() } };
    this.armed.set(input.threadId, entry);
    await this.store.upsert(entry.row);
    const retry = { turnId: input.turnId, at: input.at };
    if (this.armed.get(input.threadId) === entry) {
      try {
        this.recovery.requireRetryableTurn(input);
      } catch (error) {
        await this.unschedule(input.threadId);
        throw error;
      }
      this.arm(entry);
      this.publish({ threadId: input.threadId, retry });
    }
    return retry;
  }

  /** Cancel immediately in memory, then publish only after the durable deletion. */
  async unschedule(threadId: string): Promise<void> {
    if (!this.armed.has(threadId) && !this.store.get(threadId)) return;
    this.disarm(threadId);
    await this.store.delete(threadId);
    this.publish({ threadId, retry: null });
  }

  /** Recover deadlines after turn and startup reconciliation have finished. */
  async start(): Promise<void> {
    for (const row of this.store.listAll()) {
      this.disarm(row.threadId);
      if (this.clock.now() - Date.parse(row.runAt) > BOOT_GRACE_MS) {
        await this.store.delete(row.threadId);
        continue;
      }
      const entry: ArmedRetry = { row };
      this.armed.set(row.threadId, entry);
      if (Date.parse(row.runAt) <= this.clock.now()) await this.fire(entry);
      else this.arm(entry);
    }
  }

  /** Stop timers and drain already firing admissions before the database closes. */
  async shutdown(): Promise<void> {
    for (const threadId of this.armed.keys()) this.disarm(threadId);
    await Promise.all(this.firing);
  }

  private disarm(threadId: string): void {
    const entry = this.armed.get(threadId);
    if (entry?.timer !== undefined) this.clock.clearTimeout(entry.timer);
    this.armed.delete(threadId);
  }

  private arm(entry: ArmedRetry): void {
    const remaining = Date.parse(entry.row.runAt) - this.clock.now();
    entry.timer = this.clock.setTimeout(async () => {
      if (this.armed.get(entry.row.threadId) !== entry) return;
      if (Date.parse(entry.row.runAt) > this.clock.now()) this.arm(entry);
      else await this.fire(entry);
    }, Math.max(0, Math.min(remaining, MAX_DELAY_MS)));
  }

  private async fire(entry: ArmedRetry): Promise<void> {
    const operation = this.fireRetry(entry).catch((error: unknown) => {
      logger.error("Scheduled turn retry failed", { threadId: entry.row.threadId,
        error: error instanceof Error ? error.message : String(error) });
    });
    this.firing.add(operation);
    try { await operation; } finally { this.firing.delete(operation); }
  }

  private async fireRetry(entry: ArmedRetry): Promise<void> {
    const { threadId, turnId, executionId } = entry.row;
    if (this.armed.get(threadId) !== entry) return;
    const stored = this.store.get(threadId);
    await this.store.delete(threadId);
    // A send, cancellation, or replacement during the writer await wins over this callback.
    if (this.armed.get(threadId) !== entry) return;
    this.disarm(threadId);
    this.publish({ threadId, retry: null });
    if (!stored || stored.executionId !== executionId) return;
    const turn = this.recovery.requireRetryableTurn({ threadId, turnId });
    if (turn.executionId !== executionId) return;
    await this.recovery.retryErroredTurn({ threadId, turnId }, this.dispatch);
  }
}
