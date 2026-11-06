import { logger } from "@mcode/shared";
import * as NodeCrypto from "node:crypto";
import { AgentEventType, agentEventDelivery } from "@mcode/contracts/events/agent-event";
import { isChildRoutedRuntimeEvent, type ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import { type ProviderIdentity } from "@mcode/contracts/compat/agent-model";
import { type ProviderId } from "@mcode/contracts/providers/interfaces";
import { volatileIngestClass, type ProviderEventBatch, type ProviderEventSinkPort } from "../host-ports.js";

const PAUSE_AT = 256;
const RESUME_BELOW = 128;
/**
 * Providers whose text, reasoning and tool-input fragments are shown live and checkpointed instead of saved
 * one by one. Live delivery rolls out one provider at a time so each provider's save cost and crash bound are
 * measured alone; Cursor, Devin, Copilot and OpenCode keep saving every fragment until theirs are proven.
 */
const LIVE_DELIVERY_PROVIDERS: ReadonlySet<ProviderId> = new Set(["claude"]);
/**
 * Native replays arrive close to their original, so dedupe needs only recent identities.
 * A long Claude turn streams one identity per thinking or text delta, far past this window.
 */
const NATIVE_REPLAY_WINDOW = 4_096;

/** Identifies the canonical turn execution that owns provider live events. */
export interface CanonicalLiveEventRouting {
  threadId: string;
  turnId: string;
  executionId: string;
  deliveryAttempt: number;
}

interface ProviderExecutionQueue {
  nextSourceSequence: number;
  pendingBytes: number;
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
 * while its worker owns the final failure outcome.
 */
export class CanonicalLiveEventPublisher {
  private readonly queues = new Map<string, ProviderExecutionQueue>();
  private admissionStopped = false;
  private shutdownTask: Promise<void> | undefined;
  private lateEventReported = false;
  private firstFailure: Error | undefined;
  private readonly pendingByThread = new Map<string, number>();
  private readonly capacityWaiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly byteBudget: number | "unbounded",
    private readonly providerId: ProviderId,
    private readonly sink: ProviderEventSinkPort,
    private readonly onFailure?: (routing: CanonicalLiveEventRouting, error: Error) => void,
    private readonly failureLifetime: "provider" | "execution" = "provider",
  ) {}

  /** Waits before pulling more output while this thread's saves are behind. */
  waitForCapacity(threadId: string, signal?: AbortSignal): Promise<void> {
    if ((this.pendingByThread.get(threadId) ?? 0) < PAUSE_AT || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.capacityWaiters.get(threadId) ?? new Set<() => void>();
      const done = (): void => {
        waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      waiters.add(done);
      this.capacityWaiters.set(threadId, waiters);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private settleCapacity(threadId: string): void {
    const pending = (this.pendingByThread.get(threadId) ?? 1) - 1;
    if (pending === 0) this.pendingByThread.delete(threadId);
    else this.pendingByThread.set(threadId, pending);
    if (pending >= RESUME_BELOW) return;
    for (const done of this.capacityWaiters.get(threadId) ?? []) done();
    this.capacityWaiters.delete(threadId);
  }

  /** Retain native plan evidence within its exact execution until an assistant message arrives. */
  capturePlan(routing: CanonicalLiveEventRouting, capture: NonNullable<ProviderRuntimeEvent["planCapture"]>): void {
    const queue = this.queues.get(this.queueKey(routing));
    if (!this.admissionStopped && queue && !queue.failure) {
      queue.planCapture = capture;
      return;
    }
    logger.warn("Native plan capture arrived outside a live execution", { executionId: routing.executionId });
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
    this.discardUnanchoredPlan(queue, routing, runtimeEvent);
    if (!this.admit(queue, routing, runtimeEvent, sourceIdentities, native)) return;
    if (runtimeEvent.event.type === AgentEventType.Message && queue.planCapture) {
      runtimeEvent = { ...runtimeEvent, planCapture: queue.planCapture };
      queue.planCapture = undefined;
    }
    const sourceSequence = queue.nextSourceSequence;
    const draft = this.createDraft(routing, runtimeEvent, sourceIdentities, sourceSequence, typeof native === "string" ? undefined : native);
    const bytes = this.byteBudget === "unbounded" ? 0 : Buffer.byteLength(JSON.stringify(draft));
    if (!this.admitBytes(queue, routing, bytes, runtimeEvent)) return;
    queue.nextSourceSequence += 1;
    queue.pendingBytes += bytes;
    this.pendingByThread.set(routing.threadId, (this.pendingByThread.get(routing.threadId) ?? 0) + 1);
    queue.tail = queue.tail
      .then(async () => {
        const delivered = queue.failure && isParentTerminal(runtimeEvent)
          ? this.createDraft(routing, this.failedTerminal(routing, runtimeEvent, queue.failure),
            sourceIdentities, sourceSequence, typeof native === "string" ? undefined : native)
          : draft;
        const receipt = await this.sink.submit({
          threadId: routing.threadId,
          turnId: routing.turnId,
          executionId: routing.executionId,
          batchId: draft.eventId,
          deliveryAttempt: routing.deliveryAttempt,
          phase: "running",
          events: [delivered],
        });
        if (receipt.commit.outcome === "conflict" || receipt.commit.outcome === "ingest-overflow") {
          throw new Error(`${this.providerId} canonical event was ${receipt.commit.outcome}`);
        }
      })
      .catch((error: unknown) => {
        this.fail(queue, routing, toError(error));
      })
      .finally(() => {
        queue.pendingBytes -= bytes;
        this.settleCapacity(routing.threadId);
      });
  }

  private discardUnanchoredPlan(queue: ProviderExecutionQueue, routing: CanonicalLiveEventRouting, runtimeEvent: ProviderRuntimeEvent): void {
    if (!queue.planCapture || runtimeEvent.event.type !== AgentEventType.TurnComplete) return;
    // The plan record needs an assistant message to anchor to; a textless turn has none.
    logger.warn("Native plan capture had no assistant message to attach to", { executionId: routing.executionId });
    queue.planCapture = undefined;
  }

  private failedTerminal(routing: CanonicalLiveEventRouting, runtimeEvent: ProviderRuntimeEvent, failure: Error): ProviderRuntimeEvent {
    if (runtimeEvent.event.type === AgentEventType.TurnComplete) {
      // Keep the admitted sequence contiguous without recording a successful completion.
      return { ...runtimeEvent, event: { type: AgentEventType.System, threadId: routing.threadId,
        subtype: "canonical_save_failed", message: failure.message.slice(0, 1000) } };
    }
    return { ...runtimeEvent, event: { type: AgentEventType.Ended, threadId: routing.threadId,
      turnExecutionId: routing.executionId, outcome: "errored", reason: failure.message } };
  }

  private admitBytes(queue: ProviderExecutionQueue, routing: CanonicalLiveEventRouting, bytes: number, runtimeEvent: ProviderRuntimeEvent): boolean {
    if (isParentTerminal(runtimeEvent)) return true;
    if (this.byteBudget === "unbounded" || queue.pendingBytes + bytes <= this.byteBudget) return true;
    this.fail(queue, routing, Object.assign(new Error(`CANONICAL_BACKLOG_BYTE_BUDGET: ${this.providerId} canonical save backlog exceeded its ${this.byteBudget} byte budget`),
      { code: "CANONICAL_BACKLOG_BYTE_BUDGET" }));
    logger.error("Provider canonical save backlog exhausted", { executionId: routing.executionId, pendingBytes: queue.pendingBytes, bytes });
    return false;
  }

  private admit(queue: ProviderExecutionQueue, routing: CanonicalLiveEventRouting, runtimeEvent: ProviderRuntimeEvent,
    sourceIdentities: readonly ProviderIdentity[], native: NativeLiveEventEvidence | string | undefined): boolean {
    const terminal = isParentTerminal(runtimeEvent);
    if (queue.failure && (this.failureLifetime === "provider" || !terminal)) return false;
    if (typeof native === "string" && this.replayed(queue, routing, runtimeEvent, sourceIdentities, native)) return false;
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
      pendingBytes: 0,
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
    if (queue.nativeEvents.size >= NATIVE_REPLAY_WINDOW) {
      const oldest = queue.nativeEvents.keys().next().value;
      if (oldest !== undefined) queue.nativeEvents.delete(oldest);
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
      ...volatileIngestClass(runtimeEvent.event),
      ...(LIVE_DELIVERY_PROVIDERS.has(this.providerId) && agentEventDelivery(runtimeEvent.event) === "live" ? { delivery: "live" as const } : {}),
      payload: {
        type: "item.recorded",
        item: {
          id: itemId,
          threadId: routing.threadId,
          turnId: routing.turnId,
          kind: "system",
          providerIdentities: [...sourceIdentities],
          payload: { projection: "providerRuntimeEvent", runtimeEvent: {
            ...runtimeEvent, event: { ...runtimeEvent.event, turnExecutionId: routing.executionId },
          }, ...(native ? { native } : { provenance: "generated" }) },
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

function isParentTerminal(runtimeEvent: ProviderRuntimeEvent): boolean {
  if (isChildRoutedRuntimeEvent(runtimeEvent.extension)) return false;
  return runtimeEvent.event.type === AgentEventType.TurnComplete || runtimeEvent.event.type === AgentEventType.Ended;
}
