import type { TurnOutcome } from "@mcode/contracts";
import type { ProviderEventDraft } from "@mcode/providers";

import type {
  DataOnlyParentTerminalProjectionInput,
  DataOnlyParentTurnFinishInput,
  DataOnlyParentTurnStartInput,
} from "../canonical/canonical-parent-turn-write.js";
import type {
  ExecutionIdentity,
  ExecutionLease,
  ExecutionWorkerReply,
  ExecutionWorkerRequest,
} from "./execution-mailbox-protocol.js";
import type { ExecutionMailboxCommand } from "./execution-mailbox-scheduler.js";

/** Data that an execution worker may receive without a server dependency container. */
export type ExecutionWorkCommand =
  | { readonly kind: "start"; readonly providerId: string; readonly input: DataOnlyParentTurnStartInput }
  | { readonly kind: "resume"; readonly providerId: string; readonly checkpointId: string }
  | { readonly kind: "event"; readonly phase: string; readonly nativeCursor: unknown | null; readonly events: readonly ProviderEventDraft[] }
  | { readonly kind: "checkpoint"; readonly phase: string; readonly nativeCursor: unknown | null }
  | { readonly kind: "effect-result"; readonly effectId: string; readonly settled: boolean }
  | { readonly kind: "provider-outcome"; readonly outcome: TurnOutcome }
  | { readonly kind: "stage-terminal"; readonly input: DataOnlyParentTerminalProjectionInput }
  | { readonly kind: "finalize"; readonly outcome: TurnOutcome; readonly input: DataOnlyParentTurnFinishInput }
  | { readonly kind: "release" };

/** One complete semantic mutation. The single writer decides its SQL transaction. */
export interface ExecutionSemanticOperation {
  readonly operationId: string;
  readonly execution: ExecutionIdentity;
  readonly lease: ExecutionLease;
  readonly ordinal: number;
  readonly mutation:
    | { readonly kind: "begin"; readonly providerId: string; readonly input: DataOnlyParentTurnStartInput }
    | { readonly kind: "resume"; readonly providerId: string; readonly checkpointId: string }
    | { readonly kind: "append-events"; readonly phase: string; readonly nativeCursor: unknown | null; readonly events: readonly ProviderEventDraft[] }
    | { readonly kind: "checkpoint"; readonly phase: string; readonly nativeCursor: unknown | null }
    | { readonly kind: "stop-requested"; readonly requestId: string; readonly lastAdmittedOrdinal: number }
    | { readonly kind: "effect-result"; readonly effectId: string; readonly settled: boolean }
    | { readonly kind: "provider-outcome"; readonly outcome: TurnOutcome }
    | { readonly kind: "stage-terminal"; readonly input: DataOnlyParentTerminalProjectionInput }
    | { readonly kind: "finish"; readonly outcome: TurnOutcome; readonly input: DataOnlyParentTurnFinishInput };
}

/** A writer reply is valid only after the semantic operation commits durably. */
export type ExecutionWriteReceipt =
  | { readonly kind: "committed"; readonly operationId: string; readonly durableRevision: number }
  | { readonly kind: "conflict"; readonly operationId: string };

/**
 * Implemented by one acknowledged writer, not by a worker-local SQLite connection.
 * It must fence the durable lease and enforce terminal prerequisites in the
 * same transaction that records each semantic operation.
 */
export interface ExecutionSemanticWriter {
  transact(operation: ExecutionSemanticOperation): Promise<ExecutionWriteReceipt>;
}

/** A command result that never calls an uncommitted mutation successful. */
export type ExecutionWorkerResult =
  | { readonly kind: "committed"; readonly operationId: string; readonly durableRevision: number }
  | { readonly kind: "released" }
  | { readonly kind: "rejected"; readonly reason: "no-execution" | "stale-execution" | "out-of-order" | "invalid-transition" | "invalid-event-routing" | "invalid-stop-watermark" | "writer-conflict" };

type WorkerCommand = ExecutionMailboxCommand<ExecutionWorkCommand>;
const METADATA_MUTATIONS: ReadonlySet<WorkerCommand["kind"]> = new Set([
  "checkpoint", "effect-result", "provider-outcome", "stage-terminal",
]);

interface ExecutionState {
  readonly execution: ExecutionIdentity;
  readonly lease: ExecutionLease;
  readonly providerId: string;
  nextOrdinal: number;
  phase: "running" | "stopping" | "finalized";
  durableRevision: number;
}

/**
 * Applies one worker command at a time per slot. This module has no database
 * handle, provider process, or publication callback. It only advances state
 * after the single writer acknowledges the semantic operation.
 */
export class ExecutionWorkerHandler {
  private readonly states = new Map<string, ExecutionState>();

  constructor(private readonly writer: ExecutionSemanticWriter) {}

  /** Process one mailbox command and echo its exact execution and lease. */
  async handle(request: ExecutionWorkerRequest<WorkerCommand>): Promise<ExecutionWorkerReply<ExecutionWorkerResult>> {
    const result = await this.apply(request);
    return {
      requestId: request.requestId,
      execution: request.execution,
      lease: request.lease,
      ordinal: request.ordinal,
      result,
    };
  }

  private async apply(request: ExecutionWorkerRequest<WorkerCommand>): Promise<ExecutionWorkerResult> {
    const state = this.states.get(request.execution.threadId);
    if (request.command.kind === "start" || request.command.kind === "resume") {
      return await this.begin(request, state);
    }
    if (!state) return { kind: "rejected", reason: "no-execution" };
    return await this.applyToState(request, state);
  }

  private async applyToState(
    request: ExecutionWorkerRequest<WorkerCommand>,
    state: ExecutionState,
  ): Promise<ExecutionWorkerResult> {
    const rejection = commandRejection(request, state);
    if (rejection) return { kind: "rejected", reason: rejection };
    if (request.command.kind === "release") return this.release(request, state);
    if (state.phase === "finalized") return { kind: "rejected", reason: "invalid-transition" };
    const mutation = mutationFor(request, state);
    if (!mutation) return { kind: "rejected", reason: invalidReason(request) };
    const receipt = await this.writer.transact(operationFor(request, mutation));
    if (!isDurableReceipt(receipt, request, state.durableRevision)) {
      return { kind: "rejected", reason: "writer-conflict" };
    }
    state.nextOrdinal += 1;
    state.durableRevision = receipt.durableRevision;
    if (request.command.kind === "stop") state.phase = "stopping";
    if (request.command.kind === "finalize") state.phase = "finalized";
    return { kind: "committed", operationId: receipt.operationId, durableRevision: receipt.durableRevision };
  }

  private async begin(
    request: ExecutionWorkerRequest<WorkerCommand>,
    existing: ExecutionState | undefined,
  ): Promise<ExecutionWorkerResult> {
    if (existing) return { kind: "rejected", reason: "invalid-transition" };
    if (request.ordinal !== 1) return { kind: "rejected", reason: "out-of-order" };
    const command = request.command;
    if (command.kind !== "start" && command.kind !== "resume") return { kind: "rejected", reason: "invalid-transition" };
    if (command.kind === "start" && !validStartInput(command, request.execution)) {
      return { kind: "rejected", reason: "invalid-transition" };
    }
    const mutation: ExecutionSemanticOperation["mutation"] = command.kind === "start"
      ? { kind: "begin", providerId: command.providerId, input: command.input }
      : { kind: "resume", providerId: command.providerId, checkpointId: command.checkpointId };
    const receipt = await this.writer.transact(operationFor(request, mutation));
    if (!isDurableReceipt(receipt, request, 0)) {
      return { kind: "rejected", reason: "writer-conflict" };
    }
    this.states.set(request.execution.threadId, {
      execution: request.execution,
      lease: request.lease,
      providerId: command.providerId,
      nextOrdinal: 2,
      phase: "running",
      durableRevision: receipt.durableRevision,
    });
    return { kind: "committed", operationId: receipt.operationId, durableRevision: receipt.durableRevision };
  }

  private release(request: ExecutionWorkerRequest<WorkerCommand>, state: ExecutionState): ExecutionWorkerResult {
    if (state.phase !== "finalized") return { kind: "rejected", reason: "invalid-transition" };
    this.states.delete(request.execution.threadId);
    return { kind: "released" };
  }
}

function mutationFor(
  request: ExecutionWorkerRequest<WorkerCommand>,
  state: ExecutionState,
): ExecutionSemanticOperation["mutation"] | undefined {
  const command = request.command;
  if (isMetadataMutation(command)) return command;
  switch (command.kind) {
    case "event":
      return eventMutation(command, request.execution, state);
    case "stop":
      return stopMutation(command, request, state);
    case "finalize":
      return finishMutation(command, request.execution, state.providerId);
    case "start":
    case "resume":
    case "release":
      return undefined;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function isMetadataMutation(command: WorkerCommand): command is Extract<
  WorkerCommand,
  { readonly kind: "checkpoint" | "effect-result" | "provider-outcome" | "stage-terminal" }
> {
  return METADATA_MUTATIONS.has(command.kind);
}

function eventMutation(
  command: Extract<WorkerCommand, { kind: "event" }>,
  execution: ExecutionIdentity,
  state: ExecutionState,
): ExecutionSemanticOperation["mutation"] | undefined {
  if (state.phase !== "running" || !validEventRouting(command.events, execution)) return undefined;
  return { kind: "append-events", phase: command.phase, nativeCursor: command.nativeCursor, events: command.events };
}

function stopMutation(
  command: Extract<WorkerCommand, { kind: "stop" }>,
  request: ExecutionWorkerRequest<WorkerCommand>,
  state: ExecutionState,
): ExecutionSemanticOperation["mutation"] | undefined {
  if (state.phase !== "running" || request.stopWatermark !== request.ordinal - 1) return undefined;
  return { kind: "stop-requested", requestId: command.requestId, lastAdmittedOrdinal: request.stopWatermark };
}

function finishMutation(
  command: Extract<WorkerCommand, { kind: "finalize" }>,
  execution: ExecutionIdentity,
  providerId: string,
): ExecutionSemanticOperation["mutation"] | undefined {
  if (!validFinishInput(command, execution, providerId)) return undefined;
  return { kind: "finish", outcome: command.outcome, input: command.input };
}

function commandRejection(
  request: ExecutionWorkerRequest<WorkerCommand>,
  state: ExecutionState,
): Extract<ExecutionWorkerResult, { kind: "rejected" }>["reason"] | null {
  if (!sameIdentity(state.execution, request.execution) || !sameLease(state.lease, request.lease)) return "stale-execution";
  if (request.ordinal !== state.nextOrdinal) return "out-of-order";
  return null;
}

function invalidReason(request: ExecutionWorkerRequest<WorkerCommand>): Extract<ExecutionWorkerResult, { kind: "rejected" }>["reason"] {
  if (request.command.kind === "stop" && request.stopWatermark !== request.ordinal - 1) return "invalid-stop-watermark";
  if (request.command.kind === "event" && !validEventRouting(request.command.events, request.execution)) {
    return "invalid-event-routing";
  }
  return "invalid-transition";
}

function validEventRouting(events: readonly ProviderEventDraft[], execution: ExecutionIdentity): boolean {
  return events.length > 0 && events.every((event) => event.routing.threadId === execution.threadId
    && event.routing.turnId === execution.turnId && event.routing.executionId === execution.executionId);
}

function validStartInput(
  command: Extract<ExecutionWorkCommand, { kind: "start" }>,
  execution: ExecutionIdentity,
): boolean {
  return command.providerId === command.input.thread.providerId
    && command.input.thread.id === execution.threadId
    && command.input.turnId === execution.turnId
    && command.input.executionId === execution.executionId;
}

function validFinishInput(
  command: Extract<ExecutionWorkCommand, { kind: "finalize" }>,
  execution: ExecutionIdentity,
  providerId: string,
): boolean {
  return command.outcome === command.input.outcome
    && command.input.providerId === providerId
    && command.input.threadId === execution.threadId
    && command.input.turnId === execution.turnId
    && command.input.executionId === execution.executionId;
}

function operationFor(
  request: ExecutionWorkerRequest<WorkerCommand>,
  mutation: ExecutionSemanticOperation["mutation"],
): ExecutionSemanticOperation {
  return {
    operationId: operationId(request),
    execution: request.execution,
    lease: request.lease,
    ordinal: request.ordinal,
    mutation,
  };
}

function operationId(request: ExecutionWorkerRequest<WorkerCommand>): string {
  return `${request.lease.leaseId}:${request.ordinal}`;
}

function isDurableReceipt(
  receipt: ExecutionWriteReceipt,
  request: ExecutionWorkerRequest<WorkerCommand>,
  previousRevision: number,
): receipt is Extract<ExecutionWriteReceipt, { kind: "committed" }> {
  return receipt.kind === "committed" && receipt.operationId === operationId(request)
    && Number.isSafeInteger(receipt.durableRevision) && receipt.durableRevision >= previousRevision;
}

function sameIdentity(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
  return left.threadId === right.threadId && left.turnId === right.turnId && left.executionId === right.executionId;
}

function sameLease(left: ExecutionLease, right: ExecutionLease): boolean {
  return left.ownerEpoch === right.ownerEpoch && left.workerIndex === right.workerIndex
    && left.workerGeneration === right.workerGeneration && left.leaseId === right.leaseId;
}
