import "reflect-metadata";
import { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { applySQLiteConnectionPolicy } from "../../../runtime/persistence/sqlite/sqlite-connection-policy.js";
import { CanonicalAgentBoundary } from "./canonical-agent-boundary.js";
import { CanonicalExecutionSemanticWriter } from "./canonical-execution-semantic-writer.js";
import { isGroupableAppend, selectAppendGroup, type QueuedCanonicalWrite } from "./canonical-append-group.js";
import type { CanonicalAgentEventPublisher } from "./canonical-agent-boundary.js";
import { ParentAssistantTextCheckpointService } from "../turns/parent-assistant-text-checkpoint-service.js";
import { CanonicalAgentWriterReceipts, CanonicalWriterOperationConflict, CanonicalWriterReceiptCapacity } from "./canonical-agent-writer-receipts.js";
import type {
  CanonicalParentNarrativeClassificationReceipt,
  CanonicalProviderWriteInput,
  CanonicalWriterRequest,
  CanonicalWriterResponse,
} from "./canonical-agent-writer-protocol.js";
import { SEMANTIC_PUBLICATION_PAGE_SIZE } from "./canonical-agent-writer-protocol.js";
import type { ParentNarrativeRecoveryCommitInput } from "./canonical-agent-boundary.js";

let db: Database | undefined;
let boundary: CanonicalAgentBoundary | undefined;
let assistantTextCheckpoints: ParentAssistantTextCheckpointService | undefined;
let receipts: CanonicalAgentWriterReceipts | undefined;
let semanticWriter: CanonicalExecutionSemanticWriter | undefined;
let semanticPublication: Pick<CanonicalWriterRequest, "requestId" | "operationId" | "executionId"> | undefined;

function openDatabase(dbPath: string): void {
  if (boundary || !NodePath.isAbsolute(dbPath) || !NodeFS.existsSync(dbPath)) {
    throw new Error("Canonical writer requires an existing absolute database path");
  }
  const connection = new Database(dbPath, { strict: true, readwrite: true });
  try {
    applySQLiteConnectionPolicy(connection, true);
    boundary = new CanonicalAgentBoundary(connection, () => {});
    assistantTextCheckpoints = new ParentAssistantTextCheckpointService(connection);
    receipts = new CanonicalAgentWriterReceipts(connection);
    semanticWriter = new CanonicalExecutionSemanticWriter(connection, (events) => {
      const correlation = semanticPublication;
      if (!correlation) throw new Error("Semantic publication has no active request");
      publishSemantic(correlation, events);
    });
    db = connection;
  } catch (error) {
    boundary = undefined;
    assistantTextCheckpoints = undefined;
    receipts = undefined;
    semanticWriter = undefined;
    connection.close(true);
    throw error;
  }
}

function classifyParentNarrativeRecovery(
  input: ParentNarrativeRecoveryCommitInput,
): CanonicalParentNarrativeClassificationReceipt {
  const connection = db;
  const canonical = boundary;
  const checkpoints = assistantTextCheckpoints;
  if (!connection || !canonical || !checkpoints) throw new Error("Canonical writer has not opened its database");
  return connection.transaction(() => {
    const recorded = canonical.recordParentNarrativeRecovery(input);
    if (!recorded) throw new Error("Canonical parent turn was not found");
    const reset = checkpoints.resetInTransaction(input.executionId);
    if (!reset) throw new Error("Provisional assistant text checkpoint was not reset");
    return { recorded, reset };
  })();
}

function assertRouting(input: CanonicalProviderWriteInput, executionId: string): void {
  if (input.executionId !== executionId || !input.threadId || !input.turnId || !input.phase
    || !Array.isArray(input.events) || input.events.length === 0) {
    throw new Error("Invalid canonical writer request");
  }
  if (!input.events.every((event) => eventMatchesRouting(event, input, executionId))) {
    throw new Error("Canonical writer event routing mismatch");
  }
}

function eventMatchesRouting(
  event: CanonicalProviderWriteInput["events"][number],
  input: CanonicalProviderWriteInput,
  executionId: string,
): boolean {
  return event.routing.threadId === input.threadId
    && event.routing.executionId === executionId
    && (event.routing.turnId === undefined || event.routing.turnId === input.turnId);
}

async function handle(request: CanonicalWriterRequest): Promise<CanonicalWriterResponse> {
  const correlation = {
    requestId: request.requestId,
    operationId: request.operationId,
    executionId: request.executionId,
  };
  if (request.kind === "open") {
    try {
      openDatabase(request.dbPath);
      return { ...correlation, kind: "opened" };
    } catch {
      return { ...correlation, kind: "failed", reason: "open-failed" };
    }
  }
  if (request.kind === "close") {
    boundary = undefined;
    assistantTextCheckpoints = undefined;
    receipts = undefined;
    semanticWriter = undefined;
    db?.close(true);
    db = undefined;
    return { ...correlation, kind: "closed" };
  }
  if (request.kind === "ack-operation") {
    try {
      if (!receipts) throw new Error("Canonical writer has not opened its database");
      receipts.acknowledge(request.executionId, request.operationId);
      return { ...correlation, kind: "operation-acknowledged" };
    } catch {
      return { ...correlation, kind: "failed", reason: "write-failed" };
    }
  }
  if (request.kind === "semantic-transact" || request.kind === "semantic-worker-loss") {
    return handleSemanticWrite(request, correlation);
  }
  return handleWrite(request, correlation);
}

async function handleSemanticWrite(
  request: Extract<CanonicalWriterRequest, { kind: "semantic-transact" | "semantic-worker-loss" }>,
  correlation: Pick<CanonicalWriterRequest, "requestId" | "operationId" | "executionId">,
): Promise<CanonicalWriterResponse> {
  try {
    const writer = semanticWriter;
    if (!writer || semanticPublication) throw new Error("Semantic writer is not ready");
    if (request.kind === "semantic-transact"
      ? request.operation.operationId !== request.operationId
        || request.operation.execution.executionId !== request.executionId
      : `${request.input.lease.leaseId}:worker-lost` !== request.operationId
        || request.input.execution.executionId !== request.executionId) {
      throw new Error("Semantic writer request identity mismatch");
    }
    semanticPublication = correlation;
    const receipt = request.kind === "semantic-transact"
      ? await withSQLiteBusyRetry(() => writer.transact(request.operation))
      : await withSQLiteBusyRetry(() => writer.interruptWorkerLoss(request.input));
    return { ...correlation, kind: "semantic-transacted", receipt };
  } catch {
    return { ...correlation, kind: "failed", reason: "write-failed" };
  } finally {
    semanticPublication = undefined;
  }
}

function publishSemantic(
  correlation: Pick<CanonicalWriterRequest, "requestId" | "operationId" | "executionId">,
  events: Parameters<CanonicalAgentEventPublisher>[0],
): void {
  for (let offset = 0; offset < events.length; offset += SEMANTIC_PUBLICATION_PAGE_SIZE) {
    globalThis.postMessage({ ...correlation, kind: "semantic-publication",
      events: events.slice(offset, offset + SEMANTIC_PUBLICATION_PAGE_SIZE) } satisfies CanonicalWriterResponse);
  }
}

async function withSQLiteBusyRetry<T>(work: () => Promise<T> | T): Promise<T> {
  const delaysMs = [10, 30, 90, 270, 500];
  for (const delayMs of delaysMs) {
    try {
      return await work();
    } catch (error) {
      if (!isSQLiteBusy(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return work();
}

function isSQLiteBusy(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && typeof error.code === "string" && error.code.startsWith("SQLITE_BUSY");
}

async function handleWrite(
  request: Extract<CanonicalWriterRequest, { kind: "commit" | "record-parent-narrative-recovery" | "classify-parent-narrative-recovery" }>,
  correlation: Pick<CanonicalWriterRequest, "requestId" | "operationId" | "executionId">,
): Promise<CanonicalWriterResponse> {
  try {
    const canonical = boundary;
    if (!canonical || !receipts) throw new Error("Canonical writer has not opened its database");
    if (request.kind === "record-parent-narrative-recovery") {
      if (request.input.executionId !== request.executionId) {
        throw new Error("Canonical writer recovery execution mismatch");
      }
      return await receipts.executeBatchedRecovery(request, async () => ({
        ...correlation,
        kind: "parent-narrative-recovery-recorded",
        receipt: { recorded: await canonical.recordParentNarrativeRecoveryYielding(request.input) },
      }));
    }
    return receipts.execute(request, () => applyWrite(request, correlation, canonical));
  } catch (error) {
    return {
      ...correlation,
      kind: "failed",
      reason: error instanceof CanonicalWriterOperationConflict ? "operation-conflict"
        : error instanceof CanonicalWriterReceiptCapacity ? "receipt-capacity" : "write-failed",
    };
  }
}

function applyWrite(
  request: Extract<CanonicalWriterRequest, { kind: "commit" | "classify-parent-narrative-recovery" }>,
  correlation: Pick<CanonicalWriterRequest, "requestId" | "operationId" | "executionId">,
  canonical: CanonicalAgentBoundary,
): Extract<CanonicalWriterResponse, { kind: "committed" | "parent-narrative-recovery-recorded" | "parent-narrative-recovery-classified" }> {
  if (request.kind === "classify-parent-narrative-recovery") {
    if (request.input.executionId !== request.executionId) {
      throw new Error("Canonical writer classification execution mismatch");
    }
    const receipt = classifyParentNarrativeRecovery(request.input);
    return { ...correlation, kind: "parent-narrative-recovery-classified", receipt };
  }
  assertRouting(request.input, request.executionId);
  const result = canonical.commit(request.input);
  const { outcome, conversationRevision, rosterRevision, acceptedThrough, durableThrough, events } = result;
  return {
    ...correlation,
    kind: "committed",
    receipt: { outcome, conversationRevision, rosterRevision, acceptedThrough, durableThrough, events },
  };
}

const requestQueue: QueuedCanonicalWrite[] = [];
let draining = false;

function failRequest(request: CanonicalWriterRequest): void {
  globalThis.postMessage({ requestId: request.requestId, operationId: request.operationId,
    executionId: request.executionId, kind: "failed", reason: "write-failed" } satisfies CanonicalWriterResponse);
}

async function handleAppendGroup(requests: Extract<CanonicalWriterRequest, { kind: "semantic-transact" }>[]): Promise<number> {
  const first = requests[0];
  if (!first) return 0;
  let results: ReturnType<CanonicalExecutionSemanticWriter["transactAppendGroup"]>;
  try {
    const writer = semanticWriter;
    if (!writer || semanticPublication) throw new Error("Semantic writer is not ready");
    results = await withSQLiteBusyRetry(
      () => writer.transactAppendGroup(requests.map((request) => request.operation)));
  } catch {
    // A rolled-back peer must not inherit another execution's write failure.
    // Replaying semantic operations is safe because their durable receipts fence duplicates.
    for (const request of requests) await handleSingleRequest(request);
    return requests.length;
  }
  for (const [index, result] of results.entries()) {
    const request = requests[index];
    if (!request) throw new Error("Semantic append group lost its request");
    const correlation = { requestId: request.requestId, operationId: request.operationId, executionId: request.executionId };
    for (const events of result.publications) publishSemantic(correlation, events);
    globalThis.postMessage({ ...correlation, kind: "semantic-transacted", receipt: result.receipt } satisfies CanonicalWriterResponse);
  }
  return results.length;
}

async function handleSingleRequest(request: CanonicalWriterRequest): Promise<void> {
  const response = await handle(request);
  globalThis.postMessage(response);
}

async function drainRequests(): Promise<void> {
  const queued = requestQueue[0];
  if (!queued) { draining = false; return; }
  const request = queued.request;
  let consumed = 1;
  try {
    const group = selectAppendGroup(requestQueue);
    if (group.length > 1) consumed = await handleAppendGroup(group);
    else await handleSingleRequest(request);
  } catch (error) {
    console.error("Canonical writer request failed unexpectedly", error);
    failRequest(request);
  } finally {
    requestQueue.splice(0, consumed);
    if (requestQueue.length > 0) setImmediate(() => { void drainRequests(); });
    else draining = false;
  }
}

globalThis.onmessage = (message: MessageEvent<CanonicalWriterRequest>): void => {
  const request = message.data;
  try {
    requestQueue.push({ request,
      bytes: request.kind === "semantic-transact" && isGroupableAppend(request.operation)
        ? Buffer.byteLength(JSON.stringify(request.operation), "utf8") : 0 });
  } catch {
    failRequest(request);
    return;
  }
  if (!draining) {
    draining = true;
    // Collect already-ready messages without waiting for a group to fill.
    setImmediate(() => { void drainRequests(); });
  }
};

process.on("exit", () => db?.close(true));
