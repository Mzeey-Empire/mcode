
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
  return boundary;
}
