import type { TurnSavingStatus } from "@mcode/contracts/models/turn-runtime";

/** Schedules a trailing publication and returns its cancellation function. */
export interface SavingStatusTimer {
  schedule(callback: () => void, delayMs: number): () => void;
}

const TRAILING_PUBLISH_MS = 250;

const defaultTimer: SavingStatusTimer = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

interface PendingStatus {
  status: TurnSavingStatus;
  targets: readonly string[];
  readonly cancel: () => void;
}

interface ExecutionPublication {
  lastBroadcast?: TurnSavingStatus;
  pending?: PendingStatus;
}

/** Coalesces progress while preserving immediate failure and recovery edges for each family. */
export class SavingStatusPublisher {
  private readonly threads = new Map<string, Map<string, ExecutionPublication>>();

  constructor(private readonly broadcast: (status: TurnSavingStatus) => void,
    private readonly timer: SavingStatusTimer = defaultTimer) {}

  /** Capture the latest status and family targets without retaining a live owner lookup. */
  publish(status: TurnSavingStatus, familyTargets: readonly string[]): void {
    let executions = this.threads.get(status.threadId);
    if (!executions) {
      executions = new Map();
      this.threads.set(status.threadId, executions);
    }
    let execution = executions.get(status.executionId);
    if (!execution) {
      execution = {};
      executions.set(status.executionId, execution);
    }
    const targets = [status.threadId, ...familyTargets];
    if (isFailureEdge(execution.lastBroadcast, status)) {
      execution.pending?.cancel();
      execution.pending = undefined;
      this.send(execution, status, targets);
    } else if (execution.pending) {
      execution.pending.status = status;
      execution.pending.targets = targets;
    } else {
      const publication = execution;
      execution.pending = { status, targets,
        cancel: this.timer.schedule(() => this.flush(publication), TRAILING_PUBLISH_MS) };
    }
  }

  /** Deliver the last captured status before releasing an owner's publication state. */
  flushThread(threadId: string): void {
    for (const execution of this.threads.get(threadId)?.values() ?? []) this.flush(execution);
    this.threads.delete(threadId);
  }

  /** Flush only after storage callbacks can no longer publish another status. */
  close(): void {
    for (const threadId of this.threads.keys()) this.flushThread(threadId);
  }

  private flush(execution: ExecutionPublication): void {
    const pending = execution.pending;
    if (!pending) return;
    pending.cancel();
    execution.pending = undefined;
    this.send(execution, pending.status, pending.targets);
  }

  private send(execution: ExecutionPublication, status: TurnSavingStatus, targets: readonly string[]): void {
    execution.lastBroadcast = status;
    for (const threadId of targets) this.broadcast({ ...status, threadId });
    if (status.mode === "durable" && !execution.pending) this.forget(status);
  }

  private forget(status: TurnSavingStatus): void {
    const executions = this.threads.get(status.threadId);
    executions?.delete(status.executionId);
    if (executions?.size === 0) this.threads.delete(status.threadId);
  }
}

function isFailureEdge(previous: TurnSavingStatus | undefined, next: TurnSavingStatus): boolean {
  const before = previous && "failure" in previous ? previous : undefined;
  const after = "failure" in next ? next : undefined;
  if (!before || !after) return before !== after;
  return before.mode !== after.mode || before.failure.kind !== after.failure.kind
    || before.failure.name !== after.failure.name || before.failure.message !== after.failure.message;
}
