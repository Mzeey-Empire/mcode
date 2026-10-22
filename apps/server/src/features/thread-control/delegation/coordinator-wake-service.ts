import * as NodeCrypto from "node:crypto";
import { logger } from "@mcode/shared";
import type { Thread } from "@mcode/contracts";
import type { DelegatedTaskService } from "./delegated-task-service.js";
import type { ThreadRepo } from "../persistence/thread-repo.js";
import type { CanonicalAgentBoundary } from "../../agents/canonical/canonical-agent-boundary.js";
import type { MessageRepo } from "../../agents/conversation/persistence/message-repo.js";
import type { TurnSteerRepo } from "../../agents/steering/persistence/turn-steer-repo.js";
import type { TurnSteerService } from "../../agents/steering/turn-steer-service.js";
import type { TurnSteerRuntime } from "../../agents/steering/turn-steer-runtime-port.js";
import type { SendMessageCommand } from "../../agents/turns/turn-admission-dispatch-coordinator.js";
import { threadContinuationSettings } from "../../agents/recovery/turn-recovery-service.js";

type WakeTimer = ReturnType<typeof setTimeout> | number;

/** Timer operations used to schedule and cancel Coordinator wakes. */
export interface CoordinatorWakeClock {
  setTimeout(callback: () => Promise<void>, delay: number): WakeTimer;
  clearTimeout(timer: WakeTimer): void;
}

/** Task state and delivery ports required by Coordinator wakes. */
export interface CoordinatorWakeDeps {
  tasks: DelegatedTaskService;
  threads: Pick<ThreadRepo, "findById">;
  canonical: Pick<CanonicalAgentBoundary, "loadLatestTurn">;
  messages: Pick<MessageRepo, "findById">;
  steers: Pick<TurnSteerRepo, "find">;
  steer: Pick<TurnSteerService, "steer">;
  runtime: Pick<TurnSteerRuntime, "runningTurn"> & {
    isActive(threadId: string): boolean;
    sendMessage(command: SendMessageCommand): Promise<void>;
  };
}

const systemClock: CoordinatorWakeClock = {
  setTimeout: (callback, delay) => setTimeout(() => { void callback(); }, delay).unref(),
  clearTimeout: (timer) => clearTimeout(timer),
};

const SETTLE_DELAY_MS = 1_000;
const MAX_BACKOFF_MS = 300_000;

/** Coalesces task changes and delivers one batch when its Coordinator can accept it. */
export class CoordinatorWakeService {
  private readonly timers = new Map<string, WakeTimer>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly noSteer = new Map<string, string>();
  private readonly failures = new Map<string, number>();
  private disposed = false;

  constructor(private readonly deps: CoordinatorWakeDeps, private readonly clock: CoordinatorWakeClock = systemClock) {}

  /** Keep the first settle timer, or rerun once if a reconcile is already in flight. */
  nudge(coordinatorId: string): void {
    if (this.disposed) return;
    if (this.running.has(coordinatorId)) {
      this.dirty.add(coordinatorId);
      return;
    }
    if (this.timers.has(coordinatorId)) return;
    this.timers.set(coordinatorId, this.clock.setTimeout(async () => {
      this.timers.delete(coordinatorId);
      const operation = this.reconcile(coordinatorId).catch((error: unknown) => {
        logger.error("Coordinator wake failed", { coordinatorId, error });
      });
      this.running.set(coordinatorId, operation);
      try { await operation; } finally {
        this.running.delete(coordinatorId);
        if (this.dirty.delete(coordinatorId)) this.nudge(coordinatorId);
      }
    }, this.delayFor(coordinatorId)));
  }

  /** Settle delay, doubled per consecutive failed delivery after the first, so a broken provider is not retried every second. */
  private delayFor(coordinatorId: string): number {
    const failures = this.failures.get(coordinatorId) ?? 0;
    return Math.min(SETTLE_DELAY_MS * 2 ** Math.max(0, Math.min(failures - 1, 20)), MAX_BACKOFF_MS);
  }

  private recordDelivery(coordinatorId: string, delivered: boolean): void {
    if (delivered) this.failures.delete(coordinatorId);
    else this.failures.set(coordinatorId, (this.failures.get(coordinatorId) ?? 0) + 1);
  }

  /** Reconcile crash receipts before scheduling any pending task results. */
  async recoverAtStartup(): Promise<void> {
    const tasks = this.deps.tasks.noticeTasks();
    const claims = new Map(tasks.flatMap((task) => task.noticeClaim
      ? [[task.noticeClaim.wakeId, task.coordinatorThreadId] as const] : []));
    for (const [wakeId, coordinatorId] of claims) await this.finishFromEvidence(coordinatorId, wakeId);
    for (const coordinatorId of this.deps.tasks.coordinatorsWithUncoveredNotices()) this.nudge(coordinatorId);
  }

  /** Stop timers and drain outstanding ledger writes before the database closes. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
    this.dirty.clear();
    await Promise.all(this.running.values());
    this.noSteer.clear();
    this.failures.clear();
  }

  private async reconcile(coordinatorId: string): Promise<void> {
    const thread = this.deps.threads.findById(coordinatorId);
    if (this.disposed || !thread || thread.deleted_at) return;
    const turn = this.deps.runtime.runningTurn(coordinatorId);
    if (turn) {
      // A turn without the lease cannot call task_status for detail, so the result waits for a turn that can.
      if (!turn.steer || !turn.holdsDelegationLease || this.noSteer.get(coordinatorId) === turn.turnExecutionId) return;
      await this.deliverSteer(coordinatorId, turn.turnExecutionId);
      return;
    }
    if (this.deps.runtime.isActive(coordinatorId)) return;
    await this.deliverIdle(thread);
  }

  private async deliverIdle(thread: Thread): Promise<void> {
    const coordinatorId = thread.id;
    const ending = this.deps.canonical.loadLatestTurn(coordinatorId)?.ending;
    if (ending?.outcome === "cancelled" && ending.stop.by === "user") return;
    this.noSteer.delete(coordinatorId);
    const batch = await this.deps.tasks.claimNotices(coordinatorId, NodeCrypto.randomUUID());
    if (!batch) return;
    if (this.disposed) return this.deps.tasks.returnNotices(batch.wakeId);
    const delivered = await this.send({ ...threadContinuationSettings(thread),
      content: batch.content, messageId: batch.wakeId, systemNotice: batch.systemNotice,
      permissionMode: thread.permission_mode === "full" ? "full" : "supervised", delegationWake: true });
    this.recordDelivery(coordinatorId, delivered);
    if (batch.hasMore) this.nudge(coordinatorId);
  }

  private async deliverSteer(coordinatorId: string, turnExecutionId: string): Promise<void> {
    const batch = await this.deps.tasks.claimNotices(coordinatorId, NodeCrypto.randomUUID());
    if (!batch) return;
    if (this.disposed) return this.deps.tasks.returnNotices(batch.wakeId);
    try {
      const result = await this.deps.steer.steer({ threadId: coordinatorId, turnExecutionId,
        messageId: batch.wakeId, content: batch.content }, { systemNotice: batch.systemNotice });
      if (result.status === "delivered" || result.status === "delivery_unknown") {
        await this.deps.tasks.settleNotices(batch.wakeId);
        this.recordDelivery(coordinatorId, true);
        if (batch.hasMore) this.nudge(coordinatorId);
        return;
      }
    } catch (error) {
      logger.warn("Coordinator steer was not accepted", { coordinatorId, turnExecutionId, error });
    }
    this.noSteer.set(coordinatorId, turnExecutionId);
    await this.finishFromEvidence(coordinatorId, batch.wakeId);
  }

  private async send(command: SendMessageCommand): Promise<boolean> {
    const wakeId = command.messageId;
    if (!wakeId) throw new Error("Coordinator wake requires a message identity");
    return new Promise<boolean>((resolve, reject) => {
      let finished = false;
      const complete = async (admitted: boolean): Promise<void> => {
        if (finished) return;
        finished = true;
        try {
          if (admitted) await this.deps.tasks.settleNotices(wakeId);
          resolve(admitted || await this.finishFromEvidence(command.threadId, wakeId));
        } catch (error) { reject(error); }
      };
      void this.deps.runtime.sendMessage({ ...command,
        onAdmissionComplete: (admitted) => { void complete(admitted); },
        onRuntimeReleased: () => { void complete(false); this.nudge(command.threadId); },
      }).then(() => complete(false), (error: unknown) => {
        logger.warn("Coordinator wake admission failed", { coordinatorId: command.threadId, error });
        return complete(false);
      });
    });
  }

  private async finishFromEvidence(coordinatorId: string, wakeId: string): Promise<boolean> {
    const message = this.deps.messages.findById(wakeId);
    const steer = this.deps.steers.find(wakeId);
    const reached = message?.thread_id === coordinatorId || (steer?.threadId === coordinatorId && steer.state !== "rejected");
    if (reached) await this.deps.tasks.settleNotices(wakeId);
    else await this.deps.tasks.returnNotices(wakeId);
    return reached;
  }
}
