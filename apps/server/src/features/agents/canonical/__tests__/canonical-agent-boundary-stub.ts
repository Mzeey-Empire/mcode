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
  } as unknown as CanonicalAgentBoundary;
}
