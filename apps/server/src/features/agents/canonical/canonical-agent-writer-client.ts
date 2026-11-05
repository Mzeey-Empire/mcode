import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import * as NodeCrypto from "node:crypto";
import { logger } from "@mcode/shared";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import type {
  CanonicalParentNarrativeClassificationReceipt,
  CanonicalParentNarrativeRecoveryReceipt,
  CanonicalProviderWriteInput,
  CanonicalProviderWriteReceipt,
  CanonicalProjectedProviderWriteReceipt,
  CanonicalWriterRequest,
  CanonicalWriterResponse,
  CanonicalAcceptedWriteReceipt,
} from "./canonical-agent-writer-protocol.js";
import type { CanonicalAcceptedWriteInput } from "./canonical-accepted-write.js";

import type { ParentNarrativeRecoveryCommitInput } from "./canonical-agent-boundary.js";
import type { ExecutionSemanticOperation, ExecutionWriteReceipt } from "../execution/execution-worker-handler.js";
import type { LostExecutionInterruption } from "./canonical-execution-semantic-writer.js";

const MAX_PENDING_ACKNOWLEDGEMENTS = 64;
const MAX_ACK_RETRIES_BEFORE_WRITE = 8;
const MAX_PENDING_WRITES = 64;
const ACKNOWLEDGEMENT_BATCH_SIZE = 64;
const ACKNOWLEDGEMENT_DELAY_MS = 250;

interface PendingAcknowledgement {
  executionId: string;
  operationId: string;
}



/** Receipt cleanup cannot be forgotten when its bounded retry queue is full. */
export class CanonicalWriterAcknowledgementCapacity extends Error {}

/** Adapts receipt-backed canonical operations to the shared application database owner. */
export class CanonicalAgentWriterClient {
  private retryingAcknowledgements: Promise<void> | undefined;
  private readonly pendingAcknowledgements = new Map<string, PendingAcknowledgement>();
  private readonly queuedAcknowledgements = new Map<string, PendingAcknowledgement>();
  private acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
  private acknowledgementCapacityFailure: CanonicalWriterAcknowledgementCapacity | undefined;
  private closing = false;
  private stopping = false;
  private pendingWrites = 0;

  constructor(private readonly databaseWriter: ApplicationDatabaseWriter) {}

  /** Wait for the shared application owner. */
  whenReady(): Promise<void> { return this.databaseWriter.whenReady(); }

  /** Resolves with committed envelopes for main-loop publication; it never publishes them itself. */
  async commit(operationId: string, input: CanonicalProviderWriteInput): Promise<CanonicalProviderWriteReceipt> {
    return this.commitInput(operationId, input);
  }

  /** Commit and interpret a provider batch in the same fenced SQLite transaction. */
  async commitProjected(operationId: string, input: CanonicalProviderWriteInput): Promise<CanonicalProjectedProviderWriteReceipt> {
    const receipt = await this.commitInput(operationId, input, true);
    if (!receipt.providerProjection) throw new Error("Canonical provider commit has no projection receipt");
    return { ...receipt, providerProjection: receipt.providerProjection };
  }

  private async commitInput(operationId: string, input: CanonicalProviderWriteInput, projectProviderEvents?: true): Promise<CanonicalProviderWriteReceipt> {
    if (!operationId || !input.executionId) throw new Error("Canonical writer operation and execution IDs are required");
    await this.retryPendingAcknowledgements();
    const response = await this.sendWithRetry({
      kind: "commit", requestId: NodeCrypto.randomUUID(), operationId, executionId: input.executionId, input,
      ...(projectProviderEvents ? { projectProviderEvents } : {}),
    });
    if (response.kind !== "committed") throw new Error("Canonical writer returned an unexpected response");
    return response.receipt;
  }

  /** Store the same immutable accepted batch; its receipt contains no publication side effect. */
  async appendAccepted(operationId: string, input: CanonicalAcceptedWriteInput): Promise<CanonicalAcceptedWriteReceipt> {
    if (!operationId || !input.execution.executionId) throw new Error("Accepted writer operation and execution IDs are required");
    await this.retryPendingAcknowledgements();
    const response = await this.sendWithRetry({ kind: "append-accepted", requestId: NodeCrypto.randomUUID(), operationId,
      executionId: input.execution.executionId, input });
    if (response.kind !== "accepted-appended") throw new Error("Canonical writer returned an unexpected accepted append response");
    return response.result;
  }

  /** Commits one execution operation and delivers bounded pages after each durable write. */
  async transactSemantic(
    operation: ExecutionSemanticOperation,
    onPublication: (events: readonly CanonicalAgentEventEnvelope[]) => void,
  ): Promise<ExecutionWriteReceipt> {
    if (!operation.operationId || !operation.execution.executionId) {
      throw new Error("Semantic writer operation and execution IDs are required");
    }
    const response = await this.sendWithRetry({
      kind: "semantic-transact", requestId: NodeCrypto.randomUUID(),
      operationId: operation.operationId, executionId: operation.execution.executionId, operation,
    }, false, onPublication);
    if (response.kind !== "semantic-transacted") throw new Error("Canonical writer returned an unexpected response");
    return response.receipt;
  }

  /** Reconcile a lost execution and deliver bounded committed publication pages. */
  async interruptWorkerLoss(
    input: LostExecutionInterruption,
    onPublication: (events: readonly CanonicalAgentEventEnvelope[]) => void,
  ): Promise<ExecutionWriteReceipt> {
    const operationId = `${input.lease.leaseId}:worker-lost`;
    await this.retryPendingAcknowledgements();
    const response = await this.sendWithRetry({
      kind: "semantic-worker-loss", requestId: NodeCrypto.randomUUID(), operationId,
      executionId: input.execution.executionId, input,
    }, false, onPublication);
    if (response.kind !== "semantic-transacted") throw new Error("Canonical writer returned an unexpected response");
    return response.receipt;
  }

  /** Resolves after recovery writes finish; a lost reply replays the durable receipt. */
  async recordParentNarrativeRecovery(
    operationId: string,
    input: ParentNarrativeRecoveryCommitInput,
  ): Promise<CanonicalParentNarrativeRecoveryReceipt> {
    if (!operationId || !input.executionId) throw new Error("Canonical writer operation and execution IDs are required");
    await this.retryPendingAcknowledgements();
    const response = await this.sendWithRetry({
      kind: "record-parent-narrative-recovery", requestId: NodeCrypto.randomUUID(), operationId,
      executionId: input.executionId, input,
    });
    if (response.kind !== "parent-narrative-recovery-recorded") {
      throw new Error("Canonical writer returned an unexpected response");
    }
    return response.receipt;
  }

  /** Atomically persists recovery and resets provisional assistant text; the caller retires its journal after receipt. */
  async classifyParentNarrativeRecovery(
    operationId: string,
    input: ParentNarrativeRecoveryCommitInput,
  ): Promise<CanonicalParentNarrativeClassificationReceipt> {
    if (!operationId || !input.executionId) throw new Error("Canonical writer operation and execution IDs are required");
    await this.retryPendingAcknowledgements();
    const response = await this.sendWithRetry({
      kind: "classify-parent-narrative-recovery", requestId: NodeCrypto.randomUUID(), operationId,
      executionId: input.executionId, input,
    });
    if (response.kind !== "parent-narrative-recovery-classified") {
      throw new Error("Canonical writer returned an unexpected response");
    }
    return response.receipt;
  }

  /** Releases handled receipts after publication or journal discard completes. */
  async acknowledgeOperations(operations: PendingAcknowledgement[]): Promise<void> {
    this.validateAcknowledgements(operations);
    const failure = await this.deleteAcknowledgements(operations);
    if (failure) throw failure;
  }

  /** Retain handled progress receipts for bounded cleanup without blocking the next save. */
  enqueueAcknowledgement(executionId: string, operationId: string): void {
    const operation = { executionId, operationId };
    this.validateAcknowledgements([operation]);
    const key = acknowledgementKey(executionId, operationId);
    if (this.pendingAcknowledgements.has(key) || this.queuedAcknowledgements.has(key)) return;
    if (this.pendingAcknowledgements.size >= MAX_PENDING_ACKNOWLEDGEMENTS) {
      throw new CanonicalWriterAcknowledgementCapacity("Canonical writer acknowledgement retry queue is full");
    }
    this.queuedAcknowledgements.set(key, operation);
    if (this.queuedAcknowledgements.size >= ACKNOWLEDGEMENT_BATCH_SIZE) {
      void this.flushQueuedAcknowledgements();
    } else if (!this.acknowledgementTimer) {
      this.acknowledgementTimer = setTimeout(() => {
        this.acknowledgementTimer = undefined;
        void this.flushQueuedAcknowledgements();
      }, ACKNOWLEDGEMENT_DELAY_MS);
    }
  }

  private validateAcknowledgements(operations: PendingAcknowledgement[]): void {
    if (this.closing || this.stopping) throw new Error("Canonical writer closed");
    for (const operation of operations) {
      if (!operation.executionId || !operation.operationId) throw new Error("Canonical writer operation and execution IDs are required");
    }
  }

  /** Number of handled operations whose receipt deletion still needs a retry. */
  get pendingAcknowledgementCount(): number {
    return this.pendingAcknowledgements.size;
  }

  /** Flush receipt cleanup without closing the application-owned writer. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.flushQueuedAcknowledgements();
    this.stopping = true;
    if (this.acknowledgementCapacityFailure) throw this.acknowledgementCapacityFailure;
    if (this.pendingAcknowledgements.size) throw new Error(`Canonical writer closed with ${this.pendingAcknowledgements.size} unacknowledged operations`);
  }

  private sendAcknowledgements(operations: PendingAcknowledgement[]): Promise<void> {
    return this.sendWithRetry({
      kind: "ack-operations", requestId: NodeCrypto.randomUUID(), operationId: "", executionId: "", operations,
    }, this.closing).then((response) => {
      if (response.kind !== "operations-acknowledged") {
        throw new Error("Canonical writer returned an unexpected response");
      }
    });
  }

  private async flushQueuedAcknowledgements(retryLimit = MAX_PENDING_ACKNOWLEDGEMENTS): Promise<void> {
    if (this.acknowledgementTimer) clearTimeout(this.acknowledgementTimer);
    this.acknowledgementTimer = undefined;
    if (!this.retryingAcknowledgements) {
      this.retryingAcknowledgements = this.drainAcknowledgements(retryLimit)
        .finally(() => {
          this.retryingAcknowledgements = undefined;
          if (this.queuedAcknowledgements.size) return this.flushQueuedAcknowledgements();
        });
    }
    await this.retryingAcknowledgements;
  }

  private retryPendingAcknowledgements(): Promise<void> {
    if (this.retryingAcknowledgements) return this.retryingAcknowledgements;
    if (this.pendingAcknowledgements.size === 0) return Promise.resolve();
    return this.flushQueuedAcknowledgements(MAX_ACK_RETRIES_BEFORE_WRITE);
  }

  private async drainAcknowledgements(retryLimit: number): Promise<void> {
    const retries = [...this.pendingAcknowledgements].slice(0, retryLimit);
    const operations = new Map([...retries, ...this.queuedAcknowledgements]);
    this.queuedAcknowledgements.clear();
    const entries = [...operations.values()];
    for (let offset = 0; offset < entries.length; offset += ACKNOWLEDGEMENT_BATCH_SIZE) {
      await this.deleteAcknowledgements(entries.slice(offset, offset + ACKNOWLEDGEMENT_BATCH_SIZE));
    }
  }

  private async deleteAcknowledgements(operations: PendingAcknowledgement[]): Promise<unknown> {
    try {
      await this.sendAcknowledgements(operations);
      for (const operation of operations) {
        const key = acknowledgementKey(operation.executionId, operation.operationId);
        this.pendingAcknowledgements.delete(key);
        this.queuedAcknowledgements.delete(key);
      }
      return undefined;
    } catch (error) {
      if (operations.length > 1) {
        let failure: unknown;
        // A transaction rollback does not identify which receipt poisoned the batch.
        for (const operation of operations) failure = await this.deleteAcknowledgements([operation]) ?? failure;
        return failure;
      }
      const operation = operations[0];
      if (!operation) return error;
      const key = acknowledgementKey(operation.executionId, operation.operationId);
      if (!this.pendingAcknowledgements.has(key) && this.pendingAcknowledgements.size >= MAX_PENDING_ACKNOWLEDGEMENTS) {
        const failure = new CanonicalWriterAcknowledgementCapacity("Canonical writer acknowledgement retry queue is full", { cause: error });
        // Later successful retries cannot account for the receipt that exceeded retention.
        this.acknowledgementCapacityFailure = failure;
        logger.error("Canonical writer receipt cleanup exceeded retry capacity", { ...operation, error: failure });
        return failure;
      }
      this.pendingAcknowledgements.delete(key);
      this.pendingAcknowledgements.set(key, operation);
      return error;
    }
  }

  private sendWithRetry(
    request: CanonicalWriterRequest,
    allowDuringClose = false,
    onPublication?: (events: readonly CanonicalAgentEventEnvelope[]) => void,
  ): Promise<CanonicalWriterResponse> {
    if (this.stopping || (this.closing && !allowDuringClose)) return Promise.reject(new Error("Canonical writer closed"));
    if (request.kind === "ack-operations") return this.databaseWriter.sendCanonical(request, onPublication);
    if (this.pendingWrites >= MAX_PENDING_WRITES) return Promise.reject(new Error("Canonical writer admission is full"));
    this.pendingWrites++;
    return this.databaseWriter.sendCanonical(request, onPublication).finally(() => { this.pendingWrites--; });
  }
}

function acknowledgementKey(executionId: string, operationId: string): string {
  return JSON.stringify([executionId, operationId]);
}
