import type {
  ExecutionSemanticOperation,
  ExecutionSemanticWriter,
  ExecutionWriteReceipt,
} from "../execution/execution-worker-handler.js";
import type { CanonicalAgentEventPublisher } from "./canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "./canonical-agent-writer-client.js";
import type { LostExecutionInterruption } from "./canonical-execution-semantic-writer.js";

/** Bridges an execution worker to the sole SQLite writer and publishes only committed events. */
export class CanonicalExecutionWriterPort implements ExecutionSemanticWriter {
  constructor(
    private readonly writer: CanonicalAgentWriterClient,
    private readonly publish: CanonicalAgentEventPublisher,
  ) {}

  /** Resolve after the durable writer receipt and its canonical event publication. */
  async transact(operation: ExecutionSemanticOperation): Promise<ExecutionWriteReceipt> {
    const { receipt, events } = await this.writer.transactSemantic(operation);
    if (receipt.kind === "committed" && events.length > 0) this.publish(events);
    return receipt;
  }

  /** Reconcile a lost worker through the sole writer and publish its committed interruption. */
  async interruptWorkerLoss(input: LostExecutionInterruption): Promise<ExecutionWriteReceipt> {
    const { receipt, events } = await this.writer.interruptWorkerLoss(input);
    if (receipt.kind === "committed" && events.length > 0) this.publish(events);
    return receipt;
  }
}
