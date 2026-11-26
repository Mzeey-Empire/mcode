import type { AgentEvent } from "@mcode/contracts/events/agent-event";

/** The time fields a provider draft and its committed envelope share. */
export interface ToolEventTimeSource {
  readonly providerTimestamp?: string;
  readonly createdAt: string;
}

/**
 * Stamps a tool start or result with the time its provider produced it: the provider's own time when the
 * adapter supplies one, else the time the server read it. The worker's publication and the writer's
 * re-projection of the stored envelope both call this, because the writer requires the two to match exactly.
 */
export function withToolEventTime(event: AgentEvent, source: ToolEventTimeSource): AgentEvent {
  if (event.type !== "toolUse" && event.type !== "toolResult") return event;
  return { ...event, occurredAt: event.occurredAt ?? source.providerTimestamp ?? source.createdAt };
}
