import type { AgentEvent } from "@mcode/contracts";
import type { CanonicalAgentBoundary } from "./canonical-agent-boundary.js";

/**
 * Delivers server-synthesized agent events through the canonical stream. The
 * committed publication envelopes are returned so callers can observe them.
 */
export function publishSynthesizedAgentEvents(
  canonical: Pick<CanonicalAgentBoundary, "recordSynthesizedPublications">,
  threadId: string,
  events: readonly AgentEvent[],
): void {
  canonical.recordSynthesizedPublications(threadId, events);
}
