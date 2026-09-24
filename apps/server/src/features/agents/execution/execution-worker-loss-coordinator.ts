import * as NodeCrypto from "node:crypto";

import type { CanonicalExecutionWriterPort } from "../canonical/canonical-execution-writer-port.js";
import {
  ExecutionMailboxScheduler,
  type ExecutionLostAssignment,
  type ExecutionMailboxOptions,
  type ExecutionRecoveryReceipt,
} from "./execution-mailbox-scheduler.js";
import type { ExecutionWorkCommand, ExecutionWorkerResult, ExecutionWriteReceipt } from "./execution-worker-handler.js";

const WORKER_LOSS_REASON = "The provider could not prove that this execution was still active after its worker exited.";

type Scheduler = ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>;
type SchedulerOptions = Omit<ExecutionMailboxOptions<ExecutionWorkCommand, ExecutionWorkerResult>, "onWorkerLost">;

/** Reconciliation result for a worker slot. A failure leaves that slot unavailable. */
export type WorkerLossResolution =
  | { readonly kind: "recovered"; readonly workerIndex: number }
  | { readonly kind: "failed"; readonly workerIndex: number; readonly error: Error; readonly unresolved: readonly ExecutionLostAssignment[] };

interface LostSlot {
  readonly workerIndex: number;
  readonly unresolved: ExecutionLostAssignment[];
  task: Promise<WorkerLossResolution> | null;
  result: WorkerLossResolution | null;
}

/** Owns the durable handoff between a crashed execution worker and its replacement. */
export class ExecutionWorkerLossCoordinator {
  readonly scheduler: Scheduler;
  private readonly slots = new Map<number, LostSlot>();

  constructor(
    private readonly writer: Pick<CanonicalExecutionWriterPort, "interruptWorkerLoss">,
    options: SchedulerOptions,
  ) {
    this.scheduler = new ExecutionMailboxScheduler({
      ...options,
      onWorkerLost: (assignments, workerIndex) => this.workerLost(assignments, workerIndex),
    });
  }

  /** Wait for the current recovery attempt without starting another attempt. */
  waitForRecovery(workerIndex: number): Promise<WorkerLossResolution> {
    const slot = this.slots.get(workerIndex);
    if (!slot?.task) throw new Error(`No lost execution worker at slot ${workerIndex}`);
    return slot.task;
  }

  /** Retry a failed reconciliation explicitly; no provider command is replayed. */
  retryFailed(workerIndex: number): Promise<WorkerLossResolution> {
    const slot = this.slots.get(workerIndex);
    if (!slot || slot.result?.kind !== "failed") {
      throw new Error(`No failed execution recovery at slot ${workerIndex}`);
    }
    this.schedule(slot);
    if (!slot.task) throw new Error(`No pending execution recovery at slot ${workerIndex}`);
    return slot.task;
  }

  private workerLost(assignments: readonly ExecutionLostAssignment[], workerIndex: number): void {
    const slot: LostSlot = {
      workerIndex,
      unresolved: [...assignments],
      task: null,
      result: null,
    };
    this.slots.set(workerIndex, slot);
    this.schedule(slot);
  }

  private schedule(slot: LostSlot): void {
    slot.result = null;
    slot.task = Promise.resolve().then(() => this.reconcile(slot)).then((result) => {
      slot.result = result;
      return result;
    });
  }

  private async reconcile(slot: LostSlot): Promise<WorkerLossResolution> {
    try {
      while (slot.unresolved.length > 0) {
        const assignment = slot.unresolved[0];
        if (!assignment) break;
        const receipt = await this.writer.interruptWorkerLoss({
          ...assignment,
          reason: WORKER_LOSS_REASON,
          recoveryIncidentId: incidentId(assignment),
        });
        const evidence = recoveryEvidence(receipt);
        if (!evidence || !this.scheduler.reconcileLost(assignment.execution, assignment.lease, evidence)) {
          throw new Error(`Lost execution has no matching durable recovery evidence: ${assignment.execution.executionId}`);
        }
        slot.unresolved.shift();
      }
      if (!this.scheduler.replaceWorker(slot.workerIndex)) {
        throw new Error(`Lost execution worker slot ${slot.workerIndex} could not be replaced`);
      }
      return { kind: "recovered", workerIndex: slot.workerIndex };
    } catch (error) {
      return { kind: "failed", workerIndex: slot.workerIndex,
        error: error instanceof Error ? error : new Error(String(error)),
        unresolved: [...slot.unresolved] };
    }
  }
}

function recoveryEvidence(receipt: ExecutionWriteReceipt): ExecutionRecoveryReceipt | null {
  if (receipt.kind === "committed") return receipt;
  if (!receipt.recoveryState) return null;
  return { ...receipt, recoveryState: receipt.recoveryState };
}

function incidentId(assignment: ExecutionLostAssignment): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([assignment.execution, assignment.lease])).digest("hex");
  return `worker-loss:${hash}`;
}
