import type {
  ExecutionSemanticOperation,
  ExecutionSemanticWriter,
  ExecutionWriteReceipt,
} from "../execution/execution-worker-handler.js";
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
