import { AgentEventType, agentEventDelivery } from "@mcode/contracts/events/agent-event";
import { type ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import { logger } from "@mcode/shared";
import { type ProviderEventDraft, type ProviderEventSinkPort } from "../../host-ports.js";

/**
 * Pending events for one thread at which its Codex stream is paused. The sink saves one event at a
 * time, so a deeper queue adds no throughput; it only delays responses that arrive behind it.
 */
const PAUSE_STREAM_AT_PENDING_EVENTS = 256;
/** Pending events below which a paused stream reads again; the gap keeps it from toggling per event. */
const RESUME_STREAM_BELOW_PENDING_EVENTS = 128;

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

/** Asks the provider to stop or restart reading one thread's Codex stream. */
export type CodexStreamBackpressureHandler = (threadId: string, paused: boolean) => void;

/** Serializes Codex parent events through the server-owned canonical sink. */
export class CodexCanonicalEventPublisher {
  private readonly queues = new Map<string, ExecutionQueue>();
  private admissionStopped = false;
  private shutdownTask: Promise<void> | undefined;
  private lateEventReported = false;
  private readonly failureTasks = new Set<Promise<void>>();
  /** Undelivered events per thread, across its executions, because one stream feeds them all. */
  private readonly pendingByThread = new Map<string, number>();
  private readonly pausedThreads = new Set<string>();
  private backpressureHandler: CodexStreamBackpressureHandler | undefined;
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

  /**
   * Pauses a thread's stream while saving falls behind, instead of dropping its events. The queue
   * has no capacity limit of its own: the paused stream is what bounds it.
   */
  setBackpressureHandler(handler: CodexStreamBackpressureHandler): void {
    this.backpressureHandler = handler;
  }

  /** Whether a thread's stream is paused now, so an app-server that starts for it can start paused. */
  isStreamPaused(threadId: string): boolean {
    return this.pausedThreads.has(threadId);
  }

  /** Queues one event; the caller must have verified its exact execution and attempt. */
  publish(routing: CodexCanonicalEventRouting, runtimeEvent: ProviderRuntimeEvent): void {
    if (this.admissionStopped) {
      if (!this.lateEventReported) {
        this.lateEventReported = true;
        logger.warn("Codex canonical event rejected after shutdown", { executionId: routing.executionId });
      }
      return;
    }
    const queue = this.queueFor(routing);
    if (queue.failure || queue.discardQueued) return;
    const terminal = isTerminalEvent(runtimeEvent.event);
    const sourceSequence = queue.nextSourceSequence++;
    queue.pendingEventCount++;
    this.trackAdmitted(routing.threadId);
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
        if (receipt.commit.outcome === "dropped") {
          if (terminal) throw new Error("Codex terminal observation was dropped");
          this.logDropped(routing, runtimeEvent.event.type, receipt.commit.reason);
        }
      })
      .catch((error: unknown) => {
        if (terminal) this.reportFailure(routing, queue, toError(error));
        else this.logDropped(routing, runtimeEvent.event.type, "delivery-failed");
      })
      .finally(() => {
        queue.pendingEventCount--;
        this.trackSettled(routing.threadId);
      });
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

  /** Fences late callbacks and drains every event admitted before provider shutdown. */
  stopAdmissionAndDrain(): Promise<void> {
    this.admissionStopped = true;
    this.shutdownTask ??= this.drainAcceptedQueues([...this.queues.values()]);
    return this.shutdownTask;
  }

  private async drainAcceptedQueues(queues: readonly ExecutionQueue[]): Promise<void> {
    await Promise.all(queues.map((queue) => queue.tail));
    await Promise.all(this.failureTasks);
    this.queues.clear();
    const failures = queues.flatMap((queue) => queue.failure ? [queue.failure] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Codex canonical event shutdown failed");
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

  private trackAdmitted(threadId: string): void {
    const pending = (this.pendingByThread.get(threadId) ?? 0) + 1;
    this.pendingByThread.set(threadId, pending);
    if (pending < PAUSE_STREAM_AT_PENDING_EVENTS || this.pausedThreads.has(threadId)) return;
    this.pausedThreads.add(threadId);
    this.backpressureHandler?.(threadId, true);
  }

  private trackSettled(threadId: string): void {
    const pending = (this.pendingByThread.get(threadId) ?? 1) - 1;
    if (pending === 0) this.pendingByThread.delete(threadId);
    else this.pendingByThread.set(threadId, pending);
    if (pending >= RESUME_STREAM_BELOW_PENDING_EVENTS || !this.pausedThreads.delete(threadId)) return;
    this.backpressureHandler?.(threadId, false);
  }

  private logDropped(routing: CodexCanonicalEventRouting, eventType: string, reason: string): void {
    logger.warn("Codex observation dropped; execution continues", { threadId: routing.threadId,
      executionId: routing.executionId, deliveryAttempt: routing.deliveryAttempt, eventType, reason });
  }

  private queueKey(routing: CodexCanonicalEventRouting): string {
    return `${routing.executionId}:attempt:${routing.deliveryAttempt}`;
  }

  private reportFailure(routing: CodexCanonicalEventRouting, queue: ExecutionQueue, error: Error): void {
    if (queue.failure) return;
    queue.failure = error;
    try {
      const failureTask = Promise.resolve(this.failureHandler?.(routing, error)).catch((handlerError: unknown) => {
        logger.error("Codex canonical failure handler failed", {
          executionId: routing.executionId,
          error: toError(handlerError).message,
        });
      }).finally(() => { this.failureTasks.delete(failureTask); });
      this.failureTasks.add(failureTask);
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
      ...(agentEventDelivery(runtimeEvent.event) === "live" ? { delivery: "live" as const } : {}),
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

function isTerminalEvent(event: ProviderRuntimeEvent["event"]): boolean {
  return event.type === AgentEventType.TurnComplete || event.type === AgentEventType.Error
    || event.type === AgentEventType.Ended && event.outcome !== undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
