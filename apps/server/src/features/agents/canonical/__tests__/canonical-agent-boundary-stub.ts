import type { CanonicalAgentBoundary } from "../../index.js";
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
    // Synthesized publications bypass persistence but keep the publication.recorded shape so the
    // legacy broadcast side effect survives in tests without a canonical store.
    recordSynthesizedPublications: (_threadId: string, events: readonly Record<string, unknown>[]) =>
      events.map((event, index) => ({
        payload: {
          type: "publication.recorded",
          publicationId: String(index + 1),
          event: { ...event, publicationId: String(index + 1) },
        },
      })),
  } as unknown as CanonicalAgentBoundary;
}
