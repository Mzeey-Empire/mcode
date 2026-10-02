import type { AgentEvent, AgentModelState, AcceptedCanonicalAgentEventEnvelope } from "@mcode/contracts";

type PublicationRoute = Pick<AcceptedCanonicalAgentEventEnvelope, "routing">;

function knownChildFamily(state: AgentModelState, ownerThreadId: string, childThreadId: string): boolean {
  const owner = state.threads[ownerThreadId];
  const child = state.threads[childThreadId];
  return owner !== undefined && child !== undefined && child.rootThreadId === owner.rootThreadId
    && (child.owningParentThreadId === ownerThreadId || child.parentThreadId === ownerThreadId);
}

function parentTurnMatches(envelope: PublicationRoute, state: AgentModelState): boolean {
  if (!envelope.routing.turnId) return false;
  const parentTurn = state.turns[envelope.routing.turnId];
  return parentTurn?.threadId === envelope.routing.threadId && parentTurn.executionId === envelope.routing.executionId;
}

function childSystemNotice(event: AgentEvent, envelope: PublicationRoute, state: AgentModelState): boolean {
  if (event.type !== "system" || !event.turnExecutionId || event.subtype === "provider.session.started") return false;
  return knownChildFamily(state, envelope.routing.threadId, event.threadId) && parentTurnMatches(envelope, state)
    && Object.values(state.turns).some((turn) => turn.threadId === event.threadId && turn.executionId === event.turnExecutionId);
}

/** Only correlated family system notices may cross an owner's publication route. */
export function acceptsCanonicalPublicationRoute(event: AgentEvent, envelope: PublicationRoute, state?: AgentModelState): boolean {
  if (event.threadId === envelope.routing.threadId) {
    return !event.turnExecutionId || event.turnExecutionId === envelope.routing.executionId;
  }
  return state !== undefined && childSystemNotice(event, envelope, state);
}
