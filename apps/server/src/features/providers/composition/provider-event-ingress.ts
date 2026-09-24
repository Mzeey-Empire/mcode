import { logger } from "@mcode/shared";
import {
  AgentEventType,
  isTurnDiffSource,
  CanonicalAgentEventEnvelopeSchema,
  ProviderIdSchema,
  ProviderRuntimeEventSchema,
  type AgentEvent,
  type CanonicalAgentEventEnvelope,
  type IProviderRegistry,
  type ProviderFileMutationStart,
  type ProviderTurnDiffUpdate,
  type ProviderId,
  type ProviderRuntimeEvent,
} from "@mcode/contracts";
import { inject, injectable } from "tsyringe";

import {
  CODEX_PROVIDER_EVENT_ADAPTER,
  type ProviderEventAdapter,
} from "./provider-event-adapter.js";
import { normalizeProviderError } from "./provider-error-normalize.js";

const MAX_PENDING_PROVIDER_EVENTS = 1_024;
const MAX_PENDING_PROVIDER_EVENTS_PER_THREAD = 256;
const MAX_PENDING_PROVIDER_EVENT_BYTES = 1_024 * 1_024;
const MAX_PENDING_PROVIDER_EVENT_BYTES_PER_THREAD = 256 * 1_024;
const MAX_PENDING_TERMINAL_EVENTS = 32;
const MAX_PENDING_TERMINAL_EVENTS_PER_THREAD = 4;
const MAX_PENDING_TERMINAL_EVENT_BYTES = 4 * 1_024;
const RESERVED_TERMINAL_EVENT_BYTES = MAX_PENDING_TERMINAL_EVENTS * MAX_PENDING_TERMINAL_EVENT_BYTES;
const RESERVED_TERMINAL_EVENT_BYTES_PER_THREAD =
  MAX_PENDING_TERMINAL_EVENTS_PER_THREAD * MAX_PENDING_TERMINAL_EVENT_BYTES;
const MAX_PROVIDER_EVENTS_PER_DRAIN = 64;
const QUEUE_DIAGNOSTIC_INTERVAL_MS = 1_000;
const MAX_CANONICAL_EVENT_IDENTITIES = 16_384;

/** Injection token for the content-free provider ingress diagnostic sink. */
export const PROVIDER_EVENT_INGRESS_DIAGNOSTIC_SINK = Symbol("ProviderEventIngressDiagnosticSink");

/** Identifies the transport path that delivered one provider runtime event. */
export type ProviderEventSourceKind = "provider-runtime" | "canonical-commit";

/** Durable canonical metadata that must remain attached to a projected live event. */
export interface CanonicalProviderEventReceipt {
  eventId: string;
  sourceSequence?: number;
  acceptedSequence: number;
  durableRevision: number;
  serverTimestamps: CanonicalAgentEventEnvelope["serverTimestamps"];
}

/** One validated provider event before the turn pipeline processes it. */
export interface ProviderEventIngressEvent {
  providerId: ProviderId;
  sourceKind: ProviderEventSourceKind;
  event: AgentEvent;
  runtimeExtension?: ProviderRuntimeEvent["extension"];
  canonicalReceipt?: CanonicalProviderEventReceipt;
}

/** Narrow downstream contract used until TurnEventPipeline owns provider event handling. */
export interface ProviderEventIngressConsumer {
  handleProviderEvent(event: ProviderEventIngressEvent): void;
  handleProviderFileMutation(event: ProviderFileMutationStart): void;
  handleProviderTurnDiff(event: ProviderTurnDiffUpdate): void;
  /** Stop one turn when ingress cannot retain one of its provider events. */
  handleProviderIngressOverflow?(event: ProviderEventIngressEvent): void;
}

/** Content-free diagnostic recorded when ingress rejects an event or reaches queue pressure. */
export interface ProviderEventIngressDiagnostic {
  reason: "invalid-canonical-envelope" | "invalid-runtime-event" | "provider-identity-mismatch" | "runtime-extension-mismatch" | "duplicate-event" | "queue-capacity" | "queue-pressure" | "adapter-rejected";
  sourceKind: ProviderEventSourceKind;
  providerId?: string;
  eventId?: string;
  threadId?: string;
  queueDepth?: number;
  threadQueueDepth?: number;
  queuedThreadCount?: number;
  queueLagMs?: number;
  rejectedQueueEvents?: number;
  queueBytes?: number;
  threadQueueBytes?: number;
  queueCapacity?: "global" | "thread" | "global-bytes" | "thread-bytes" | "terminal";
}

/** Receives content-free ingress diagnostics. */
export type ProviderEventIngressDiagnosticSink = (diagnostic: ProviderEventIngressDiagnostic) => void;

/** Content-free snapshot of the fair ingress queues. */
export interface ProviderEventIngressQueueMetrics {
  pendingEvents: number;
  pendingBytes: number;
  queuedThreadCount: number;
  largestThreadDepth: number;
  largestThreadBytes: number;
  oldestEventLagMs: number;
  rejectedQueueEvents: number;
}

interface QueuedProviderEvent {
  event: ProviderEventIngressEvent;
  queuedAt: number;
  byteLength: number;
  terminal: boolean;
}

/** Log a content-free ingress diagnostic when no application-specific sink is registered. */
export function logProviderEventIngressDiagnostic(diagnostic: ProviderEventIngressDiagnostic): void {
  logger.warn("Provider event ingress diagnostic", diagnostic);
}

function canonicalReceipt(envelope: CanonicalAgentEventEnvelope): CanonicalProviderEventReceipt {
  return {
    eventId: envelope.eventId,
    sourceSequence: envelope.sourceSequence,
    acceptedSequence: envelope.acceptedSequence,
    durableRevision: envelope.durableRevision,
    serverTimestamps: envelope.serverTimestamps,
  };
}

function agentEventMatchesProvider(event: AgentEvent, providerId: ProviderId): boolean {
  return !("providerId" in event) || event.providerId === undefined || event.providerId === providerId;
}

/** Removes presentation data that only server-side provider adapters may create. */
function withoutUntrustedSubagentPresentation(event: AgentEvent): AgentEvent {
  if (event.type !== AgentEventType.ToolUse && event.type !== AgentEventType.ToolResult) return event;
  const { subagentPresentation: _subagentPresentation, ...sanitized } = event;
  return sanitized;
}

function isTerminalLifecycleEvent(event: AgentEvent): boolean {
  return event.type === AgentEventType.TurnComplete
    || event.type === AgentEventType.Error
    || event.type === AgentEventType.Ended;
}

function serializedEventByteLength(event: AgentEvent): number {
  try {
    const serialized = JSON.stringify(event);
    return serialized ? Buffer.byteLength(serialized, "utf8") : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Owns provider subscriptions, validates inbound delivery, and queues accepted downstream events. */
@injectable()
export class ProviderEventIngress {
  private readonly seenLegacyEvents = new WeakSet<object>();
  private readonly seenCanonicalEventIds = new Map<string, true>();
  private readonly pendingByThread = new Map<string, QueuedProviderEvent[]>();
  private readonly pendingBytesByThread = new Map<string, number>();
  private readonly pendingTerminalEventsByThread = new Map<string, number>();
  private readonly readyThreadIds: string[] = [];
  private readonly lastQueueDiagnosticAt = new Map<"queue-capacity" | "queue-pressure", number>();
  private consumer: ProviderEventIngressConsumer | undefined;
  private started = false;
  private drainScheduled = false;
  private pendingEventCount = 0;
  private pendingByteCount = 0;
  private pendingTerminalEventCount = 0;
  private rejectedQueueEvents = 0;

  constructor(
    @inject(PROVIDER_EVENT_INGRESS_DIAGNOSTIC_SINK)
    private readonly diagnostics: ProviderEventIngressDiagnosticSink = logProviderEventIngressDiagnostic,
    @inject(CODEX_PROVIDER_EVENT_ADAPTER, { isOptional: true })
    private readonly codexAdapter?: ProviderEventAdapter,
  ) {}

  /** Subscribe once after providers and the downstream event consumer exist. */
  start(providerRegistry: IProviderRegistry, consumer: ProviderEventIngressConsumer): void {
    if (this.started) return;
    this.started = true;
    this.consumer = consumer;
    for (const provider of providerRegistry.resolveAll()) {
      provider.on("file_mutation_start", (event) => consumer.handleProviderFileMutation(event));
      if (isTurnDiffSource(provider)) provider.onTurnDiff((event) => consumer.handleProviderTurnDiff(event));
      provider.on("event", (event) => this.acceptProviderRuntime(provider.id, event));
    }
    if (this.pendingEventCount > 0) this.scheduleDrain();
  }

  /** Return a content-free snapshot suitable for bounded load diagnostics. */
  queueMetrics(now: number = Date.now()): ProviderEventIngressQueueMetrics {
    let largestThreadDepth = 0;
    let largestThreadBytes = 0;
    let oldestQueuedAt = now;
    for (const queue of this.pendingByThread.values()) {
      largestThreadDepth = Math.max(largestThreadDepth, queue.length);
      const oldest = queue[0];
      if (oldest) oldestQueuedAt = Math.min(oldestQueuedAt, oldest.queuedAt);
    }
    for (const queuedBytes of this.pendingBytesByThread.values()) {
      largestThreadBytes = Math.max(largestThreadBytes, queuedBytes);
    }
    return {
      pendingEvents: this.pendingEventCount,
      pendingBytes: this.pendingByteCount,
      queuedThreadCount: this.pendingByThread.size,
      largestThreadDepth,
      largestThreadBytes,
      oldestEventLagMs: this.pendingEventCount === 0 ? 0 : Math.max(0, now - oldestQueuedAt),
      rejectedQueueEvents: this.rejectedQueueEvents,
    };
  }

  /** Accept one provider-originated runtime event that has no canonical receipt. */
  acceptProviderRuntime(providerId: ProviderId, runtimeEvent: unknown): void {
    const parsedProviderId = ProviderIdSchema.safeParse(providerId);
    if (!parsedProviderId.success) {
      this.report({ reason: "provider-identity-mismatch", sourceKind: "provider-runtime", providerId: String(providerId) });
      return;
    }
    if (!runtimeEvent || typeof runtimeEvent !== "object") {
      this.report({ reason: "invalid-runtime-event", sourceKind: "provider-runtime", providerId: parsedProviderId.data });
      return;
    }
    const parsedRuntimeEvent = this.parseLegacyRuntimeEvent(parsedProviderId.data, runtimeEvent);
    if (!parsedRuntimeEvent) return;
    this.seenLegacyEvents.add(runtimeEvent);
    this.acceptRuntimeEvent({
      providerId: parsedProviderId.data,
      sourceKind: "provider-runtime",
      event: parsedRuntimeEvent.event,
      ...(parsedRuntimeEvent.extension ? { runtimeExtension: parsedRuntimeEvent.extension } : {}),
    });
  }

  private parseLegacyRuntimeEvent(providerId: ProviderId, runtimeEvent: object): ProviderRuntimeEvent | undefined {
    if (this.seenLegacyEvents.has(runtimeEvent)) {
      this.report({ reason: "duplicate-event", sourceKind: "provider-runtime", providerId });
      return undefined;
    }
    const parsed = ProviderRuntimeEventSchema().safeParse(runtimeEvent);
    if (!parsed.success || !agentEventMatchesProvider(parsed.data.event, providerId)) {
      this.report({ reason: "invalid-runtime-event", sourceKind: "provider-runtime", providerId });
      return undefined;
    }
    if (parsed.data.extension?.providerId !== undefined && parsed.data.extension.providerId !== providerId) {
      this.report({ reason: "runtime-extension-mismatch", sourceKind: "provider-runtime", providerId });
      return undefined;
    }
    return parsed.data;
  }

  /** Accept one committed canonical batch and queue its runtime events in receipt order. */
  acceptCommitted(envelopes: readonly CanonicalAgentEventEnvelope[]): void {
    for (const envelope of envelopes) this.acceptCanonicalEnvelope(envelope);
  }

  private acceptCanonicalEnvelope(envelope: unknown): void {
    const parsedEnvelope = CanonicalAgentEventEnvelopeSchema.safeParse(envelope);
    if (!parsedEnvelope.success) {
      this.report({ reason: "invalid-canonical-envelope", sourceKind: "canonical-commit" });
      return;
    }
    const parsedProviderId = ProviderIdSchema.safeParse(parsedEnvelope.data.sourceProviderId);
    if (!parsedProviderId.success) {
      this.report({
        reason: "provider-identity-mismatch",
        sourceKind: "canonical-commit",
        providerId: parsedEnvelope.data.sourceProviderId,
        eventId: parsedEnvelope.data.eventId,
      });
      return;
    }
    const runtimeEvent = this.projectCanonicalRuntimeEvent(parsedEnvelope.data, parsedProviderId.data);
    if (!runtimeEvent) return;
    if (this.seenCanonicalEventIds.has(parsedEnvelope.data.eventId)) {
      this.report({
        reason: "duplicate-event",
        sourceKind: "canonical-commit",
        providerId: parsedProviderId.data,
        eventId: parsedEnvelope.data.eventId,
      });
      return;
    }
    const accepted = this.acceptRuntimeEvent({
      providerId: parsedProviderId.data,
      sourceKind: "canonical-commit",
      event: runtimeEvent.event,
      ...(runtimeEvent.extension ? { runtimeExtension: runtimeEvent.extension } : {}),
      canonicalReceipt: canonicalReceipt(parsedEnvelope.data),
    });
    if (accepted) this.rememberCanonicalEvent(parsedEnvelope.data.eventId);
  }

  private projectCanonicalRuntimeEvent(
    envelope: CanonicalAgentEventEnvelope,
    providerId: ProviderId,
  ): ProviderRuntimeEvent | undefined {
    if (!this.isProviderRuntimeItem(envelope)) return undefined;
    const { item } = envelope.payload;
    const parsedRuntimeEvent = ProviderRuntimeEventSchema().safeParse(item.payload.runtimeEvent);
    if (!parsedRuntimeEvent.success || !this.matchesCanonicalRouting(envelope, item, parsedRuntimeEvent.data, providerId)) {
      this.report({
        reason: "invalid-runtime-event",
        sourceKind: "canonical-commit",
        providerId: envelope.sourceProviderId,
        eventId: envelope.eventId,
      });
      return undefined;
    }
    return parsedRuntimeEvent.data;
  }

  private isProviderRuntimeItem(
    envelope: CanonicalAgentEventEnvelope,
  ): envelope is CanonicalAgentEventEnvelope & {
    payload: Extract<CanonicalAgentEventEnvelope["payload"], { type: "item.recorded" }>;
  } {
    return envelope.payload.type === "item.recorded"
      && envelope.payload.item.payload.projection === "providerRuntimeEvent";
  }

  private matchesCanonicalRouting(
    envelope: CanonicalAgentEventEnvelope,
    item: Extract<CanonicalAgentEventEnvelope["payload"], { type: "item.recorded" }>['item'],
    runtimeEvent: ProviderRuntimeEvent,
    providerId: ProviderId,
  ): boolean {
    return this.matchesItemRouting(envelope, item)
      && runtimeEvent.event.threadId === envelope.routing.threadId
      && runtimeEvent.event.turnExecutionId === envelope.routing.executionId
      && agentEventMatchesProvider(runtimeEvent.event, providerId)
      && this.matchesRuntimeExtension(runtimeEvent, providerId);
  }

  private matchesItemRouting(
    envelope: CanonicalAgentEventEnvelope,
    item: Extract<CanonicalAgentEventEnvelope["payload"], { type: "item.recorded" }>['item'],
  ): boolean {
    return envelope.routing.threadId === item.threadId
      && envelope.routing.turnId === item.turnId
      && envelope.routing.itemId === item.id;
  }

  private matchesRuntimeExtension(runtimeEvent: ProviderRuntimeEvent, providerId: ProviderId): boolean {
    return runtimeEvent.extension?.providerId === undefined || runtimeEvent.extension.providerId === providerId;
  }

  private acceptRuntimeEvent(event: ProviderEventIngressEvent): boolean {
    const trustedEvent = { ...event, event: withoutUntrustedSubagentPresentation(event.event) };
    const projection = this.adapterFor(trustedEvent.providerId)?.project(trustedEvent)
      ?? { status: "forward" as const, event: trustedEvent.event };
    if (projection.status === "consumed") return true;
    if (projection.status === "rejected") {
      this.report({
        reason: "adapter-rejected",
        sourceKind: event.sourceKind,
        providerId: event.providerId,
        eventId: event.canonicalReceipt?.eventId,
      });
      return true;
    }
    const normalized = projection.event.type === "error"
      ? { ...projection.event, error: normalizeProviderError(event.providerId, projection.event.error ?? "") }
      : projection.event;
    return this.enqueue({ ...trustedEvent, event: normalized });
  }

  private adapterFor(providerId: ProviderId): ProviderEventAdapter | undefined {
    return this.codexAdapter?.providerId === providerId ? this.codexAdapter : undefined;
  }

  private enqueue(event: ProviderEventIngressEvent): boolean {
    const threadId = event.event.threadId;
    const queue = this.pendingByThread.get(threadId);
    const terminal = isTerminalLifecycleEvent(event.event);
    const byteLength = serializedEventByteLength(event.event);
    const queueCapacity = this.queueCapacity({ event, queue, terminal, byteLength });
    if (queueCapacity) {
      this.rejectedQueueEvents += 1;
      this.reportQueueDiagnostic("queue-capacity", event, queue?.length ?? 0, queueCapacity);
      this.consumer?.handleProviderIngressOverflow?.(event);
      return false;
    }
    const queued = queue ?? [];
    if (!queue) {
      this.pendingByThread.set(threadId, queued);
      this.readyThreadIds.push(threadId);
    }
    queued.push({ event, queuedAt: Date.now(), byteLength, terminal });
    this.pendingEventCount += 1;
    this.pendingByteCount += byteLength;
    this.pendingBytesByThread.set(threadId, (this.pendingBytesByThread.get(threadId) ?? 0) + byteLength);
    if (terminal) {
      this.pendingTerminalEventCount += 1;
      this.pendingTerminalEventsByThread.set(threadId, (this.pendingTerminalEventsByThread.get(threadId) ?? 0) + 1);
    }
    this.reportQueuePressure(event, queued.length);
    this.scheduleDrain();
    return true;
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => this.drain());
  }

  private scheduleYieldedDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => this.drain());
  }

  private drain(): void {
    this.drainScheduled = false;
    if (!this.consumer) return;
    for (let delivered = 0; delivered < MAX_PROVIDER_EVENTS_PER_DRAIN; delivered += 1) {
      const queued = this.takeNextPendingEvent();
      if (!queued) break;
      this.consumer.handleProviderEvent(queued.event);
    }
    if (this.pendingEventCount > 0) this.scheduleYieldedDrain();
  }

  private takeNextPendingEvent(): QueuedProviderEvent | undefined {
    while (this.readyThreadIds.length > 0) {
      const threadId = this.readyThreadIds.shift();
      if (!threadId) return undefined;
      const queue = this.pendingByThread.get(threadId);
      const queued = queue?.shift();
      if (!queue || !queued) continue;
      this.pendingEventCount -= 1;
      this.pendingByteCount -= queued.byteLength;
      this.decrementThreadBytes(threadId, queued.byteLength);
      if (queued.terminal) this.decrementTerminalEvents(threadId);
      if (queue.length === 0) this.pendingByThread.delete(threadId);
      else this.readyThreadIds.push(threadId);
      return queued;
    }
    return undefined;
  }

  private reportQueuePressure(event: ProviderEventIngressEvent, threadQueueDepth: number): void {
    if (this.pendingEventCount < MAX_PROVIDER_EVENTS_PER_DRAIN) return;
    this.reportQueueDiagnostic("queue-pressure", event, threadQueueDepth);
  }

  private reportQueueDiagnostic(
    reason: "queue-capacity" | "queue-pressure",
    event: ProviderEventIngressEvent,
    threadQueueDepth: number,
    queueCapacity?: "global" | "thread" | "global-bytes" | "thread-bytes" | "terminal",
  ): void {
    const now = Date.now();
    const lastReportedAt = this.lastQueueDiagnosticAt.get(reason);
    if (lastReportedAt !== undefined && now - lastReportedAt < QUEUE_DIAGNOSTIC_INTERVAL_MS) return;
    this.lastQueueDiagnosticAt.set(reason, now);
    const metrics = this.queueMetrics(now);
    this.report({
      reason,
      sourceKind: event.sourceKind,
      providerId: event.providerId,
      eventId: event.canonicalReceipt?.eventId,
      threadId: event.event.threadId,
      queueDepth: metrics.pendingEvents,
      threadQueueDepth,
      queuedThreadCount: metrics.queuedThreadCount,
      queueLagMs: metrics.oldestEventLagMs,
      queueBytes: metrics.pendingBytes,
      threadQueueBytes: this.pendingBytesByThread.get(event.event.threadId) ?? 0,
      rejectedQueueEvents: metrics.rejectedQueueEvents,
      ...(queueCapacity ? { queueCapacity } : {}),
    });
  }

  private queueCapacity(input: {
    event: ProviderEventIngressEvent;
    queue: QueuedProviderEvent[] | undefined;
    terminal: boolean;
    byteLength: number;
  }): "global" | "thread" | "global-bytes" | "thread-bytes" | "terminal" | undefined {
    const threadId = input.event.event.threadId;
    const threadCount = input.queue?.length ?? 0;
    const threadBytes = this.pendingBytesByThread.get(threadId) ?? 0;
    const terminalCount = this.pendingTerminalEventsByThread.get(threadId) ?? 0;
    if (input.terminal && (
      this.pendingTerminalEventCount >= MAX_PENDING_TERMINAL_EVENTS
      || terminalCount >= MAX_PENDING_TERMINAL_EVENTS_PER_THREAD
      || input.byteLength > MAX_PENDING_TERMINAL_EVENT_BYTES
    )) return "terminal";
    const eventLimit = input.terminal
      ? MAX_PENDING_PROVIDER_EVENTS
      : MAX_PENDING_PROVIDER_EVENTS - MAX_PENDING_TERMINAL_EVENTS;
    if (this.pendingEventCount >= eventLimit) return "global";
    const threadEventLimit = input.terminal
      ? MAX_PENDING_PROVIDER_EVENTS_PER_THREAD
      : MAX_PENDING_PROVIDER_EVENTS_PER_THREAD - MAX_PENDING_TERMINAL_EVENTS_PER_THREAD;
    if (threadCount >= threadEventLimit) return "thread";
    const byteLimit = input.terminal
      ? MAX_PENDING_PROVIDER_EVENT_BYTES
      : MAX_PENDING_PROVIDER_EVENT_BYTES - RESERVED_TERMINAL_EVENT_BYTES;
    if (this.pendingByteCount + input.byteLength > byteLimit) return "global-bytes";
    const threadByteLimit = input.terminal
      ? MAX_PENDING_PROVIDER_EVENT_BYTES_PER_THREAD
      : MAX_PENDING_PROVIDER_EVENT_BYTES_PER_THREAD - RESERVED_TERMINAL_EVENT_BYTES_PER_THREAD;
    if (threadBytes + input.byteLength > threadByteLimit) return "thread-bytes";
    return undefined;
  }

  private decrementThreadBytes(threadId: string, byteLength: number): void {
    const remainingBytes = (this.pendingBytesByThread.get(threadId) ?? 0) - byteLength;
    if (remainingBytes > 0) this.pendingBytesByThread.set(threadId, remainingBytes);
    else this.pendingBytesByThread.delete(threadId);
  }

  private decrementTerminalEvents(threadId: string): void {
    this.pendingTerminalEventCount -= 1;
    const remainingEvents = (this.pendingTerminalEventsByThread.get(threadId) ?? 0) - 1;
    if (remainingEvents > 0) this.pendingTerminalEventsByThread.set(threadId, remainingEvents);
    else this.pendingTerminalEventsByThread.delete(threadId);
  }

  private rememberCanonicalEvent(eventId: string): void {
    this.seenCanonicalEventIds.set(eventId, true);
    if (this.seenCanonicalEventIds.size > MAX_CANONICAL_EVENT_IDENTITIES) {
      const oldestEventId = this.seenCanonicalEventIds.keys().next().value as string | undefined;
      if (oldestEventId) this.seenCanonicalEventIds.delete(oldestEventId);
    }
  }

  private report(diagnostic: ProviderEventIngressDiagnostic): void {
    this.diagnostics(diagnostic);
  }
}
