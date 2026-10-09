import "reflect-metadata";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { AgentEventPublicationService } from "../agent-event-publication-service.js";
import { createOwnedTestDatabase } from "../../../projects/testing/owned-test-database.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";

async function fixture() {
  const database = createOwnedTestDatabase();
  const reader = openReadOnlyDatabase(database.db.filename);
  const workspace = await new WorkspaceRepo(reader, database.writer).create("Publication", "publication", false);
  const threads = new ThreadRepo(reader, database.writer);
  const thread = await threads.create(workspace.id, "Publication status", "direct", "main");
  const published: string[] = [];
  const publication = new AgentEventPublicationService({
    stopSession: async () => undefined,
    threads, pullRequests: { schedule() {} },
    runtime: { getCurrentFileEffectTurnId: () => undefined, shouldSuppressTurnEnded: () => false,
      shouldSuppressTurnComplete: () => false, shouldSuppressTransientTurnError: () => false },
    providers: { resolve: () => { throw new Error("No provider required"); }, resolveAll: () => [], async shutdown() {} },
    publishPermissionRequest() {}, publishPermissionResolved() {},
    publishThreadStatus: (event) => published.push(event.status),
  });
  return { database, reader, threads, thread, published, publication };
}

describe("provider publication status persistence", () => {
  it("publishes while an actual writer is locked and drains before ownership closes", async () => {
    const state = await fixture();
    const peer = new Database(state.database.db.filename, { strict: true });
    try {
      peer.run("BEGIN IMMEDIATE");
      state.publication.publish({ type: "error", threadId: state.thread.id, error: "Provider failed" });
      expect(state.published).toEqual(["errored"]);
      let drained = false;
      const closing = state.publication.drain().then(() => { drained = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(drained).toBe(false);
      expect(state.threads.findById(state.thread.id)?.status).toBe("active");
      peer.run("COMMIT");
      await closing;
      expect(state.threads.findById(state.thread.id)?.status).toBe("errored");
    } finally {
      if (peer.inTransaction) peer.run("ROLLBACK");
      peer.close(true); state.reader.close(true); await state.database.close();
    }
  });

  it("reports a failed status save while allowing a later publication to commit", async () => {
    const state = await fixture();
    try {
      await state.database.writer.setQueryOnlyForReliability(true);
      state.publication.publish({ type: "error", threadId: state.thread.id, error: "First failure" });
      await expect(state.publication.drain()).rejects.toThrow("Agent publication status saves failed");
      expect(state.published).toEqual(["errored"]);
      await state.database.writer.setQueryOnlyForReliability(false);
      state.publication.publish({ type: "ended", threadId: state.thread.id,
        turnExecutionId: "00000000-0000-4000-8000-000000000177", outcome: "completed" });
      await state.publication.drain();
      expect(state.published).toEqual(["errored", "completed"]);
      expect(state.threads.findById(state.thread.id)?.status).toBe("completed");
    } finally { state.reader.close(true); await state.database.close(); }
  });
});
