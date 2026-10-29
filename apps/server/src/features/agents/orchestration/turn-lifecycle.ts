import type { TurnStopCause } from "@mcode/contracts/compat/agent-model";
import type { IAgentProvider } from "@mcode/contracts/providers/interfaces";
import type { ObservedProviderRetries } from "../canonical/turn-ending.js";
import type { ExecutionIdentity } from "../execution/execution-mailbox-protocol.js";
import type { PreparedTurnDispatch, TurnRuntimeLease } from "../turns/turn-admission-dispatch-coordinator.js";
import type { TurnOutcome } from "../turns/turn-outcome.js";

/** Worker ownership stays attached to one execution until its release or recovery completes. */
export interface WorkerOwnedTurn {
  readonly execution: ExecutionIdentity;
  readonly prepared: PreparedTurnDispatch;
  readonly provider: IAgentProvider;
  deliveryAttempt: number;
  terminalCommitted: boolean;
  persistedPublished: boolean;
  terminalOutcome?: TurnOutcome;
  releaseStarted: boolean;
  /** The release scheduled by the committed Ended; a provider can start its next turn before it finishes. */
  terminalRelease?: Promise<void>;
  deliveryFailed?: boolean;
  deliveryFailureHandling?: Promise<void>;
  /** A stop arriving after stream loss joins this finaliser instead of writing another terminal. */
  lostStreamFinish?: Promise<void>;
  stopInProgress?: boolean;
  stopRequested?: boolean;
  lastRetries?: ObservedProviderRetries;
}

/** One execution's immutable record; pre-send stops survive its worker and eviction state. */
export type TurnLifecycle =
  | { readonly phase: "admitted"; readonly executionId: string; readonly stopBeforeSend: TurnStopCause | null }
  | {
      readonly phase: "bound";
      readonly executionId: string;
      readonly stopBeforeSend: TurnStopCause | null;
      readonly worker: WorkerOwnedTurn;
      readonly evictingPooledSession: boolean;
    }
  | { readonly phase: "ended"; readonly executionId: string; readonly stopBeforeSend: TurnStopCause | null };

/** Replaces per-thread records atomically and fences execution-specific transitions against replacement. */
export class TurnLifecycles {
  private readonly byThread = new Map<string, TurnLifecycle>();

  /** A new admission replaces all state retained for the thread's previous execution. */
  admit(threadId: string, executionId: string): void {
    this.byThread.set(threadId, { phase: "admitted", executionId, stopBeforeSend: null });
  }

  /** Only the matching admitted execution can acquire a worker. */
  bind(execution: ExecutionIdentity, worker: WorkerOwnedTurn): void {
    const current = this.byThread.get(execution.threadId);
    if (current?.executionId !== execution.executionId || current.phase !== "admitted") return;
    this.byThread.set(execution.threadId, { ...current, phase: "bound", worker, evictingPooledSession: false });
  }

  /** Worker ownership belongs only to the thread's current bound execution. */
  worker(threadId: string): WorkerOwnedTurn | undefined {
    const current = this.byThread.get(threadId);
    return current?.phase === "bound" ? current.worker : undefined;
  }

  /** A stale execution cannot observe a replacement's worker. */
  workerFor(execution: Pick<ExecutionIdentity, "threadId" | "executionId">): WorkerOwnedTurn | undefined {
    const current = this.byThread.get(execution.threadId);
    return current?.phase === "bound" && current.executionId === execution.executionId ? current.worker : undefined;
  }

  /** Stops remain readable after ending, but cannot cross execution identities. */
  recordStopBeforeSend(threadId: string, executionId: string, stop: TurnStopCause): void {
    const current = this.byThread.get(threadId);
    if (current?.executionId !== executionId) return;
    this.byThread.set(threadId, { ...current, stopBeforeSend: stop });
  }

  /** A stale admission reads only its own stop without consuming it. */
  stopBeforeSend(lease: TurnRuntimeLease): TurnStopCause | undefined {
    const current = this.byThread.get(lease.threadId);
    return current?.executionId === lease.turnExecutionId ? current.stopBeforeSend ?? undefined : undefined;
  }

  /** Releasing an admission consumes its stop without clearing a replacement's stop. */
  releaseAdmission(lease: TurnRuntimeLease): TurnStopCause | undefined {
    const current = this.byThread.get(lease.threadId);
    if (current?.executionId !== lease.turnExecutionId) return undefined;
    this.byThread.set(lease.threadId, { ...current, stopBeforeSend: null });
    return current.stopBeforeSend ?? undefined;
  }

  /** Suppression lasts through teardown, and its finally cannot clear another execution's flag. */
  async withPooledEviction(execution: ExecutionIdentity, evict: () => Promise<void>): Promise<void> {
    const current = this.byThread.get(execution.threadId);
    if (current?.phase === "bound" && current.executionId === execution.executionId) {
      this.byThread.set(execution.threadId, { ...current, evictingPooledSession: true });
    }
    try {
      await evict();
    } finally {
      if (this.byThread.get(execution.threadId)?.executionId === execution.executionId) {
        this.clearPooledEviction(execution.threadId);
      }
    }
  }

  /** Suppression can exist only on the current bound execution. */
  evictingPooledSession(threadId: string): boolean {
    const current = this.byThread.get(threadId);
    return current?.phase === "bound" && current.evictingPooledSession;
  }

  /** Legacy dispatch and stop cleanup clear suppression on the current record only. */
  clearPooledEviction(threadId: string): void {
    const current = this.byThread.get(threadId);
    if (current?.phase !== "bound") return;
    this.byThread.set(threadId, { ...current, evictingPooledSession: false });
  }

  /** Ending drops worker and eviction state, retains the stop, and preserves any supplied identity guard. */
  end(execution: Pick<ExecutionIdentity, "threadId" | "executionId">, worker?: WorkerOwnedTurn): void {
    const current = this.byThread.get(execution.threadId);
    if (current?.executionId !== execution.executionId || current.phase === "ended") return;
    if (worker && (current.phase !== "bound" || current.worker !== worker)) return;
    this.byThread.set(execution.threadId, {
      phase: "ended", executionId: current.executionId, stopBeforeSend: current.stopBeforeSend,
    });
  }
}
