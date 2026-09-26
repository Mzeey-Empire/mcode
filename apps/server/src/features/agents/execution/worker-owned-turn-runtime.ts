import { broadcast } from "../../../application/transport/push.js";
import { CanonicalAgentWriterClient } from "../canonical/canonical-agent-writer-client.js";
import { publishCanonicalAgentEvents } from "../canonical/canonical-agent-boundary.js";
import { CanonicalExecutionWriterPort } from "../canonical/canonical-execution-writer-port.js";
import { ExecutionLivePublicationRelease } from "../canonical/execution-live-publication-release.js";
import { ExecutionPlanQuestionRelease } from "../canonical/execution-plan-question-release.js";
import { AgentEventPublicationRegistry } from "../orchestration/agent-event-publication-registry.js";
import { ExecutionMailboxOwner } from "./execution-mailbox-owner.js";
import { ExecutionMailboxScheduler, type ExecutionMailboxLimits } from "./execution-mailbox-scheduler.js";
import { ExecutionProviderEventOwnership } from "./execution-provider-event-ownership.js";
import { ExecutionThreadWorkerPort } from "./execution-worker-port.js";
import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";
import { ExecutionWorkerLossCoordinator, workerLossIncidentId } from "./execution-worker-loss-coordinator.js";
import type { ExecutionWorkCommand, ExecutionWorkerResult } from "./execution-worker-handler.js";

const EXECUTION_WORKER_COUNT = 4;
const EXECUTION_MAILBOX_LIMITS: ExecutionMailboxLimits = {
  maxPending: 256,
  maxPendingBytes: 16 * 1024 * 1024,
  reservedControl: 32,
  reservedControlBytes: 2 * 1024 * 1024,
  maxPerExecutionPending: 64,
  maxPerExecutionBytes: 4 * 1024 * 1024,
  reservedPerExecutionControl: 8,
  reservedPerExecutionControlBytes: 512 * 1024,
};

/** Owns the fixed execution pool and sole semantic writer for this server process. */
export class WorkerOwnedTurnRuntime {
  readonly writer: CanonicalAgentWriterClient;
  readonly writerPort: CanonicalExecutionWriterPort;
  readonly workerLoss: ExecutionWorkerLossCoordinator;
  readonly scheduler: ExecutionMailboxScheduler<ExecutionWorkCommand, ExecutionWorkerResult>;
  readonly owner: ExecutionMailboxOwner;
  readonly providerEvents: ExecutionProviderEventOwnership;
  private readonly initialWorkers: ExecutionThreadWorkerPort[] = [];
  private readonly rejectedRecoveries = new Map<string, Promise<void>>();
  private onRecovered: ((execution: ExecutionIdentity) => void) | undefined;

  constructor(dbPath: string, publication: AgentEventPublicationRegistry) {
    this.writer = new CanonicalAgentWriterClient(dbPath);
    this.writerPort = new CanonicalExecutionWriterPort(
      this.writer,
      publishCanonicalAgentEvents,
      new ExecutionLivePublicationRelease(publication),
      new ExecutionPlanQuestionRelease((threadId, questions) => {
        broadcast("plan.questions", { threadId, questions: [...questions] });
      }),
    );
    this.workerLoss = new ExecutionWorkerLossCoordinator(this.writerPort, {
      workerCount: EXECUTION_WORKER_COUNT,
      limits: EXECUTION_MAILBOX_LIMITS,
      createWorker: () => {
        const worker = new ExecutionThreadWorkerPort(this.writerPort);
        if (this.initialWorkers.length < EXECUTION_WORKER_COUNT) this.initialWorkers.push(worker);
        return worker;
      },
    }, (assignment) => {
      this.owner.forgetRecovered(assignment.execution, assignment.lease);
      this.onRecovered?.(assignment.execution);
    });
    this.scheduler = this.workerLoss.scheduler;
    this.owner = new ExecutionMailboxOwner(this.scheduler);
    this.providerEvents = new ExecutionProviderEventOwnership(this.owner);
  }

  /** Notify the runtime controller only after writer-backed worker-loss recovery releases the lease. */
  bindRecovered(onRecovered: (execution: ExecutionIdentity) => void): void {
    this.onRecovered = onRecovered;
  }

  /** Interrupt and release only the rejected execution; other assignments keep their worker. */
  async recoverRejected(execution: ExecutionIdentity): Promise<void> {
    const existing = this.rejectedRecoveries.get(execution.executionId);
    if (existing) return existing;
    const owned = this.owner.current(execution.threadId);
    if (!owned || owned.execution.executionId !== execution.executionId) return;
    const task = this.recoverRejectedOwned(execution, owned.lease);
    this.rejectedRecoveries.set(execution.executionId, task);
    try {
      await task;
    } finally {
      this.rejectedRecoveries.delete(execution.executionId);
    }
  }

  private async recoverRejectedOwned(execution: ExecutionIdentity, lease: NonNullable<ReturnType<ExecutionMailboxOwner["current"]>>["lease"]): Promise<void> {
    const receipt = await this.writerPort.interruptWorkerLoss({
      execution, lease,
      reason: "The provider event could not be durably applied to this execution.",
      recoveryIncidentId: workerLossIncidentId({ execution, lease }),
    });
    const recovery = receipt.kind === "committed" ? receipt
      : receipt.recoveryState === "already-terminal"
        ? { ...receipt, recoveryState: "already-terminal" as const }
        : null;
    if (!recovery) throw new Error("Rejected execution has no durable recovery evidence");
    await this.owner.releaseRecovered(execution, recovery);
    this.onRecovered?.(execution);
  }

  /** Wait for the writer and every initial slot before accepting a provider turn. */
  async whenReady(): Promise<void> {
    await this.writer.whenReady();
    const ready = await Promise.all(this.initialWorkers.map((worker) => worker.whenReady()));
    if (ready.length !== EXECUTION_WORKER_COUNT || ready.some((value) => !value)) {
      throw new Error("Execution worker pool did not start");
    }
  }

  /** Stop mailbox admission before closing its durable writer. */
  async close(): Promise<void> {
    this.scheduler.shutdown();
    await this.writer.close();
  }
}
