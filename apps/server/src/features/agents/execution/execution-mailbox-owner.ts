import type { DataOnlyParentTurnStartInput } from "../canonical/canonical-parent-turn-write.js";
import type { ExecutionParentStartContext } from "./provider-execution-event-state.js";
import { sameExecution } from "./execution-mailbox-protocol.js";
import type { ExecutionIdentity, ExecutionLease, ExecutionMailboxCompletion } from "./execution-mailbox-protocol.js";
import type { ExecutionMailboxScheduler, ExecutionRecoveryReceipt } from "./execution-mailbox-scheduler.js";
import type { ExecutionWorkCommand, ExecutionWorkerResult } from "./execution-worker-handler.js";
import { restoreExecutionWriterFailure } from "./execution-writer-failure.js";

type Scheduler = ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>;

interface OwnedExecution {
  readonly execution: ExecutionIdentity;
  readonly lease: ExecutionLease;
  started: boolean;
  /** The release command under way for this execution; a second release waits for it instead of sending another. */
  release?: Promise<void>;
}

/**
 * Refuses a command offered after its execution's worker release began. The worker drops the execution on release,
 * so the command could never run, and while it was pending the release could not free the worker slot. The release
 * ends the turn; `released` settles once it has freed the worker, and rejects if it failed.
 */
export class ExecutionReleaseUnderWay extends Error {
  constructor(executionId: string, readonly released: Promise<void>) {
    super(`Execution release is under way: ${executionId}`);
    this.name = "ExecutionReleaseUnderWay";
  }
}

/** Claims one mailbox before a parent turn can be written or sent to a provider. */
export class ExecutionMailboxOwner {
  private readonly active = new Map<string, OwnedExecution>();

  /**
   * @param onStartAbandoned Ends whatever a start may have saved under a lease this owner gave up without a
   *   committed start. A begin can commit even when its reply fails, and once the lease is gone no retry can claim it.
   */
  constructor(
    private readonly scheduler: Scheduler,
    private readonly onStartAbandoned?: (execution: ExecutionIdentity, lease: ExecutionLease) => Promise<void>,
  ) {}

  /** Start the exact execution on its assigned worker and wait for its durable receipt. */
  async start(input: {
    readonly execution: ExecutionIdentity;
    readonly ownerEpoch: number;
    readonly providerId: string;
    readonly parentTurn: DataOnlyParentTurnStartInput;
    readonly parentLive?: ExecutionParentStartContext;
    readonly publishParentStart?: boolean;
  }): Promise<void> {
    if (this.active.has(input.execution.threadId)) throw new Error("Thread already has an execution owner");
    const claim = this.scheduler.claim(input.execution, input.ownerEpoch);
    if (claim.kind !== "claimed") throw new Error(`Execution claim failed: ${claim.kind}`);
    const owner = { execution: input.execution, lease: claim.lease, started: false };
    this.active.set(input.execution.threadId, owner);
    try {
      const result = await this.submitOwned(owner, {
        kind: "start", providerId: input.providerId, input: input.parentTurn,
        ...(input.parentLive ? { parentLive: input.parentLive } : {}),
        ...(input.publishParentStart ? { publishParentStart: true } : {}),
      });
      if (result.kind !== "committed") throw new Error(`Execution start was not committed: ${input.execution.executionId}`);
      owner.started = true;
    } catch (error) {
      // A lost worker is reconciled by its coordinator. A rejected start did not create worker state.
      if (this.scheduler.release(owner.execution, owner.lease)) {
        this.active.delete(input.execution.threadId);
        await this.onStartAbandoned?.(owner.execution, owner.lease);
      }
      throw error;
    }
  }

  /**
   * Admit one ordered command only for the current thread execution and lease. Rejects with
   * `ExecutionReleaseUnderWay` once the execution's release began.
   */
  submit(execution: ExecutionIdentity, command: ExecutionWorkCommand): Promise<ExecutionWorkerResult> {
    return this.submitAdmitted(this.requireOwner(execution), command);
  }

  /**
   * Put Stop behind every already admitted event before awaiting provider teardown. Rejects with
   * `ExecutionReleaseUnderWay` once the execution's release began.
   */
  stop(execution: ExecutionIdentity, requestId: string): Promise<ExecutionWorkerResult> {
    return this.submitAdmitted(this.requireOwner(execution), { kind: "stop", requestId });
  }

  /**
   * Release the slot only after finalization and its release command have settled. Resolves false when another
   * release freed this execution, or this owner no longer holds it, so whoever freed it owns ending the turn.
   */
  async release(execution: ExecutionIdentity): Promise<boolean> {
    const owner = this.held(execution);
    if (!owner) return false;
    return this.releaseOnce(owner, { kind: "release" }, "Execution release was not acknowledged");
  }

  /**
   * Release an execution using writer evidence validated by its exact worker lease. Resolves false when another
   * release freed this execution, or this owner no longer holds it, so whoever freed it owns ending the turn.
   */
  async releaseRecovered(execution: ExecutionIdentity, recovery: ExecutionRecoveryReceipt): Promise<boolean> {
    const owner = this.held(execution);
    if (!owner) return false;
    if (recovery.operationId !== `${owner.lease.leaseId}:worker-lost`
      || recovery.kind === "conflict" && recovery.recoveryState !== "already-terminal") {
      throw new Error("Recovered release has no matching durable evidence");
    }
    return this.releaseOnce(owner, { kind: "release", recovery }, "Recovered execution release was not acknowledged");
  }

  /**
   * A turn's ordinary release and its saving exit can both release it at once. The worker drops the execution on the
   * first release command, so a second command is refused, and while it is pending the first cannot free the slot.
   * A caller that finds a release under way waits for it, and sends its own only if that one failed.
   */
  private async releaseOnce(owner: OwnedExecution, command: Extract<ExecutionWorkCommand, { kind: "release" }>,
    unacknowledged: string): Promise<boolean> {
    while (owner.release) {
      if (await owner.release.then(() => true, () => false)) return false;
    }
    owner.release = this.submitRelease(owner, command, unacknowledged);
    try {
      await owner.release;
    } catch (error) {
      owner.release = undefined;
      throw error;
    }
    return true;
  }

  private async submitRelease(owner: OwnedExecution, command: Extract<ExecutionWorkCommand, { kind: "release" }>,
    unacknowledged: string): Promise<void> {
    const result = await this.submitOwned(owner, command);
    if (result.kind !== "released" || !this.scheduler.release(owner.execution, owner.lease)) {
      throw new Error(`${unacknowledged}: ${owner.execution.executionId}`);
    }
    this.active.delete(owner.execution.threadId);
  }

  /** Forget a worker-lost execution only after the recovery coordinator released its lease. */
  forgetRecovered(execution: ExecutionIdentity, lease: ExecutionLease): void {
    const owner = this.active.get(execution.threadId);
    if (owner && sameExecution(owner.execution, execution) && owner.lease.leaseId === lease.leaseId) {
      this.active.delete(execution.threadId);
    }
  }

  /** Current exact owner, for provider ingress and Stop routing. */
  current(threadId: string): OwnedExecution | undefined {
    return this.active.get(threadId);
  }

  /** Whether this owner received its durable start receipt. */
  isStarted(execution: ExecutionIdentity): boolean {
    const owner = this.active.get(execution.threadId);
    return owner?.started === true && sameExecution(owner.execution, execution);
  }

  /**
   * An owner drops an execution only when a release freed it, worker-loss recovery released it, or its start was
   * abandoned; each of those ends the turn itself, so a release that finds it gone has nothing to end.
   */
  private held(execution: ExecutionIdentity): OwnedExecution | undefined {
    const owner = this.active.get(execution.threadId);
    return owner && sameExecution(owner.execution, execution) ? owner : undefined;
  }

  private requireOwner(execution: ExecutionIdentity): OwnedExecution {
    const owner = this.held(execution);
    if (!owner) throw new Error(`No matching execution owner: ${execution.executionId}`);
    return owner;
  }

  /** Commands admitted before the release still drain ahead of it, in mailbox order. */
  private submitAdmitted(
    owner: OwnedExecution,
    command: ExecutionWorkCommand | { readonly kind: "stop"; readonly requestId: string },
  ): Promise<ExecutionWorkerResult> {
    if (owner.release) return Promise.reject(new ExecutionReleaseUnderWay(owner.execution.executionId, owner.release));
    return this.submitOwned(owner, command);
  }

  private async submitOwned(
    owner: OwnedExecution,
    command: ExecutionWorkCommand | { readonly kind: "stop"; readonly requestId: string },
  ): Promise<ExecutionWorkerResult> {
    const byteLength = Buffer.byteLength(JSON.stringify({ execution: owner.execution, lease: owner.lease, command }), "utf8");
    const admitted = this.scheduler.submit({ ...owner, command, byteLength });
    if (admitted.kind !== "admitted") throw new Error(`Execution command admission failed: ${admitted.kind}`);
    return requireReply(await admitted.completion);
  }
}

function requireReply(completion: ExecutionMailboxCompletion<ExecutionWorkerResult>): ExecutionWorkerResult {
  if (completion.kind !== "reply") throw new Error(`Execution worker ${completion.kind}`);
  if (completion.result.kind === "rejected") {
    if (completion.result.failure) throw restoreExecutionWriterFailure(completion.result.failure);
    throw new Error(`Execution worker rejected command: ${completion.result.reason}`);
  }
  return completion.result;
}
