import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts";
import type { ProviderRuntimeEvent } from "@mcode/contracts";
import type { ProviderIdentity } from "@mcode/agent-model";
import type { ProviderEventDraft, ProviderEventSinkPort } from "../../host-ports.js";

const MAX_PENDING_EVENTS_PER_EXECUTION = 1_024;

/** Identifies the canonical turn execution that owns Devin live events. */
export interface DevinCanonicalEventRouting {
  threadId: string;
  turnId: string;
  executionId: string;
  deliveryAttempt: number;
}

interface DevinExecutionQueue {
  nextSourceSequence: number;
  pendingEventCount: number;
  tail: Promise<void>;
  failure: Error | undefined;
}

/** Serializes Devin live events into canonical item drafts for one execution. */
export class DevinCanonicalEventPublisher {
  private readonly queues = new Map<string, DevinExecutionQueue>();
  private admissionStopped = false;
  private shutdownTask: Promise<void> | undefined;
  private lateEventReported = false;

  constructor(private readonly sink: ProviderEventSinkPort) {}

  /** Queue one exactly routed observation for live acceptance. */
  publish(
    routing: DevinCanonicalEventRouting,
    runtimeEvent: ProviderRuntimeEvent,
    sourceIdentities: readonly ProviderIdentity[],
  ): void {
    if (this.admissionStopped) {
      if (!this.lateEventReported) {
        this.lateEventReported = true;
        logger.warn("Devin canonical event rejected after shutdown", { executionId: routing.executionId });
      }
      return;
    }
    const queue = this.queueFor(routing);
    if (queue.failure) return;
    if (queue.pendingEventCount >= MAX_PENDING_EVENTS_PER_EXECUTION) {
      queue.failure = new Error(`Devin canonical event queue overflowed for execution ${routing.executionId}`);
      return;
    }

    const sourceSequence = queue.nextSourceSequence;
    queue.nextSourceSequence += 1;
    queue.pendingEventCount += 1;
    const draft = this.createDraft(routing, runtimeEvent, sourceIdentities, sourceSequence);
    queue.tail = queue.tail
      .then(async () => {
        if (queue.failure) return;
        const receipt = await this.sink.submit({
          threadId: routing.threadId,
          turnId: routing.turnId,
          executionId: routing.executionId,
          batchId: draft.eventId,
          deliveryAttempt: routing.deliveryAttempt,
          phase: "running",
          events: [draft],
        });
        if (receipt.commit.outcome === "conflict" || receipt.commit.outcome === "ingest-overflow") {
          throw new Error(`Devin canonical event ${draft.eventId} was ${receipt.commit.outcome}`);
        }
      })
      .catch((error: unknown) => {
        queue.failure ??= toError(error);
      })
      .finally(() => {
        queue.pendingEventCount -= 1;
      });
  }

  /** Waits for all queued drafts, then reports a sink failure to the caller. */
  async waitForExecution(routing: DevinCanonicalEventRouting): Promise<void> {
    const key = this.queueKey(routing);
    const queue = this.queues.get(key);
    if (!queue) return;
    await queue.tail;
    this.queues.delete(key);
    if (queue.failure) throw queue.failure;
  }

  /** Fences late callbacks and drains every event admitted before provider shutdown. */
  stopAdmissionAndDrain(): Promise<void> {
    this.admissionStopped = true;
    this.shutdownTask ??= this.drainAcceptedQueues([...this.queues.values()]);
    return this.shutdownTask;
  }

  private async drainAcceptedQueues(queues: readonly DevinExecutionQueue[]): Promise<void> {
    await Promise.all(queues.map((queue) => queue.tail));
    this.queues.clear();
    const failures = queues.flatMap((queue) => queue.failure ? [queue.failure] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Devin canonical event shutdown failed");
  }

  private queueFor(routing: DevinCanonicalEventRouting): DevinExecutionQueue {
    const key = this.queueKey(routing);
    const existing = this.queues.get(key);
    if (existing) return existing;
    const queue: DevinExecutionQueue = {
      nextSourceSequence: 1,
      pendingEventCount: 0,
      tail: Promise.resolve(),
      failure: undefined,
    };
    this.queues.set(key, queue);
    return queue;
  }

  private queueKey(routing: DevinCanonicalEventRouting): string {
    return `${routing.executionId}:attempt:${routing.deliveryAttempt}`;
  }

  private createDraft(
    routing: DevinCanonicalEventRouting,
    runtimeEvent: ProviderRuntimeEvent,
    sourceIdentities: readonly ProviderIdentity[],
    sourceSequence: number,
  ): ProviderEventDraft {
    const eventId = `devin:${routing.executionId}:attempt:${routing.deliveryAttempt}:event:${sourceSequence}`;
    const itemId = `devin:${routing.executionId}:attempt:${routing.deliveryAttempt}:item:${sourceSequence}`;
    const timestamp = new Date().toISOString();
    const canonicalRuntimeEvent: ProviderRuntimeEvent = {
      ...runtimeEvent,
      event: {
        ...runtimeEvent.event,
        turnExecutionId: routing.executionId,
      },
    };
    return {
      eventId,
      routing: {
        threadId: routing.threadId,
        turnId: routing.turnId,
        executionId: routing.executionId,
        itemId,
      },
      sourceProviderId: "devin",
      sourceIdentities,
      sourceSequence,
      providerTimestamp: timestamp,
      ...(runtimeEvent.event.type === AgentEventType.TextDelta ? { ingestClass: "volatile" as const } : {}),
      payload: {
        type: "item.recorded",
        item: {
          id: itemId,
          threadId: routing.threadId,
          turnId: routing.turnId,
          kind: "system",
          providerIdentities: [...sourceIdentities],
          payload: { projection: "providerRuntimeEvent", runtimeEvent: canonicalRuntimeEvent },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    };
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
