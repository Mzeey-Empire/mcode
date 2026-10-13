import { ProviderRuntimeEventSchema, ProviderIdSchema, CollaborationObservationChangeSchema, type AgentEvent, type AgentModelState,
  type CollaborationObservationChange, type ProviderRuntimeEvent, type ProviderId } from "@mcode/contracts";
import type { ExecutionSemanticOperation } from "../execution/execution-worker-handler.js";
import type { CanonicalAgentEventDraft } from "./canonical-agent-boundary.js";
import { AcceptedCodexCollaboration } from "./accepted-codex-collaboration.js";

type AcceptedRuntime = { readonly sourceProviderId: ProviderId; readonly event: ProviderRuntimeEvent };

/** Reuse the native adapter against current accepted records before the parent reserves its compound operation. */
export function prepareAcceptedCollaboration(state: AgentModelState, operation: ExecutionSemanticOperation,
  previous?: AcceptedCodexCollaboration):
  { readonly operation: ExecutionSemanticOperation; readonly events: readonly CanonicalAgentEventDraft[];
    readonly candidate?: AcceptedCodexCollaboration } {
  const runtime = singleAcceptedRuntime(acceptedRuntimeEvents(operation));
  if (!runtime) return { operation, events: [] };
  const adapter = previous ? previous.fork(state) : new AcceptedCodexCollaboration(state);
  const prepared = prepareRuntimeObservation(adapter, runtime, operation.livePublication);
  return { operation: { ...operation, livePublication: prepared.publications },
    events: collaborationEvents(operation, prepared.changes, runtime.sourceProviderId), candidate: adapter };
}

function acceptedRuntimeEvents(operation: ExecutionSemanticOperation): AcceptedRuntime[] {
  const mutation = operation.mutation;
  if (mutation.kind !== "append-events") return [];
  return mutation.events.flatMap((draft) => acceptedRuntimeEvent(draft));
}

function acceptedRuntimeEvent(draft: CanonicalAgentEventDraft): AcceptedRuntime[] {
  if (draft.payload.type !== "item.recorded") return [];
  if (draft.payload.item.payload.projection !== "providerRuntimeEvent") return [];
  const runtime = ProviderRuntimeEventSchema().parse(draft.payload.item.payload.runtimeEvent);
  return runtime.extension ? [{ sourceProviderId: ProviderIdSchema.parse(draft.sourceProviderId), event: runtime }] : [];
}

function singleAcceptedRuntime(runtimes: readonly AcceptedRuntime[]): AcceptedRuntime | undefined {
  const [runtime] = runtimes;
  if (!runtime) return undefined;
  if (runtimes.length !== 1) throw new Error("Collaboration delivery requires exactly one native observation");
  return runtime;
}

function prepareRuntimeObservation(adapter: AcceptedCodexCollaboration, accepted: AcceptedRuntime,
  fallbackPublications: ExecutionSemanticOperation["livePublication"]): {
    readonly changes: readonly CollaborationObservationChange[];
    readonly publications: ExecutionSemanticOperation["livePublication"];
  } {
  const runtime = accepted.event;
  if (!runtime.extension) return { changes: [], publications: fallbackPublications };
  if (runtime.extension.kind === "codex-collaboration" && runtime.extension.continuation) throw new Error("Native provider continuation has no supported producer");
  const prepared = adapter.prepare({ providerId: accepted.sourceProviderId, sourceKind: "provider-runtime", event: runtime.event,
    runtimeExtension: runtime.extension });
  return { changes: prepared.changes.map(observedChange), publications: collaborationPublications(adapter, prepared.projection) };
}

function collaborationPublications(adapter: AcceptedCodexCollaboration,
  projection: ReturnType<AcceptedCodexCollaboration["prepare"]>["projection"]): ExecutionSemanticOperation["livePublication"] {
  return projection.status === "forward" ? [{ after: "writer", event: childPublication(adapter, projection.event) }] : [];
}

function collaborationEvents(operation: ExecutionSemanticOperation,
  changes: readonly CollaborationObservationChange[], sourceProviderId: ProviderId): CanonicalAgentEventDraft[] {
  return changes.length === 0 ? [] : [{ eventId: `${operation.operationId}:collaboration`, routing: operation.execution,
    sourceProviderId, sourceIdentities: [], payload: { type: "collaboration.observed", changes: [...changes] } }];
}

function observedChange(change: import("./accepted-codex-collaboration.js").AcceptedCollaborationChange): CollaborationObservationChange {
  if (change.kind === "diagnostic") {
    const { diagnostic: _diagnostic, ...record } = change;
    return CollaborationObservationChangeSchema.parse(record);
  }
  return CollaborationObservationChangeSchema.parse(change);
}

function childPublication(adapter: AcceptedCodexCollaboration, event: AgentEvent): AgentEvent {
  const thread = adapter.loadThread(event.threadId);
  if (!thread?.parentThreadId) return event;
  const turn = adapter.loadLatestTurn(thread.id);
  if (!turn?.executionId) throw new Error("Accepted child publication has no exact execution");
  return { ...event, turnExecutionId: turn.executionId };
}
