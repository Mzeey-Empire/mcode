import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { CanonicalAgentBoundary } from "./canonical-agent-boundary.js";

/**
 * Admits server-synthesized agent events through the canonical stream's ordered owner.
 */
export function publishSynthesizedAgentEvents(
  canonical: Pick<CanonicalAgentBoundary, "recordSynthesizedPublications">,
  threadId: string,
  events: readonly AgentEvent[],
): void {
  canonical.recordSynthesizedPublications(threadId, events);
}
