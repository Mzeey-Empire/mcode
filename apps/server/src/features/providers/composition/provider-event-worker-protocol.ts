import {
  AgentEventType,
  CanonicalAgentEventEnvelopeSchema,
  ProviderIdSchema,
  ProviderRuntimeEventSchema,
  type AgentEvent,
  type CanonicalAgentEventEnvelope,
  type ProviderId,
  type ProviderRuntimeEvent,
} from "@mcode/contracts";

import type {
  CanonicalProviderEventReceipt,
  ProviderEventIngressDiagnostic,
  ProviderEventIngressEvent,
  ProviderEventSourceKind,
} from "./provider-event-ingress.js";

/** One cloneable provider payload submitted to the fixed preprocessing pool. */
export type ProviderEventWorkerTask =
  | {
    kind: "provider-runtime";
    providerId: unknown;
    runtimeEvent: unknown;
  }
  | {
    kind: "canonical-commit";
    envelope: unknown;
  };

/** The only message sent from the server process to a provider event worker. */
export interface ProviderEventWorkerRequest {
  requestIds: readonly number[];
  tasks: readonly ProviderEventWorkerTask[];
}

/** A validated event or its content-free rejection returned by a worker. */
export type ProviderEventWorkerOutcome =
  | { status: "accepted"; event: ProviderEventIngressEvent }
  | { status: "rejected"; diagnostic: ProviderEventIngressDiagnostic };

/** The only message sent from a provider event worker to the server process. */
export interface ProviderEventWorkerResponse {
  requestIds: readonly number[];
  outcomes: readonly ProviderEventWorkerOutcome[];
}

/** Return the stable worker key without treating this shallow lookup as validation. */
export function providerEventWorkerThreadId(task: ProviderEventWorkerTask): string {
  const threadId = task.kind === "canonical-commit"
    ? nestedString(task.envelope, "routing", "threadId")
    : nestedString(task.runtimeEvent, "event", "threadId");
  return threadId ?? "__invalid-provider-event__";
}

/**
 * Identify terminal lifecycle payloads for bounded worker admission without
 * treating this shallow lookup as validation.
 */
export function isProviderEventWorkerTerminalTask(task: ProviderEventWorkerTask): boolean {
  const eventType = task.kind === "canonical-commit"
    ? nestedString(task.envelope, "payload", "item", "payload", "runtimeEvent", "event", "type")
    : nestedString(task.runtimeEvent, "event", "type");
  return eventType === AgentEventType.TurnComplete
    || eventType === AgentEventType.Error
    || eventType === AgentEventType.Ended;
}

/** Return a canonical identity early enough to coalesce duplicate in-flight work. */
export function canonicalEventIdentity(task: ProviderEventWorkerTask): string | undefined {
  return task.kind === "canonical-commit" ? directString(task.envelope, "eventId") : undefined;
}

/** Validate and normalize one cloneable provider payload without server dependencies. */
export function processProviderEventWorkerTask(task: ProviderEventWorkerTask): ProviderEventWorkerOutcome {
  try {
    return task.kind === "provider-runtime"
      ? processProviderRuntimeEvent(task)
      : processCanonicalEvent(task);
  } catch {
    return rejected({
      reason: "worker-failure",
      sourceKind: task.kind,
      providerId: task.kind === "provider-runtime" ? directString(task, "providerId") : undefined,
      eventId: canonicalEventIdentity(task),
    });
  }
}

function processProviderRuntimeEvent(
  task: Extract<ProviderEventWorkerTask, { kind: "provider-runtime" }>,
): ProviderEventWorkerOutcome {
  const parsedProviderId = ProviderIdSchema.safeParse(task.providerId);
  if (!parsedProviderId.success) {
    return rejected({
      reason: "provider-identity-mismatch",
      sourceKind: "provider-runtime",
      providerId: stringValue(task.providerId),
    });
  }
  const parsedRuntimeEvent = ProviderRuntimeEventSchema().safeParse(task.runtimeEvent);
  if (!parsedRuntimeEvent.success || !agentEventMatchesProvider(parsedRuntimeEvent.data.event, parsedProviderId.data)) {
    return rejected({
      reason: "invalid-runtime-event",
      sourceKind: "provider-runtime",
      providerId: parsedProviderId.data,
    });
  }
  if (parsedRuntimeEvent.data.extension?.providerId !== undefined
    && parsedRuntimeEvent.data.extension.providerId !== parsedProviderId.data) {
    return rejected({
      reason: "runtime-extension-mismatch",
      sourceKind: "provider-runtime",
      providerId: parsedProviderId.data,
    });
  }
  return accepted(runtimeIngressEvent(parsedProviderId.data, "provider-runtime", parsedRuntimeEvent.data));
}

function processCanonicalEvent(
  task: Extract<ProviderEventWorkerTask, { kind: "canonical-commit" }>,
): ProviderEventWorkerOutcome {
  const parsedEnvelope = CanonicalAgentEventEnvelopeSchema.safeParse(task.envelope);
  if (!parsedEnvelope.success) {
    return rejected({
      reason: "invalid-canonical-envelope",
      sourceKind: "canonical-commit",
      eventId: canonicalEventIdentity(task),
    });
  }
  const parsedProviderId = ProviderIdSchema.safeParse(parsedEnvelope.data.sourceProviderId);
  if (!parsedProviderId.success) {
    return rejected({
      reason: "provider-identity-mismatch",
      sourceKind: "canonical-commit",
      providerId: parsedEnvelope.data.sourceProviderId,
      eventId: parsedEnvelope.data.eventId,
    });
  }
  const parsedRuntimeEvent = canonicalRuntimeEvent(parsedEnvelope.data, parsedProviderId.data);
  if (!parsedRuntimeEvent) {
    return rejected({
      reason: "invalid-runtime-event",
      sourceKind: "canonical-commit",
      providerId: parsedEnvelope.data.sourceProviderId,
      eventId: parsedEnvelope.data.eventId,
    });
  }
  return accepted({
    ...runtimeIngressEvent(parsedProviderId.data, "canonical-commit", parsedRuntimeEvent),
    canonicalReceipt: canonicalReceipt(parsedEnvelope.data),
  });
}

function canonicalRuntimeEvent(
  envelope: CanonicalAgentEventEnvelope,
  providerId: ProviderId,
): ProviderRuntimeEvent | undefined {
  const item = canonicalProviderRuntimeItem(envelope);
  if (!item) return undefined;
  const runtimeEvent = ProviderRuntimeEventSchema().safeParse(item.payload.runtimeEvent);
  if (!runtimeEvent.success || !matchesCanonicalRouting(envelope, runtimeEvent.data, providerId)) return undefined;
  return runtimeEvent.data;
}

function matchesCanonicalRouting(
  envelope: CanonicalAgentEventEnvelope,
  runtimeEvent: ProviderRuntimeEvent,
  providerId: ProviderId,
): boolean {
  const item = canonicalProviderRuntimeItem(envelope);
  if (!item || !itemMatchesRouting(envelope, item)) return false;
  if (runtimeEvent.event.threadId !== envelope.routing.threadId) return false;
  if (runtimeEvent.event.turnExecutionId !== envelope.routing.executionId) return false;
  if (!agentEventMatchesProvider(runtimeEvent.event, providerId)) return false;
  return runtimeEvent.extension?.providerId === undefined || runtimeEvent.extension.providerId === providerId;
}

function canonicalProviderRuntimeItem(
  envelope: CanonicalAgentEventEnvelope,
): Extract<CanonicalAgentEventEnvelope["payload"], { type: "item.recorded" }>['item'] | undefined {
  if (envelope.payload.type !== "item.recorded") return undefined;
  return envelope.payload.item.payload.projection === "providerRuntimeEvent"
    ? envelope.payload.item
    : undefined;
}

function itemMatchesRouting(
  envelope: CanonicalAgentEventEnvelope,
  item: Extract<CanonicalAgentEventEnvelope["payload"], { type: "item.recorded" }>['item'],
): boolean {
  return envelope.routing.threadId === item.threadId
    && envelope.routing.turnId === item.turnId
    && envelope.routing.itemId === item.id;
}

function runtimeIngressEvent(
  providerId: ProviderId,
  sourceKind: ProviderEventSourceKind,
  runtimeEvent: ProviderRuntimeEvent,
): ProviderEventIngressEvent {
  return {
    providerId,
    sourceKind,
    event: normalizeEvent(runtimeEvent.event),
    ...(runtimeEvent.extension ? { runtimeExtension: runtimeEvent.extension } : {}),
  };
}

function normalizeEvent(event: AgentEvent): AgentEvent {
  return withoutUntrustedSubagentPresentation(event);
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

function withoutUntrustedSubagentPresentation(event: AgentEvent): AgentEvent {
  if (event.type !== AgentEventType.ToolUse && event.type !== AgentEventType.ToolResult) return event;
  const { subagentPresentation: _subagentPresentation, ...sanitized } = event;
  return sanitized;
}

function accepted(event: ProviderEventIngressEvent): ProviderEventWorkerOutcome {
  return { status: "accepted", event };
}

function rejected(diagnostic: ProviderEventIngressDiagnostic): ProviderEventWorkerOutcome {
  return { status: "rejected", diagnostic };
}

function nestedString(value: unknown, ...keys: readonly string[]): string | undefined {
  try {
    let current = value;
    for (const key of keys) {
      if (!current || typeof current !== "object") return undefined;
      current = Reflect.get(current, key);
    }
    return stringValue(current);
  } catch {
    return undefined;
  }
}

function directString(value: unknown, key: string): string | undefined {
  try {
    if (!value || typeof value !== "object") return undefined;
    return stringValue(Reflect.get(value, key));
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
