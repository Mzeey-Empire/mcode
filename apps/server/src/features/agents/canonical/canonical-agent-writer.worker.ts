import "reflect-metadata";
import { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { applySQLiteConnectionPolicy } from "../../../runtime/persistence/sqlite/sqlite-connection-policy.js";
import { CanonicalAgentBoundary } from "./canonical-agent-boundary.js";
import { CanonicalExecutionSemanticWriter } from "./canonical-execution-semantic-writer.js";
import { ParentAssistantTextCheckpointService } from "../turns/parent-assistant-text-checkpoint-service.js";
import { CanonicalAgentWriterReceipts, CanonicalWriterOperationConflict, CanonicalWriterReceiptCapacity } from "./canonical-agent-writer-receipts.js";
import type {
  CanonicalParentNarrativeClassificationReceipt,
  CanonicalProviderWriteInput,
  CanonicalWriterRequest,
  CanonicalWriterResponse,
} from "./canonical-agent-writer-protocol.js";
import type { ParentNarrativeRecoveryCommitInput } from "./canonical-agent-boundary.js";

let db: Database | undefined;
let boundary: CanonicalAgentBoundary | undefined;
let assistantTextCheckpoints: ParentAssistantTextCheckpointService | undefined;
let receipts: CanonicalAgentWriterReceipts | undefined;
let semanticWriter: CanonicalExecutionSemanticWriter | undefined;
const PUBLICATION_PAGE_SIZE = 64;
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
      for (let offset = 0; offset < events.length; offset += PUBLICATION_PAGE_SIZE) {
        globalThis.postMessage({
          ...correlation,
          kind: "semantic-publication",
          events: events.slice(offset, offset + PUBLICATION_PAGE_SIZE),
        } satisfies CanonicalWriterResponse);
      }
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
    if (!semanticWriter || semanticPublication) throw new Error("Semantic writer is not ready");
    if (request.kind === "semantic-transact"
      ? request.operation.operationId !== request.operationId
        || request.operation.execution.executionId !== request.executionId
      : `${request.input.lease.leaseId}:worker-lost` !== request.operationId
        || request.input.execution.executionId !== request.executionId) {
      throw new Error("Semantic writer request identity mismatch");
    }
    semanticPublication = correlation;
    const receipt = request.kind === "semantic-transact"
      ? await semanticWriter.transact(request.operation)
      : semanticWriter.interruptWorkerLoss(request.input);
    return { ...correlation, kind: "semantic-transacted", receipt };
  } catch {
    return { ...correlation, kind: "failed", reason: "write-failed" };
  } finally {
    semanticPublication = undefined;
  }
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

let requestTail = Promise.resolve();
globalThis.onmessage = (message: MessageEvent<CanonicalWriterRequest>): void => {
  const request = message.data;
  requestTail = requestTail.then(async () => {
    try {
      globalThis.postMessage(await handle(request));
    } catch (error) {
      console.error("Canonical writer request failed unexpectedly", error);
      globalThis.postMessage({
        requestId: request.requestId,
        operationId: request.operationId,
        executionId: request.executionId,
        kind: "failed",
        reason: "write-failed",
      } satisfies CanonicalWriterResponse);
    }
  });
};

process.on("exit", () => db?.close(true));
