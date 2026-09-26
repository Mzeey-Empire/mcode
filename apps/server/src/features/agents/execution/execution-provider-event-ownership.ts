import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";
import type { ExecutionMailboxOwner } from "./execution-mailbox-owner.js";
import type { ProviderEventCommitReceipt } from "@mcode/providers";
import type { ExecutionWorkCommand, ExecutionWorkerResult } from "./execution-worker-handler.js";
import type { ProviderEventOwnership, ProviderEventOwnershipRoute, WorkerOwnedProviderEventBatch, WorkerOwnedProviderEventResult } from "../../providers/composition/provider-host-ports.js";

interface ActiveRoute {
  readonly kind: "active";
  readonly execution: ExecutionIdentity;
  readonly deliveryAttempt: number;
  readonly pending: Set<Promise<unknown>>;
}

interface SwitchingRoute {
  readonly kind: "switching";
  readonly execution: ExecutionIdentity;
  readonly deliveryAttempt: number;
  readonly drained: Promise<void>;
}

type Route = ActiveRoute | SwitchingRoute;

/**
 * Binds provider batches to the execution mailbox after its durable start.
 * Unknown and retired executions fail closed while this worker route is active.
 */
export class ExecutionProviderEventOwnership implements ProviderEventOwnership {
  private readonly routes = new Map<string, Route>();
  private readonly workerProviders = new Set(["codex"]);
  private onCommitted: ((execution: ExecutionIdentity, result: Extract<ExecutionWorkerResult, { kind: "committed" }>) => Promise<void>) | undefined;
  private prepareCommand: ((execution: ExecutionIdentity, batch: WorkerOwnedProviderEventBatch) => Promise<Extract<ExecutionWorkCommand, { kind: "event" }>>) | undefined;

  constructor(private readonly owner: Pick<ExecutionMailboxOwner, "isStarted" | "submit">) {}

  /** Run execution lifecycle effects after the writer acknowledgement and before the provider receives its batch receipt. */
  bindCommitted(onCommitted: (execution: ExecutionIdentity, result: Extract<ExecutionWorkerResult, { kind: "committed" }>) => Promise<void>): void {
    this.onCommitted = onCommitted;
  }

  /** Prepare exact file and terminal inputs before admitting the provider batch to its mailbox. */
  bindCommandPreparation(prepare: (execution: ExecutionIdentity, batch: WorkerOwnedProviderEventBatch) => Promise<Extract<ExecutionWorkCommand, { kind: "event" }>>): void {
    this.prepareCommand = prepare;
  }

  /** Activate another provider only after its worker live effects are installed. */
  enableProvider(providerId: string): void {
    this.workerProviders.add(providerId);
  }

  /** Admit one provider attempt only while the exact mailbox still owns the thread. */
  async bind(execution: ExecutionIdentity, deliveryAttempt: number): Promise<void> {
    this.requireOwner(execution, deliveryAttempt);
    const existing = this.routes.get(execution.executionId);
    if (existing?.kind === "switching") {
      await existing.drained;
      return this.bind(execution, deliveryAttempt);
    }
    if (existing) this.requireReplacement(existing, execution, deliveryAttempt);
    if (existing?.deliveryAttempt === deliveryAttempt) return;
    if (existing) await this.drainPrevious(existing, execution, deliveryAttempt);
    this.routes.set(execution.executionId, {
      kind: "active", execution, deliveryAttempt, pending: new Set(),
    });
  }

  private requireOwner(execution: ExecutionIdentity, deliveryAttempt: number): void {
    if (!Number.isSafeInteger(deliveryAttempt) || deliveryAttempt < 1
      || !this.owner.isStarted(execution)) {
      throw new Error("Provider attempt has no matching execution owner");
    }
  }

  private requireReplacement(existing: ActiveRoute, execution: ExecutionIdentity, deliveryAttempt: number): void {
    if (!sameExecution(existing.execution, execution) || deliveryAttempt < existing.deliveryAttempt) {
      throw new Error("Provider attempt cannot replace its current owner");
    }
  }

  private async drainPrevious(existing: ActiveRoute, execution: ExecutionIdentity, deliveryAttempt: number): Promise<void> {
    const switching: SwitchingRoute = {
      kind: "switching", execution, deliveryAttempt,
      drained: Promise.allSettled(existing.pending).then(() => undefined),
    };
    this.routes.set(execution.executionId, switching);
    await switching.drained;
    if (this.routes.get(execution.executionId) !== switching || !this.owner.isStarted(execution)) {
      throw new Error("Provider attempt lost its execution owner while draining");
    }
  }

  /** Keep the execution rejected after its terminal fence releases ownership. */
  async retire(execution: ExecutionIdentity): Promise<void> {
    const current = this.routes.get(execution.executionId);
    if (current && sameExecution(current.execution, execution)) {
      this.routes.delete(execution.executionId);
      if (current.kind === "switching") await current.drained;
      else await Promise.allSettled(current.pending);
    }
  }

  /** Select the exact mailbox, then check again before asynchronous admission. */
  resolve(executionId: string, sourceProviderId?: string): ProviderEventOwnershipRoute {
    const route = this.routes.get(executionId);
    if (route?.kind !== "active" || !this.owner.isStarted(route.execution)) {
      return { kind: sourceProviderId && !this.workerProviders.has(sourceProviderId) ? "legacy" : "rejected" };
    }
    return {
      kind: "worker",
      ...route.execution,
      deliveryAttempt: route.deliveryAttempt,
      submit: (batch) => this.submit(route, batch),
    };
  }

  private async submit(route: ActiveRoute, batch: WorkerOwnedProviderEventBatch): Promise<WorkerOwnedProviderEventResult> {
    if (!this.isCurrent(route, batch)) {
      throw new Error("Provider batch belongs to a retired execution attempt");
    }
    const pending = this.commitAndNotify(route, batch);
    route.pending.add(pending);
    try {
      return await pending;
    } finally {
      route.pending.delete(pending);
    }
  }

  private async commitAndNotify(route: ActiveRoute, batch: WorkerOwnedProviderEventBatch): Promise<WorkerOwnedProviderEventResult> {
    const result = await this.submitPrepared(route, batch);
    if (result.kind !== "committed" || !result.providerCommit) {
      throw new Error("Execution worker did not commit provider batch");
    }
    await this.notifyCommitted(route.execution, result);
    const commit: ProviderEventCommitReceipt = {
      ...result.providerCommit,
      outcome: result.providerCommit.outcome === "terminal-outcome-confirmed"
        ? "duplicate" : result.providerCommit.outcome,
    };
    if (commit.outcome !== "committed" && result.providerEvents?.length) {
      throw new Error("Noncommitted provider batch returned projected events");
    }
    return {
      batchId: batch.batchId,
      deliveryAttempt: batch.deliveryAttempt,
      commit,
      providerEvents: result.providerEvents ?? [],
    };
  }

  private async submitPrepared(route: ActiveRoute, batch: WorkerOwnedProviderEventBatch): Promise<ExecutionWorkerResult> {
    const command = this.prepareCommand
      ? await this.prepareCommand(route.execution, batch)
      : { kind: "event" as const, phase: batch.phase, nativeCursor: batch.nativeCursor ?? null, events: batch.events };
    if (!this.isCurrent(route, batch) || command.kind !== "event"
      || command.events !== batch.events || command.phase !== batch.phase) {
      throw new Error("Prepared provider event lost its execution owner");
    }
    return await this.owner.submit(route.execution, command);
  }

  private isCurrent(route: ActiveRoute, batch: WorkerOwnedProviderEventBatch): boolean {
    return this.routes.get(route.execution.executionId) === route
      && this.owner.isStarted(route.execution)
      && batch.deliveryAttempt === route.deliveryAttempt
      && sameExecution(batch, route.execution);
  }

  private async notifyCommitted(
    execution: ExecutionIdentity,
    result: Extract<ExecutionWorkerResult, { kind: "committed" }>,
  ): Promise<void> {
    await this.onCommitted?.(execution, result);
  }
}

function sameExecution(left: ExecutionIdentity | undefined, right: ExecutionIdentity): boolean {
  return left?.threadId === right.threadId && left.turnId === right.turnId
    && left.executionId === right.executionId;
}
