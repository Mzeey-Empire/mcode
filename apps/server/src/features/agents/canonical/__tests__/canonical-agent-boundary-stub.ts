import type { CanonicalAgentBoundary } from "../../index.js";
import { broadcast } from "../../../../application/transport/push.js";
import type { Database } from "bun:sqlite";

/** Creates an AgentService test seam that runs compatibility writes without canonical persistence. */
export function createCanonicalAgentBoundaryStub(
  db: Pick<Database, "transaction">,
): CanonicalAgentBoundary {
  return {
    startParentTurn: (
      input: Parameters<CanonicalAgentBoundary["startParentTurn"]>[0],
    ) => {
      db.transaction(input.projectUserMessage)();
      return {
        outcome: "committed",
        conversationRevision: 0,
        rosterRevision: 0,
        acceptedThrough: 0,
        durableThrough: 0,
        events: [],
      };
    },
    loadCheckpoint: () => null,
    loadTurnByExecution: () => null,
    loadCodexChildDelegationByReceiverThreadId: () => null,
    loadCanonicalChildStopTargets: () => [],
    finishCanonicalChildTurn: () => null,
    recordProviderDiagnostic: () => undefined,
    recordCodexChildRoutingDiagnostic: () => false,
    // Synthesized publications bypass persistence but keep the publication-stamped wire shape
    // so tests can observe the same event payload the renderer would project.
    recordSynthesizedPublications: (_threadId: string, events: readonly Record<string, unknown>[]) =>
      events.map((event, index) => {
        const stamped = { ...event, publicationId: String(index + 1) };
        broadcast("agent.event", stamped);
        return {
          payload: {
            type: "publication.recorded",
            publicationId: String(index + 1),
            event: stamped,
          },
        };
      }),
  } as unknown as CanonicalAgentBoundary;
}
