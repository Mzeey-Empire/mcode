import { logger } from "@mcode/shared";

import { workerLossIncidentId } from "../execution/execution-worker-loss-coordinator.js";
import type {
  ExecutionSemanticOperation,
  ExecutionSemanticWriter,
  ExecutionWriteReceipt,
} from "../execution/execution-worker-handler.js";
import type { ExecutionIdentity, ExecutionLease } from "../execution/execution-mailbox-protocol.js";
import type { CanonicalAgentEventPublisher } from "./canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "./canonical-agent-writer-client.js";
import type { LostExecutionInterruption } from "./canonical-execution-semantic-writer.js";
import type { ExecutionLivePublicationRelease } from "./execution-live-publication-release.js";
import type { ExecutionPlanQuestionRelease } from "./execution-plan-question-release.js";
import type { CanonicalAcceptedProgress } from "./canonical-accepted-progress.js";

/** Bridges durable turn admission and accepted live progress to the sole SQLite writer. */
export class CanonicalExecutionWriterPort implements ExecutionSemanticWriter {
  constructor(
    private readonly writer: CanonicalAgentWriterClient,
    private readonly publish: CanonicalAgentEventPublisher,
    private readonly livePublication?: ExecutionLivePublicationRelease,
    private readonly planQuestions?: ExecutionPlanQuestionRelease,
    private readonly progress?: CanonicalAcceptedProgress,
  ) {}

  /** Resolve turn admission after storage, and later observations after bounded live acceptance. */
  async transact(operation: ExecutionSemanticOperation): Promise<ExecutionWriteReceipt> {
    if (this.progress && operation.mutation.kind !== "begin") {
      return await this.progress.acceptWhenReady(operation);
    }
    const receipt = await this.transactDurable(operation);
    this.releaseDurable(operation, receipt);
    return receipt;
  }

  /**
   * End the turn a start's lease may have saved, after its owner gave that lease up without a committed start.
   *
   * A begin can commit and still fail its reply, which leaves a Running turn that no worker holds, so no ending or
   * release would ever arrive for it. The reply failure alone cannot decide this: a retry of the same begin replays
   * its receipt and keeps the turn, and a duplicate begin's failure says nothing about the worker already running it.
   * Only the released lease proves no retry can follow, and the interruption acts only on a head carrying that lease.
   */
  async abandonStart(execution: ExecutionIdentity, lease: ExecutionLease): Promise<void> {
    try {
      await this.interruptWorkerLoss({ execution, lease,
        reason: "The turn start failed after it was saved.", recoveryIncidentId: workerLossIncidentId({ execution, lease }) });
    } catch (error) {
      logger.error("Failed turn start could not be interrupted", { threadId: execution.threadId,
        executionId: execution.executionId, error: error instanceof Error ? error.message : String(error) });
    }
    this.released(execution, lease);
  }

  /** Let accepted progress drop the execution's owner once its saves finish. */
  released(execution: ExecutionIdentity, lease: ExecutionLease): void {
    this.progress?.releaseExecution(execution, lease);
  }

  private async transactDurable(operation: ExecutionSemanticOperation): Promise<ExecutionWriteReceipt> {
    await this.progress?.beforeDurableCommand(operation.execution.threadId);
    let receipt: ExecutionWriteReceipt;
    try {
      receipt = await this.writer.transactSemantic(operation,
        this.progress ? (events) => this.progress?.observeCommitted(events, operation) : this.publish);
    } finally {
      this.progress?.cancelDurableCommand(operation.execution.threadId);
    }
    return receipt;
  }

  private releaseDurable(operation: ExecutionSemanticOperation, receipt: ExecutionWriteReceipt): void {
    if (receipt.kind === "committed" && receipt.planQuestions && !this.planQuestions) {
      throw new Error("Plan-question publication is not bound");
    }
    this.planQuestions?.validate(operation, receipt);
    this.livePublication?.release(operation, receipt);
    this.planQuestions?.release(operation, receipt);
  }

  /** Admit a lost-worker interruption as live progress, with the durable writer as a compatibility fallback. */
  async interruptWorkerLoss(input: LostExecutionInterruption): Promise<ExecutionWriteReceipt> {
    if (this.progress) return this.progress.interruptWorkerLoss(input);
    return this.writer.interruptWorkerLoss(input, this.publish);
  }
}
