import { AcceptedCanonicalAgentEventEnvelopeSchema } from "@mcode/contracts";
import { broadcast } from "../../../../application/transport/push.js";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { agentStorageTestWriter } from "../../__tests__/agent-storage-fixture.js";
import { CanonicalAgentBoundary } from "../canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../canonical-agent-writer-client.js";

/** Real parent admission with compatibility reads and publication-only observations for legacy fixtures. */
export function createCanonicalAgentBoundaryStub(
  db: Database,
  writer: ApplicationDatabaseWriter = agentStorageTestWriter(db),
): CanonicalAgentBoundary {
  const boundary = new CanonicalAgentBoundary(db, writer, new CanonicalAgentWriterClient(writer), () => undefined);
  boundary.loadCheckpoint = () => null;
  boundary.loadTurnByExecution = () => null;
  boundary.loadCodexChildDelegationByReceiverThreadId = () => null;
  boundary.loadCanonicalChildStopTargets = () => [];
  boundary.finishCanonicalChildTurn = async () => null;
  boundary.recordProviderDiagnostic = async () => undefined;
  boundary.recordCodexChildRoutingDiagnostic = async () => false;
  let sequence = 0;
  boundary.bindAcceptedSynthesizedPublications((threadId, events) => events.map((event) => {
    sequence += 1;
    const publicationId = String(sequence);
    const stamped = { ...event, publicationId };
    const accepted = AcceptedCanonicalAgentEventEnvelopeSchema.parse({
      eventId: "fixture:" + publicationId,
      routing: { threadId, turnId: "fixture-turn", executionId: "00000000-0000-4000-8000-000000000001" },
      sourceProviderId: "codex", sourceIdentities: [], acceptedSequence: sequence,
      progressPosition: { epoch: "fixture-epoch", sequence },
      serverTimestamps: { acceptedAt: new Date().toISOString() },
      payload: { type: "publication.recorded", publicationId, event: stamped },
    });
    broadcast("agent.canonical", {
      phase: "accepted", threadId, epoch: "fixture-epoch", from: sequence - 1, through: sequence, events: [accepted],
    });
    return accepted;
  }));
  return boundary;
}
