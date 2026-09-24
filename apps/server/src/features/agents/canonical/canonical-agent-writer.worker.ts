import "reflect-metadata";
import { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { applySQLiteConnectionPolicy } from "../../../runtime/persistence/sqlite/sqlite-connection-policy.js";
import { CanonicalAgentBoundary } from "./canonical-agent-boundary.js";
import { ParentAssistantTextCheckpointService } from "../turns/parent-assistant-text-checkpoint-service.js";
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

function openDatabase(dbPath: string): void {
  if (boundary || !NodePath.isAbsolute(dbPath) || !NodeFS.existsSync(dbPath)) {
    throw new Error("Canonical writer requires an existing absolute database path");
  }
  const connection = new Database(dbPath, { strict: true, readwrite: true });
  try {
    applySQLiteConnectionPolicy(connection, true);
    boundary = new CanonicalAgentBoundary(connection, () => {});
    assistantTextCheckpoints = new ParentAssistantTextCheckpointService(connection);
    db = connection;
  } catch (error) {
    boundary = undefined;
    assistantTextCheckpoints = undefined;
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

function handle(request: CanonicalWriterRequest): CanonicalWriterResponse {
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
    db?.close(true);
    db = undefined;
    return { ...correlation, kind: "closed" };
  }
  return handleWrite(request, correlation);
}

function handleWrite(
  request: Extract<CanonicalWriterRequest, { kind: "commit" | "record-parent-narrative-recovery" | "classify-parent-narrative-recovery" }>,
  correlation: Pick<CanonicalWriterRequest, "requestId" | "operationId" | "executionId">,
): CanonicalWriterResponse {
  try {
    if (!boundary) throw new Error("Canonical writer has not opened its database");
    if (request.kind === "classify-parent-narrative-recovery") {
      if (request.input.executionId !== request.executionId) {
        throw new Error("Canonical writer classification execution mismatch");
      }
      const receipt = classifyParentNarrativeRecovery(request.input);
      return { ...correlation, kind: "parent-narrative-recovery-classified", receipt };
    }
    if (request.kind === "record-parent-narrative-recovery") {
      if (request.input.executionId !== request.executionId) {
        throw new Error("Canonical writer recovery execution mismatch");
      }
      const recorded = boundary.recordParentNarrativeRecovery(request.input);
      return {
        ...correlation,
        kind: "parent-narrative-recovery-recorded",
        receipt: { recorded },
      };
    }
    assertRouting(request.input, request.executionId);
    const result = boundary.commit(request.input);
    const { outcome, conversationRevision, rosterRevision, acceptedThrough, durableThrough, events } = result;
    return {
      ...correlation,
      kind: "committed",
      receipt: { outcome, conversationRevision, rosterRevision, acceptedThrough, durableThrough, events },
    };
  } catch {
    return { ...correlation, kind: "failed", reason: "write-failed" };
  }
}

globalThis.onmessage = (message: MessageEvent<CanonicalWriterRequest>): void => {
  globalThis.postMessage(handle(message.data));
};

process.on("exit", () => db?.close(true));
