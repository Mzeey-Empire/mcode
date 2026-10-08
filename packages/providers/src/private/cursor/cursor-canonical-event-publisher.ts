import { logger } from "@mcode/shared";
import { AgentEventType } from "@mcode/contracts";
import type { ProviderRuntimeEvent } from "@mcode/contracts";
import type { ProviderIdentity } from "@mcode/agent-model";
import type { ProviderEventDraft, ProviderEventSinkPort } from "../../host-ports.js";

const MAX_PENDING_EVENTS_PER_EXECUTION = 1_024;

/** Identifies the canonical turn execution that owns Cursor live events. */
export interface CursorCanonicalEventRouting {
  threadId: string;
  turnId: string;
  executionId: string;
  deliveryAttempt: number;
}

interface CursorExecutionQueue {
  nextSourceSequence: number;
  pendingEventCount: number;
  tail: Promise<void>;
  failure: Error | undefined;
  planCapture?: ProviderRuntimeEvent["planCapture"];
}

/** Serializes Cursor live events into canonical item drafts for one execution. */
export class CursorCanonicalEventPublisher {
  private readonly queues = new Map<string, CursorExecutionQueue>();
  private admissionStopped = false;
  private shutdownTask: Promise<void> | undefined;
  private lateEventReported = false;

  constructor(private readonly sink: ProviderEventSinkPort) {}

  /** Retain plan evidence within the exact Cursor execution until its assistant message. */
  capturePlan(routing: CursorCanonicalEventRouting, capture: NonNullable<ProviderRuntimeEvent["planCapture"]>): void {
    const queue = this.queues.get(this.queueKey(routing));
    if (!this.admissionStopped && queue && !queue.failure) {
      queue.planCapture = capture;
      return;
    }
    logger.warn("Native plan capture arrived outside a live execution", { executionId: routing.executionId });
  }

  /** Queues one Cursor runtime event for durable canonical delivery. */
  publish(
    routing: CursorCanonicalEventRouting,
    runtimeEvent: ProviderRuntimeEvent,
    sourceIdentities: readonly ProviderIdentity[],
  ): void {
    if (this.admissionStopped) {
      if (!this.lateEventReported) {
        this.lateEventReported = true;
        logger.warn("Cursor canonical event rejected after shutdown", { executionId: routing.executionId });
      }
      return;
    }
    const queue = this.queueFor(routing);
    if (queue.planCapture && runtimeEvent.event.type === AgentEventType.TurnComplete) {
      // The plan record needs an assistant message to anchor to; a textless turn has none.
      logger.warn("Native plan capture had no assistant message to attach to", { executionId: routing.executionId });
      queue.planCapture = undefined;
    }
    if (queue.failure) return;
    if (queue.pendingEventCount >= MAX_PENDING_EVENTS_PER_EXECUTION) {
      queue.failure = new Error(`Cursor canonical event queue overflowed for execution ${routing.executionId}`);
      return;
    }

    const sourceSequence = queue.nextSourceSequence;
    if (runtimeEvent.event.type === AgentEventType.Message && queue.planCapture) {
      runtimeEvent = { ...runtimeEvent, planCapture: queue.planCapture };
      queue.planCapture = undefined;
    }
    queue.nextSourceSequence += 1;
    queue.pendingEventCount += 1;
    const draft = this.createDraft(routing, runtimeEvent, sourceIdentities, sourceSequence);
    queue.tail = queue.tail
      .then(async () => {
        if (queue.failure) return;
        await this.sink.submit({
          threadId: routing.threadId,
          turnId: routing.turnId,
          executionId: routing.executionId,
          batchId: draft.eventId,
          deliveryAttempt: routing.deliveryAttempt,
          phase: "running",
          events: [draft],
        });
      })
      .catch((error: unknown) => {
        queue.failure ??= toError(error);
      })
      .finally(() => {
        queue.pendingEventCount -= 1;
      });
  }

  /** Waits for all queued drafts, then reports a sink failure to the caller. */
  async waitForExecution(routing: CursorCanonicalEventRouting): Promise<void> {
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

  private async drainAcceptedQueues(queues: readonly CursorExecutionQueue[]): Promise<void> {
    await Promise.all(queues.map((queue) => queue.tail));
    this.queues.clear();
    const failures = queues.flatMap((queue) => queue.failure ? [queue.failure] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Cursor canonical event shutdown failed");
  }

  private queueFor(routing: CursorCanonicalEventRouting): CursorExecutionQueue {
    const key = this.queueKey(routing);
    const existing = this.queues.get(key);
    if (existing) return existing;
    const queue: CursorExecutionQueue = {
      nextSourceSequence: 1,
      pendingEventCount: 0,
      tail: Promise.resolve(),
      failure: undefined,
    };
    this.queues.set(key, queue);
    return queue;
  }

  private queueKey(routing: CursorCanonicalEventRouting): string {
    return `${routing.executionId}:attempt:${routing.deliveryAttempt}`;
  }

  private createDraft(
    routing: CursorCanonicalEventRouting,
    runtimeEvent: ProviderRuntimeEvent,
    sourceIdentities: readonly ProviderIdentity[],
    sourceSequence: number,
  ): ProviderEventDraft {
    const eventId = `cursor:${routing.executionId}:attempt:${routing.deliveryAttempt}:event:${sourceSequence}`;
    const itemId = `cursor:${routing.executionId}:attempt:${routing.deliveryAttempt}:item:${sourceSequence}`;
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
      sourceProviderId: "cursor",
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
