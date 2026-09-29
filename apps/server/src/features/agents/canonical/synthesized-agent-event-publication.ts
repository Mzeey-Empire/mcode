import type { AgentEvent } from "@mcode/contracts";
import { broadcast } from "../../../application/transport/push.js";
import type { CanonicalAgentBoundary } from "./canonical-agent-boundary.js";

/**
 * Delivers server-synthesized agent events through the canonical stream and the legacy broadcast.
 * Both copies share the allocated publicationId, so the client applies whichever copy arrives first.
 */
export function publishSynthesizedAgentEvents(
  canonical: Pick<CanonicalAgentBoundary, "recordSynthesizedPublications">,
  threadId: string,
  events: readonly AgentEvent[],
): void {
  for (const envelope of canonical.recordSynthesizedPublications(threadId, events)) {
    if (envelope.payload.type === "publication.recorded") {
      broadcast("agent.event", envelope.payload.event);
    }
  }
}
