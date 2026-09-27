/** The exact turn attempt that owns every command and reply in a mailbox. */
export interface ExecutionIdentity {
  readonly threadId: string;
  readonly turnId: string;
  readonly executionId: string;
}

/** A durable owner epoch plus the local worker incarnation that may use it. */
export interface ExecutionLease {
  readonly ownerEpoch: number;
  readonly workerIndex: number;
  readonly workerGeneration: number;
  readonly leaseId: string;
}

/** One ordered, data-only command sent to the worker that owns an execution. */
export interface ExecutionWorkerRequest<Command> {
  readonly requestId: number;
  readonly execution: ExecutionIdentity;
  readonly lease: ExecutionLease;
  readonly ordinal: number;
  /** Last admitted ordinal before Stop. Present only on a Stop request. */
  readonly stopWatermark?: number;
  readonly command: Command;
}

/** A reply must echo the complete identity and lease before it can be accepted. */
export interface ExecutionWorkerReply<Result> {
  readonly requestId: number;
  readonly execution: ExecutionIdentity;
  readonly lease: ExecutionLease;
  readonly ordinal: number;
  readonly result: Result;
}

/** A worker reply is transport completion; the result defines durable success or failure. */
export type ExecutionMailboxCompletion<Result> =
  | { readonly kind: "reply"; readonly result: Result }
  | { readonly kind: "worker-lost" }
  | { readonly kind: "shutdown" };

/** The worker port used by the fixed execution mailbox scheduler. */
export interface ExecutionWorkerPort<Command, Result> {
  onmessage: ((event: MessageEvent<ExecutionWorkerReply<Result>>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onclose: (() => void) | null;
  postMessage(request: ExecutionWorkerRequest<Command>): void;
  terminate(): void;
}

/** Identity fields carried by inbound provider routing, where the turn may be unresolved. */
export type RoutedExecutionIdentity = Omit<ExecutionIdentity, "turnId"> & { readonly turnId?: string | undefined };

/** Two executions match only when every durable identity field agrees. */
export function sameExecution(left: RoutedExecutionIdentity, right: ExecutionIdentity): boolean {
  return left.threadId === right.threadId && left.turnId === right.turnId && left.executionId === right.executionId;
}

/** Two leases match only when the epoch, worker incarnation, and lease id all agree. */
export function sameLease(left: ExecutionLease, right: ExecutionLease): boolean {
  return left.ownerEpoch === right.ownerEpoch && left.workerIndex === right.workerIndex
    && left.workerGeneration === right.workerGeneration && left.leaseId === right.leaseId;
}
