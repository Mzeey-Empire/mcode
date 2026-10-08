import { logger } from "@mcode/shared";
import * as NodeCrypto from "node:crypto";
import {
  AgentEventType,
  type ProviderIdentity,
  type ProviderId,
  type ProviderRuntimeEvent,
} from "@mcode/contracts";
import type { ProviderEventBatch, ProviderEventSinkPort } from "../host-ports.js";

const MAX_PENDING_EVENTS_PER_EXECUTION = 1_024;

/** Identifies the canonical turn execution that owns provider live events. */
export interface CanonicalLiveEventRouting {
  threadId: string;
  turnId: string;
  executionId: string;
  deliveryAttempt: number;
}

interface ProviderExecutionQueue {
  nextSourceSequence: number;
  pendingEventCount: number;
  tail: Promise<void>;
  failure: Error | undefined;
  nativeEvents: Map<string, string>;
  planCapture?: ProviderRuntimeEvent["planCapture"];
}

/** Source evidence supplied by a native protocol event. */
export interface NativeLiveEventEvidence {
  id: string;
  timestamp: string;
  predecessorEventId: string | null;
  type: string;
  data?: unknown;
}

/**
 * Serializes one provider's live events into canonical drafts for an execution.
 * Provider lifetime retains retired failures. Execution lifetime drains admitted drafts
 * and reserves two terminal slots while its worker owns the final failure outcome.
 */
export class CanonicalLiveEventPublisher {
  private readonly queues = new Map<string, ProviderExecutionQueue>();
  private admissionStopped = false;
  private shutdownTask: Promise<void> | undefined;
  private lateEventReported = false;
  private firstFailure: Error | undefined;

  constructor(
    private readonly providerId: ProviderId,
    private readonly sink: ProviderEventSinkPort,
    private readonly onFailure?: (routing: CanonicalLiveEventRouting, error: Error) => void,
    private readonly failureLifetime: "provider" | "execution" = "provider",
  ) {}

  /** Retain native plan evidence within its exact execution until an assistant message arrives. */
  capturePlan(routing: CanonicalLiveEventRouting, capture: NonNullable<ProviderRuntimeEvent["planCapture"]>): void {
    const queue = this.queues.get(this.queueKey(routing));
    if (!this.admissionStopped && queue && !queue.failure) queue.planCapture = capture;
  }

  /** Queues one runtime event; a replay ID alone does not imply a native timestamp. */
  publish(
    routing: CanonicalLiveEventRouting,
    runtimeEvent: ProviderRuntimeEvent,
    sourceIdentities: readonly ProviderIdentity[],
    native?: NativeLiveEventEvidence | string,
  ): void {
    if (this.admissionStopped) {
      if (!this.lateEventReported) {
        this.lateEventReported = true;
        logger.warn("Provider canonical event rejected after shutdown", { executionId: routing.executionId });
      }
      return;
    }
    const queue = this.queueFor(routing);
    if (queue.planCapture && runtimeEvent.event.type === AgentEventType.TurnComplete) {
      this.publish(routing, { event: { type: AgentEventType.Message, threadId: routing.threadId,
        turnExecutionId: routing.executionId, content: "", tokens: null } }, sourceIdentities);
    }
    if (!this.admit(queue, routing, runtimeEvent, sourceIdentities, native)) return;
    if (runtimeEvent.event.type === AgentEventType.Message && queue.planCapture) {
      runtimeEvent = { ...runtimeEvent, planCapture: queue.planCapture };
      queue.planCapture = undefined;
    }
    const sourceSequence = queue.nextSourceSequence;
    queue.nextSourceSequence += 1;
    queue.pendingEventCount += 1;
    const draft = this.createDraft(routing, runtimeEvent, sourceIdentities, sourceSequence, typeof native === "string" ? undefined : native);
    queue.tail = queue.tail
      .then(async () => {
        if (queue.failure && this.failureLifetime === "provider") return;
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
          throw new Error(`${this.providerId} canonical event was ${receipt.commit.outcome}`);
        }
      })
      .catch((error: unknown) => {
        this.fail(queue, routing, toError(error));
      })
      .finally(() => {
        queue.pendingEventCount -= 1;
      });
  }

  private admit(queue: ProviderExecutionQueue, routing: CanonicalLiveEventRouting, runtimeEvent: ProviderRuntimeEvent,
    sourceIdentities: readonly ProviderIdentity[], native: NativeLiveEventEvidence | string | undefined): boolean {
    const terminal = runtimeEvent.event.type === AgentEventType.TurnComplete || runtimeEvent.event.type === AgentEventType.Ended;
    if (queue.failure && (this.failureLifetime === "provider" || !terminal)) return false;
    if (typeof native === "string" && this.replayed(queue, routing, runtimeEvent, sourceIdentities, native)) return false;
    const terminalReserve = this.failureLifetime === "execution" && !terminal ? 2 : 0;
    if (queue.pendingEventCount >= MAX_PENDING_EVENTS_PER_EXECUTION - terminalReserve) {
      this.fail(queue, routing, new Error(`${this.providerId} canonical event queue overflowed for execution ${routing.executionId}`));
      return false;
    }
    return true;
  }

  /** Checks delivery so a pooled provider can report turn failure before stream teardown. */
  async flushForExecution(routing: CanonicalLiveEventRouting): Promise<void> {
    const key = this.queueKey(routing);
    const queue = this.queues.get(key);
    if (!queue) return;
    await queue.tail;
    if (queue.failure) throw queue.failure;
  }

  /** Waits for all queued drafts and retires the execution queue. */
  async waitForExecution(routing: CanonicalLiveEventRouting): Promise<void> {
    try {
      await this.flushForExecution(routing);
    } finally {
      this.queues.delete(this.queueKey(routing));
    }
  }

  /** Fences late callbacks and drains every event admitted before provider shutdown. */
  stopAdmissionAndDrain(): Promise<void> {
    this.admissionStopped = true;
    this.shutdownTask ??= this.drainAcceptedQueues([...this.queues.values()]);
    return this.shutdownTask;
  }

  private async drainAcceptedQueues(queues: readonly ProviderExecutionQueue[]): Promise<void> {
    await Promise.all(queues.map((queue) => queue.tail));
    this.queues.clear();
    const failures = [...new Set([this.firstFailure, ...queues.map((queue) => queue.failure)].filter((failure) => failure !== undefined))];
    if (failures.length > 0) throw new AggregateError(failures, "Provider canonical event shutdown failed");
  }

  private queueFor(routing: CanonicalLiveEventRouting): ProviderExecutionQueue {
    const key = this.queueKey(routing);
    const existing = this.queues.get(key);
    if (existing) return existing;
    const queue: ProviderExecutionQueue = {
      nextSourceSequence: 1,
      pendingEventCount: 0,
      tail: Promise.resolve(),
      failure: undefined,
      nativeEvents: new Map(),
    };
    this.queues.set(key, queue);
    return queue;
  }

  private queueKey(routing: CanonicalLiveEventRouting): string {
    return `${routing.executionId}:attempt:${routing.deliveryAttempt}`;
  }

  private fail(queue: ProviderExecutionQueue, routing: CanonicalLiveEventRouting, error: Error): void {
    if (queue.failure) return;
    queue.failure = error;
    if (this.failureLifetime === "provider") this.firstFailure ??= error;
    this.onFailure?.(routing, error);
  }

  private replayed(queue: ProviderExecutionQueue, routing: CanonicalLiveEventRouting, runtimeEvent: ProviderRuntimeEvent,
    identities: readonly ProviderIdentity[], nativeEventId: string): boolean {
    const item = "toolCallId" in runtimeEvent.event ? runtimeEvent.event.toolCallId : "";
    const projection = runtimeEvent.event.type === AgentEventType.System ? runtimeEvent.event.subtype : undefined;
    const key = JSON.stringify([nativeEventId, runtimeEvent.event.type, item ?? "", projection ?? null]);
    const signature = NodeCrypto.createHash("sha256").update(JSON.stringify({ runtimeEvent, identities })).digest("hex");
    const existing = queue.nativeEvents.get(key);
    if (existing === signature) return true;
    if (existing !== undefined) {
      this.fail(queue, routing, new Error("Conflicting provider replay identity"));
      return true;
    }
    if (queue.nativeEvents.size >= 4_096) {
      this.fail(queue, routing, new Error("Provider replay identity bound exceeded"));
      return true;
    }
    queue.nativeEvents.set(key, signature);
    return false;
  }

  private createDraft(
    routing: CanonicalLiveEventRouting,
    runtimeEvent: ProviderRuntimeEvent,
    sourceIdentities: readonly ProviderIdentity[],
    sourceSequence: number,
    native?: NativeLiveEventEvidence,
  ): ProviderEventBatch["events"][number] {
    const eventId = native ? `${this.providerId}:native:${native.id}:${runtimeEvent.event.type}` : `${this.providerId}:${routing.executionId}:attempt:${routing.deliveryAttempt}:event:${sourceSequence}`;
    const itemId = native ? `${this.providerId}:native-item:${native.id}:${runtimeEvent.event.type}` : `${this.providerId}:${routing.executionId}:attempt:${routing.deliveryAttempt}:item:${sourceSequence}`;
    const timestamp = native?.timestamp ?? new Date().toISOString();
    return {
      eventId,
      routing: {
        threadId: routing.threadId,
        turnId: routing.turnId,
        executionId: routing.executionId,
        itemId,
      },
      sourceProviderId: this.providerId,
      sourceIdentities,
      ...(native ? {} : { sourceSequence }),
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
          payload: { projection: "providerRuntimeEvent", runtimeEvent, ...(native ? { native } : { provenance: "generated" }) },
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
