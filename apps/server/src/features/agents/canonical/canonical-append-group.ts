import type { ExecutionSemanticOperation } from "../execution/execution-worker-handler.js";
import type { CanonicalWriterRequest } from "./canonical-agent-writer-protocol.js";

/** Bounds one physical commit without waiting for more append requests. */
export const APPEND_GROUP_LIMITS = { operations: 8, bytes: 512 * 1024, elapsedMs: 16 } as const;

/** Reclassification removes a recovery journal after committing, so it remains a separate write. */
export function isGroupableAppend(operation: ExecutionSemanticOperation): boolean {
  return operation.mutation.kind === "append-events"
    && operation.mutation.parentLive?.text.kind !== "reclassify";
}

/** Request bytes are measured once when the request enters the worker queue. */
export interface QueuedCanonicalWrite {
  readonly request: CanonicalWriterRequest;
  readonly bytes: number;
}

/** Select a FIFO prefix of independent appends; controls and repeated identities are barriers. */
export function selectAppendGroup(queue: readonly QueuedCanonicalWrite[]): Extract<CanonicalWriterRequest, { kind: "semantic-transact" }>[] {
  const requests: Extract<CanonicalWriterRequest, { kind: "semantic-transact" }>[] = [];
  const executions = new Set<string>();
  let bytes = 0;
  for (const queued of queue) {
    const request = queued.request;
    if (request.kind !== "semantic-transact" || !isGroupableAppend(request.operation)
      || request.operationId !== request.operation.operationId
      || request.executionId !== request.operation.execution.executionId
      || executions.has(request.executionId)
      || requests.length === APPEND_GROUP_LIMITS.operations
      || bytes + queued.bytes > APPEND_GROUP_LIMITS.bytes) break;
    requests.push(request);
    executions.add(request.executionId);
    bytes += queued.bytes;
  }
  return requests;
}
