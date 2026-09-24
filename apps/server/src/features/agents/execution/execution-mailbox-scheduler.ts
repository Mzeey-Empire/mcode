import * as NodeCrypto from "node:crypto";

import type {
  ExecutionIdentity,
  ExecutionLease,
  ExecutionMailboxCompletion,
  ExecutionWorkerPort,
  ExecutionWorkerReply,
  ExecutionWorkerRequest,
} from "./execution-mailbox-protocol.js";

/** The caller supplies typed start, event, checkpoint, outcome, and finalization work. */
export type ExecutionMailboxCommand<Work extends { readonly kind: string }> =
  | Work
  | { readonly kind: "stop"; readonly requestId: string };

/** Lifecycle results that must be allowed to settle after Stop is admitted. */
export const EXECUTION_CONTROL_KINDS = [
  "checkpoint", "effect-result", "provider-outcome", "stage-terminal", "finalize", "release",
] as const;
export type ExecutionControlKind = typeof EXECUTION_CONTROL_KINDS[number];
const CONTROL_KINDS: ReadonlySet<string> = new Set(EXECUTION_CONTROL_KINDS);

interface Pending<Command, Result> {
  readonly request: ExecutionWorkerRequest<Command>;
  readonly byteLength: number;
  readonly control: boolean;
  readonly resolve: (completion: ExecutionMailboxCompletion<Result>) => void;
}

interface Assignment<Command, Result> {
  readonly execution: ExecutionIdentity;
  readonly lease: ExecutionLease;
  readonly slot: Slot<Command, Result>;
  nextOrdinal: number;
  pendingCount: number;
  pendingBytes: number;
  normalCount: number;
  normalBytes: number;
  stopping: boolean;
  revoked: boolean;
}

interface Slot<Command, Result> {
  readonly index: number;
  generation: number;
  worker: ExecutionWorkerPort<Command, Result> | undefined;
  inFlight: Pending<Command, Result> | undefined;
  readonly queues: Map<string, Pending<Command, Result>[]>;
  readonly readyThreads: string[];
  activeCount: number;
}

/** Capacity includes posted work until its reply arrives. Control has a reserve. */
export interface ExecutionMailboxLimits {
  readonly maxPending: number;
  readonly maxPendingBytes: number;
  readonly reservedControl: number;
  readonly reservedControlBytes: number;
  readonly maxPerExecutionPending: number;
  readonly maxPerExecutionBytes: number;
  readonly reservedPerExecutionControl: number;
  readonly reservedPerExecutionControlBytes: number;
}

/** Exact ownership that a host must revoke before replacing a lost worker. */
export interface ExecutionLostAssignment {
  readonly execution: ExecutionIdentity;
  readonly lease: ExecutionLease;
}

/** Writer evidence that a lost worker's execution can release its thread and slot. */
export type ExecutionRecoveryReceipt =
  | { readonly kind: "committed"; readonly operationId: string; readonly durableRevision: number }
  | { readonly kind: "conflict"; readonly operationId: string; readonly recoveryState: "not-started" | "already-terminal" };

/** The host supplies durable owner epochs and a worker factory for each fixed slot. */
export interface ExecutionMailboxOptions<Work extends { readonly kind: string }, Result> {
  readonly workerCount: number;
  readonly limits: ExecutionMailboxLimits;
  readonly createWorker: (workerIndex: number) => ExecutionWorkerPort<ExecutionMailboxCommand<Work>, Result>;
  readonly onWorkerLost: (assignments: readonly ExecutionLostAssignment[]) => void;
}

export type ExecutionClaim =
  | { readonly kind: "claimed"; readonly lease: ExecutionLease }
  | { readonly kind: "thread-busy" | "worker-unavailable" | "shutdown" };

export type ExecutionAdmission<Result> =
  | { readonly kind: "admitted"; readonly ordinal: number; readonly completion: Promise<ExecutionMailboxCompletion<Result>> }
  | { readonly kind: "stale-execution" | "overloaded" | "invalid-size" | "stop-already-requested" | "stopping" | "shutdown" };

type AdmissionDecision =
  | { readonly kind: "accept"; readonly control: boolean; readonly stop: boolean }
  | { readonly kind: "invalid-size" | "overloaded" | "stop-already-requested" | "stopping" };

/** Bounded state visible to diagnostics without exposing command payloads. */
export interface ExecutionMailboxDepth {
  readonly pending: number;
  readonly pendingBytes: number;
  readonly activeExecutions: number;
  readonly workers: readonly { readonly index: number; readonly queued: number; readonly inFlight: boolean }[];
}

/**
 * Holds an execution on one fixed worker for its lifetime. This scheduler only
 * admits and transports commands; a worker reply carries the writer's durable
 * receipt and must be interpreted by the caller before publishing success.
 */
export class ExecutionMailboxScheduler<Work extends { readonly kind: string }, Result> {
  private readonly slots: Slot<ExecutionMailboxCommand<Work>, Result>[];
  private readonly byThread = new Map<string, Assignment<ExecutionMailboxCommand<Work>, Result>>();
  private readonly limits: ExecutionMailboxLimits;
  private readonly createWorker: ExecutionMailboxOptions<Work, Result>["createWorker"];
  private readonly onWorkerLost: ExecutionMailboxOptions<Work, Result>["onWorkerLost"];
  private pendingCount = 0;
  private pendingBytes = 0;
  private normalCount = 0;
  private normalBytes = 0;
  private nextRequestId = 1;
  private nextSlotIndex = 0;
  private stopped = false;

  constructor(options: ExecutionMailboxOptions<Work, Result>) {
    validateOptions(options);
    this.limits = options.limits;
    this.createWorker = options.createWorker;
    this.onWorkerLost = options.onWorkerLost;
    this.slots = Array.from({ length: options.workerCount }, (_, index) => ({
      index,
      generation: 0,
      worker: undefined,
      inFlight: undefined,
      queues: new Map(),
      readyThreads: [],
      activeCount: 0,
    }));
    try {
      for (const slot of this.slots) this.startWorker(slot);
    } catch (error) {
      for (const slot of this.slots) slot.worker?.terminate();
      throw error;
    }
  }

  /** Bind one turn attempt and its durable owner epoch before submitting start. */
  claim(execution: ExecutionIdentity, ownerEpoch: number): ExecutionClaim {
    if (this.stopped) return { kind: "shutdown" };
    if (!validIdentity(execution) || !positiveInteger(ownerEpoch)) throw new Error("Invalid execution identity or owner epoch");
    if (this.byThread.has(execution.threadId)) return { kind: "thread-busy" };
    const slot = this.chooseSlot();
    if (!slot) return { kind: "worker-unavailable" };
    const lease: ExecutionLease = {
      ownerEpoch,
      workerIndex: slot.index,
      workerGeneration: slot.generation,
      leaseId: NodeCrypto.randomUUID(),
    };
    this.byThread.set(execution.threadId, {
      execution: { ...execution },
      lease,
      slot,
      nextOrdinal: 1,
      pendingCount: 0,
      pendingBytes: 0,
      normalCount: 0,
      normalBytes: 0,
      stopping: false,
      revoked: false,
    });
    slot.activeCount += 1;
    return { kind: "claimed", lease };
  }

  /** Admit in FIFO order. byteLength must cover the entire cloneable request. */
  submit(input: {
    readonly execution: ExecutionIdentity;
    readonly lease: ExecutionLease;
    readonly command: ExecutionMailboxCommand<Work>;
    readonly byteLength: number;
  }): ExecutionAdmission<Result> {
    if (this.stopped) return { kind: "shutdown" };
    const assignment = this.currentAssignment(input.execution, input.lease);
    if (!assignment || assignment.revoked) return { kind: "stale-execution" };
    const decision = this.admissionDecision(assignment, input.command, input.byteLength);
    if (decision.kind !== "accept") return { kind: decision.kind };
    const ordinal = assignment.nextOrdinal++;
    const request: ExecutionWorkerRequest<ExecutionMailboxCommand<Work>> = {
      requestId: this.nextRequestId++,
      execution: assignment.execution,
      lease: assignment.lease,
      ordinal,
      ...(decision.stop ? { stopWatermark: ordinal - 1 } : {}),
      command: input.command,
    };
    let resolveCompletion: (completion: ExecutionMailboxCompletion<Result>) => void = () => {};
    const completion = new Promise<ExecutionMailboxCompletion<Result>>((resolve) => {
      resolveCompletion = resolve;
    });
    const pending: Pending<ExecutionMailboxCommand<Work>, Result> = {
      request,
      byteLength: input.byteLength,
      control: decision.control,
      resolve: resolveCompletion,
    };
    this.retain(assignment, pending);
    if (decision.stop) assignment.stopping = true;
    this.enqueue(assignment.slot, pending);
    this.dispatch(assignment.slot);
    return { kind: "admitted", ordinal, completion };
  }

  /** Release only after the worker has acknowledged every command for the execution. */
  release(execution: ExecutionIdentity, lease: ExecutionLease): boolean {
    const assignment = this.currentAssignment(execution, lease);
    if (!assignment || assignment.revoked || assignment.pendingCount !== 0) return false;
    this.byThread.delete(execution.threadId);
    assignment.slot.activeCount -= 1;
    return true;
  }

  /** Release a crashed worker's ownership only after its durable interruption is acknowledged. */
  reconcileLost(execution: ExecutionIdentity, lease: ExecutionLease, receipt: ExecutionRecoveryReceipt): boolean {
    const assignment = this.currentAssignment(execution, lease);
    if (!assignment?.revoked || assignment.pendingCount !== 0
      || !validRecoveryReceipt(lease, receipt)) return false;
    this.byThread.delete(execution.threadId);
    assignment.slot.activeCount -= 1;
    return true;
  }

  /** Replace a failed slot only after its revoked executions have been reconciled. */
  replaceWorker(index: number): boolean {
    const slot = this.slots[index];
    if (this.stopped || !slot || slot.worker || slot.activeCount !== 0) return false;
    this.startWorker(slot);
    return true;
  }

  /** Stop admission and settle retained work without replaying external effects. */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const slot of this.slots) {
      slot.worker?.terminate();
      slot.worker = undefined;
      this.settleSlot(slot, "shutdown");
    }
    this.byThread.clear();
  }

  /** Return only counts, so telemetry cannot log provider or user content. */
  depth(): ExecutionMailboxDepth {
    return {
      pending: this.pendingCount,
      pendingBytes: this.pendingBytes,
      activeExecutions: this.byThread.size,
      workers: this.slots.map((slot) => ({
        index: slot.index,
        queued: [...slot.queues.values()].reduce((sum, queue) => sum + queue.length, 0),
        inFlight: slot.inFlight !== undefined,
      })),
    };
  }

  private chooseSlot(): Slot<ExecutionMailboxCommand<Work>, Result> | undefined {
    const available = this.slots.filter((slot) => slot.worker !== undefined);
    if (available.length === 0) return undefined;
    const least = Math.min(...available.map((slot) => slot.activeCount));
    for (let offset = 0; offset < this.slots.length; offset += 1) {
      const index = (this.nextSlotIndex + offset) % this.slots.length;
      const slot = this.slots[index];
      if (slot?.worker && slot.activeCount === least) {
        this.nextSlotIndex = (index + 1) % this.slots.length;
        return slot;
      }
    }
    return undefined;
  }

  private currentAssignment(execution: ExecutionIdentity, lease: ExecutionLease): Assignment<ExecutionMailboxCommand<Work>, Result> | undefined {
    const assignment = this.byThread.get(execution.threadId);
    if (!assignment || !sameIdentity(assignment.execution, execution) || !sameLease(assignment.lease, lease)) return undefined;
    return assignment;
  }

  private admissionDecision(
    assignment: Assignment<ExecutionMailboxCommand<Work>, Result>,
    command: ExecutionMailboxCommand<Work>,
    bytes: number,
  ): AdmissionDecision {
    if (!positiveInteger(bytes)) return { kind: "invalid-size" };
    const stop = command.kind === "stop";
    const control = stop || CONTROL_KINDS.has(command.kind);
    if (stop && assignment.stopping) return { kind: "stop-already-requested" };
    if (assignment.stopping && !control) return { kind: "stopping" };
    if (!this.hasCapacity(assignment, bytes, control)) return { kind: "overloaded" };
    return { kind: "accept", control, stop };
  }

  private hasCapacity(assignment: Assignment<ExecutionMailboxCommand<Work>, Result>, bytes: number, control: boolean): boolean {
    const limits = this.limits;
    if (this.pendingCount + 1 > limits.maxPending || this.pendingBytes + bytes > limits.maxPendingBytes) return false;
    if (assignment.pendingCount + 1 > limits.maxPerExecutionPending
      || assignment.pendingBytes + bytes > limits.maxPerExecutionBytes) return false;
    if (control) return true;
    return this.normalCount + 1 <= limits.maxPending - limits.reservedControl
      && this.normalBytes + bytes <= limits.maxPendingBytes - limits.reservedControlBytes
      && assignment.normalCount + 1 <= limits.maxPerExecutionPending - limits.reservedPerExecutionControl
      && assignment.normalBytes + bytes <= limits.maxPerExecutionBytes - limits.reservedPerExecutionControlBytes;
  }

  private retain(assignment: Assignment<ExecutionMailboxCommand<Work>, Result>, pending: Pending<ExecutionMailboxCommand<Work>, Result>): void {
    this.pendingCount += 1;
    this.pendingBytes += pending.byteLength;
    assignment.pendingCount += 1;
    assignment.pendingBytes += pending.byteLength;
    if (pending.control) return;
    this.normalCount += 1;
    this.normalBytes += pending.byteLength;
    assignment.normalCount += 1;
    assignment.normalBytes += pending.byteLength;
  }

  private settle(pending: Pending<ExecutionMailboxCommand<Work>, Result>, completion: ExecutionMailboxCompletion<Result>): void {
    const assignment = this.byThread.get(pending.request.execution.threadId);
    this.pendingCount -= 1;
    this.pendingBytes -= pending.byteLength;
    if (assignment && sameLease(assignment.lease, pending.request.lease)) {
      assignment.pendingCount -= 1;
      assignment.pendingBytes -= pending.byteLength;
      if (!pending.control) {
        assignment.normalCount -= 1;
        assignment.normalBytes -= pending.byteLength;
      }
    }
    if (!pending.control) {
      this.normalCount -= 1;
      this.normalBytes -= pending.byteLength;
    }
    pending.resolve(completion);
  }

  private enqueue(slot: Slot<ExecutionMailboxCommand<Work>, Result>, pending: Pending<ExecutionMailboxCommand<Work>, Result>): void {
    const threadId = pending.request.execution.threadId;
    const queue = slot.queues.get(threadId);
    if (queue) queue.push(pending);
    else {
      slot.queues.set(threadId, [pending]);
      slot.readyThreads.push(threadId);
    }
  }

  private dispatch(slot: Slot<ExecutionMailboxCommand<Work>, Result>): void {
    if (this.stopped || !slot.worker || slot.inFlight) return;
    const threadId = slot.readyThreads.shift();
    if (!threadId) return;
    const queue = slot.queues.get(threadId);
    const next = queue?.shift();
    if (!queue || !next) throw new Error("Mailbox ready list lost its queue");
    if (queue.length > 0) slot.readyThreads.push(threadId);
    else slot.queues.delete(threadId);
    slot.inFlight = next;
    try {
      slot.worker.postMessage(next.request);
    } catch {
      this.workerLost(slot, slot.generation);
    }
  }

  private startWorker(slot: Slot<ExecutionMailboxCommand<Work>, Result>): void {
    if (this.stopped) return;
    const generation = ++slot.generation;
    const worker = this.createWorker(slot.index);
    worker.onmessage = (event) => this.receive(slot, generation, event.data);
    worker.onerror = () => this.workerLost(slot, generation);
    worker.onclose = () => this.workerLost(slot, generation);
    slot.worker = worker;
  }

  private receive(slot: Slot<ExecutionMailboxCommand<Work>, Result>, generation: number, reply: ExecutionWorkerReply<Result>): void {
    if (this.stopped || slot.generation !== generation) return;
    const pending = slot.inFlight;
    if (!pending || !matchesReply(pending.request, reply)) {
      this.workerLost(slot, generation);
      return;
    }
    slot.inFlight = undefined;
    this.settle(pending, { kind: "reply", result: reply.result });
    this.dispatch(slot);
  }

  private workerLost(slot: Slot<ExecutionMailboxCommand<Work>, Result>, generation: number): void {
    if (this.stopped || slot.generation !== generation) return;
    const worker = slot.worker;
    slot.worker = undefined;
    slot.generation += 1;
    worker?.terminate();
    const revokedAssignments = [...this.byThread.values()].filter((assignment) => assignment.slot === slot);
    for (const assignment of revokedAssignments) assignment.revoked = true;
    const revoked = revokedAssignments.map((assignment) => ({ execution: assignment.execution, lease: assignment.lease }));
    this.settleSlot(slot, "worker-lost");
    this.onWorkerLost(revoked);
  }

  private settleSlot(slot: Slot<ExecutionMailboxCommand<Work>, Result>, kind: "worker-lost" | "shutdown"): void {
    const pending = [slot.inFlight, ...slot.queues.values()].flat().filter((item) => item !== undefined);
    slot.inFlight = undefined;
    slot.queues.clear();
    slot.readyThreads.length = 0;
    for (const item of pending) this.settle(item, { kind });
  }
}

function sameIdentity(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
  return left.threadId === right.threadId && left.turnId === right.turnId && left.executionId === right.executionId;
}

function sameLease(left: ExecutionLease, right: ExecutionLease): boolean {
  return left.ownerEpoch === right.ownerEpoch && left.workerIndex === right.workerIndex
    && left.workerGeneration === right.workerGeneration && left.leaseId === right.leaseId;
}

function validRecoveryReceipt(lease: ExecutionLease, receipt: ExecutionRecoveryReceipt): boolean {
  return receipt.operationId === `${lease.leaseId}:worker-lost`
    && (receipt.kind === "conflict" || Number.isSafeInteger(receipt.durableRevision));
}

function matchesReply<Command, Result>(request: ExecutionWorkerRequest<Command>, reply: ExecutionWorkerReply<Result>): boolean {
  return request.requestId === reply.requestId && request.ordinal === reply.ordinal
    && sameIdentity(request.execution, reply.execution) && sameLease(request.lease, reply.lease);
}

function validIdentity(execution: ExecutionIdentity): boolean {
  return execution.threadId.length > 0 && execution.turnId.length > 0 && execution.executionId.length > 0;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validateOptions<Work extends { readonly kind: string }, Result>(options: ExecutionMailboxOptions<Work, Result>): void {
  const limits = options.limits;
  const values = [options.workerCount, limits.maxPending, limits.maxPendingBytes, limits.maxPerExecutionPending,
    limits.maxPerExecutionBytes, limits.reservedControl, limits.reservedControlBytes,
    limits.reservedPerExecutionControl, limits.reservedPerExecutionControlBytes];
  if (values.some((value) => !positiveInteger(value))) throw new Error("Mailbox limits must be positive safe integers");
  if (limits.reservedControl >= limits.maxPending || limits.reservedControlBytes >= limits.maxPendingBytes
    || limits.reservedPerExecutionControl >= limits.maxPerExecutionPending
    || limits.reservedPerExecutionControlBytes >= limits.maxPerExecutionBytes) {
    throw new Error("Mailbox control reserves must leave normal capacity");
  }
}
