import { AgentEventType, type AgentEvent } from "@mcode/contracts/events/agent-event";
import { CanonicalAgentEventEnvelopeSchema, type CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import { ProviderIdSchema } from "@mcode/contracts/models/settings";
import { ProviderRuntimeEventSchema, type ProviderRuntimeEvent } from "@mcode/contracts/events/provider-runtime-event";
import { type ProviderId } from "@mcode/contracts/providers/interfaces";

import type {
  CanonicalProviderEventReceipt,
  ProviderEventIngressDiagnostic,
  ProviderEventIngressEvent,
  ProviderEventSourceKind,
} from "./provider-event-ingress.js";

/** One untrusted provider runtime event or canonical envelope to validate and normalize. */
export type ProviderEventNormalizationInput =
  | {
    kind: "provider-runtime";
    providerId: unknown;
    runtimeEvent: unknown;
  }
  | {
    kind: "canonical-commit";
    envelope: unknown;
  };

/** A validated event or its content-free rejection. */
export type ProviderEventNormalization =
  | { status: "accepted"; event: ProviderEventIngressEvent }
  | { status: "rejected"; diagnostic: ProviderEventIngressDiagnostic };

/** Return a canonical identity early enough to coalesce duplicate in-flight work. */
function canonicalEventIdentity(task: ProviderEventNormalizationInput): string | undefined {
  return task.kind === "canonical-commit" ? directString(task.envelope, "eventId") : undefined;
}

/** Validate and normalize one provider payload without server dependencies. */
export function normalizeProviderEvent(task: ProviderEventNormalizationInput): ProviderEventNormalization {
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
  task: Extract<ProviderEventNormalizationInput, { kind: "provider-runtime" }>,
): ProviderEventNormalization {
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
  task: Extract<ProviderEventNormalizationInput, { kind: "canonical-commit" }>,
): ProviderEventNormalization {
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
    ...(runtimeEvent.deliveryAttempt !== undefined ? { deliveryAttempt: runtimeEvent.deliveryAttempt } : {}),
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

function accepted(event: ProviderEventIngressEvent): ProviderEventNormalization {
  return { status: "accepted", event };
}

function rejected(diagnostic: ProviderEventIngressDiagnostic): ProviderEventNormalization {
  return { status: "rejected", diagnostic };
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
