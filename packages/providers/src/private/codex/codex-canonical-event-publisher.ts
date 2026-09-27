import { AgentEventType } from "@mcode/contracts";
import type { ProviderRuntimeEvent } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { ProviderEventDraft, ProviderEventSinkPort } from "../../host-ports.js";

const MAX_PENDING_EVENTS_PER_EXECUTION = 1_024;

/** Exact Mcode turn and delivery attempt that produced a Codex event. */
export interface CodexCanonicalEventRouting {
  threadId: string;
  turnId: string;
  executionId: string;
  deliveryAttempt: number;
}

interface ExecutionQueue {
  nextSourceSequence: number;
  pendingEventCount: number;
  tail: Promise<void>;
  failure: Error | undefined;
  discardQueued: boolean;
}

/** Serializes Codex parent events through the server-owned canonical sink. */
export class CodexCanonicalEventPublisher {
  private readonly queues = new Map<string, ExecutionQueue>();
  private failureHandler:
    | ((routing: CodexCanonicalEventRouting, error: Error) => void | Promise<void>)
    | undefined;

  constructor(private readonly sink: ProviderEventSinkPort) {}

  /** Reports the first failed delivery for an exact execution without waiting for its next turn. */
  setFailureHandler(
    handler: (routing: CodexCanonicalEventRouting, error: Error) => void | Promise<void>,
  ): void {
    this.failureHandler = handler;
  }

  /** Queues one event; the caller must have verified its exact execution and attempt. */
  publish(routing: CodexCanonicalEventRouting, runtimeEvent: ProviderRuntimeEvent): void {
    const queue = this.queueFor(routing);
    if (queue.failure || queue.discardQueued) return;
    if (queue.pendingEventCount >= MAX_PENDING_EVENTS_PER_EXECUTION) {
      this.reportFailure(routing, queue, new Error(`Codex canonical event queue overflowed for execution ${routing.executionId}`));
      return;
    }

    const sourceSequence = queue.nextSourceSequence++;
    queue.pendingEventCount++;
    const draft = this.createDraft(routing, runtimeEvent, sourceSequence);
    queue.tail = queue.tail
      .then(async () => {
        if (queue.failure || queue.discardQueued) return;
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
          throw new Error(`Codex canonical event ${draft.eventId} was ${receipt.commit.outcome}`);
        }
      })
      .catch((error: unknown) => { this.reportFailure(routing, queue, toError(error)); })
      .finally(() => { queue.pendingEventCount--; });
  }

  /** Waits for acknowledged delivery and exposes a failed or overflowing queue. */
  async waitForExecution(routing: CodexCanonicalEventRouting): Promise<void> {
    const key = this.queueKey(routing);
    const queue = this.queues.get(key);
    if (!queue) return;
    await queue.tail;
    if (queue.failure) throw queue.failure;
  }

  /** Stop queued deliveries at a cancellation cut, then await only the current sink call. */
  async discardQueuedForExecution(routing: CodexCanonicalEventRouting): Promise<void> {
    const queue = this.queues.get(this.queueKey(routing));
    if (queue) queue.discardQueued = true;
    await this.waitForExecution(routing);
  }

  /** Releases a completed route after its final acknowledged event. */
  async retireExecution(routing: CodexCanonicalEventRouting): Promise<void> {
    await this.waitForExecution(routing);
    this.queues.delete(this.queueKey(routing));
  }

  private queueFor(routing: CodexCanonicalEventRouting): ExecutionQueue {
    const key = this.queueKey(routing);
    const existing = this.queues.get(key);
    if (existing) return existing;
    const queue: ExecutionQueue = {
      nextSourceSequence: 1,
      pendingEventCount: 0,
      tail: Promise.resolve(),
      failure: undefined,
      discardQueued: false,
    };
    this.queues.set(key, queue);
    return queue;
  }

  private queueKey(routing: CodexCanonicalEventRouting): string {
    return `${routing.executionId}:attempt:${routing.deliveryAttempt}`;
  }

  private reportFailure(routing: CodexCanonicalEventRouting, queue: ExecutionQueue, error: Error): void {
    if (queue.failure) return;
    queue.failure = error;
    try {
      void Promise.resolve(this.failureHandler?.(routing, error)).catch((handlerError: unknown) => {
        logger.error("Codex canonical failure handler failed", {
          executionId: routing.executionId,
          error: toError(handlerError).message,
        });
      });
    } catch (handlerError: unknown) {
      logger.error("Codex canonical failure handler failed", {
        executionId: routing.executionId,
        error: toError(handlerError).message,
      });
    }
  }

  private createDraft(
    routing: CodexCanonicalEventRouting,
    runtimeEvent: ProviderRuntimeEvent,
    sourceSequence: number,
  ): ProviderEventDraft {
    const eventId = `codex:${routing.executionId}:attempt:${routing.deliveryAttempt}:event:${sourceSequence}`;
    const itemId = `codex:${routing.executionId}:attempt:${routing.deliveryAttempt}:item:${sourceSequence}`;
    const timestamp = new Date().toISOString();
    return {
      eventId,
      routing: { threadId: routing.threadId, turnId: routing.turnId, executionId: routing.executionId, itemId },
      sourceProviderId: "codex",
      sourceIdentities: [],
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
          providerIdentities: [],
          payload: { projection: "providerRuntimeEvent", runtimeEvent },
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
