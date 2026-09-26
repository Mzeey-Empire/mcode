import type { DataOnlyParentTurnStartInput } from "../canonical/canonical-parent-turn-write.js";
import type { ExecutionParentStartContext } from "./provider-execution-event-state.js";
import type { ExecutionIdentity, ExecutionLease, ExecutionMailboxCompletion } from "./execution-mailbox-protocol.js";
import type { ExecutionMailboxScheduler, ExecutionRecoveryReceipt } from "./execution-mailbox-scheduler.js";
import type { ExecutionWorkCommand, ExecutionWorkerResult } from "./execution-worker-handler.js";

type Scheduler = ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>;

interface OwnedExecution {
  readonly execution: ExecutionIdentity;
  readonly lease: ExecutionLease;
  started: boolean;
}

/** Claims one mailbox before a parent turn can be written or sent to a provider. */
export class ExecutionMailboxOwner {
  private readonly active = new Map<string, OwnedExecution>();

  constructor(private readonly scheduler: Scheduler) {}

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
      if (this.scheduler.release(owner.execution, owner.lease)) this.active.delete(input.execution.threadId);
      throw error;
    }
  }

  /** Admit one ordered command only for the current thread execution and lease. */
  submit(execution: ExecutionIdentity, command: ExecutionWorkCommand): Promise<ExecutionWorkerResult> {
    return this.submitOwned(this.requireOwner(execution), command);
  }

  /** Put Stop behind every already admitted event before awaiting provider teardown. */
  stop(execution: ExecutionIdentity, requestId: string): Promise<ExecutionWorkerResult> {
    const owner = this.requireOwner(execution);
    return this.submitOwned(owner, { kind: "stop", requestId });
  }

  /** Release the slot only after finalization and its release command have settled. */
  async release(execution: ExecutionIdentity): Promise<void> {
    const owner = this.requireOwner(execution);
    const result = await this.submitOwned(owner, { kind: "release" });
    if (result.kind !== "released" || !this.scheduler.release(owner.execution, owner.lease)) {
      throw new Error(`Execution release was not acknowledged: ${execution.executionId}`);
    }
    this.active.delete(execution.threadId);
  }

  /** Release one rejected execution only after the writer has durably settled that exact lease. */
  async releaseRecovered(execution: ExecutionIdentity, recovery: ExecutionRecoveryReceipt): Promise<void> {
    const owner = this.requireOwner(execution);
    if (recovery.operationId !== `${owner.lease.leaseId}:worker-lost`
      || recovery.kind === "conflict" && recovery.recoveryState !== "already-terminal") {
      throw new Error("Recovered release has no matching durable evidence");
    }
    const result = await this.submitOwned(owner, { kind: "release", recovery });
    if (result.kind !== "released" || !this.scheduler.release(owner.execution, owner.lease)) {
      throw new Error(`Recovered execution release was not acknowledged: ${execution.executionId}`);
    }
    this.active.delete(execution.threadId);
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

  private requireOwner(execution: ExecutionIdentity): OwnedExecution {
    const owner = this.active.get(execution.threadId);
    if (!owner || !sameExecution(owner.execution, execution)) {
      throw new Error(`No matching execution owner: ${execution.executionId}`);
    }
    return owner;
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
    throw new Error(`Execution worker rejected command: ${completion.result.reason}`);
  }
  return completion.result;
}

function sameExecution(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
  return left.threadId === right.threadId && left.turnId === right.turnId && left.executionId === right.executionId;
}
