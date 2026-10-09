import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import { startAgentOrchestration } from "../start-agent-orchestration.js";
import { AgentEventPublicationRegistry } from "../agent-event-publication-registry.js";
import { createOwnedTestDatabase } from "../../../projects/testing/owned-test-database.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";

async function buildOrchestration() {
  const database = createOwnedTestDatabase();
  const reader = openReadOnlyDatabase(database.db.filename);
  await database.writer.whenReady();
  const workspace = await new WorkspaceRepo(reader, database.writer).create("Orchestration", "orchestration", false);
  const threadRepo = new ThreadRepo(reader, database.writer);
  const thread = await threadRepo.create(workspace.id, "Orchestration status", "direct", "main");
  vi.spyOn(threadRepo, "updateStatus");
  const runtime = {
    getCurrentFileEffectTurnId: vi.fn(() => undefined),
    shouldSuppressTurnEnded: vi.fn(() => false),
    shouldSuppressTurnComplete: vi.fn(() => false),
    shouldSuppressTransientTurnError: vi.fn(() => false),
  };
  const publicationRegistry = new AgentEventPublicationRegistry();
  const publishThreadStatus = vi.fn();
  const pullRequestCompletionEffect = { schedule: vi.fn() };

  startAgentOrchestration({
    stopSession: vi.fn(async () => undefined),
    runtime,
    publicationRegistry,
    threadRepo,
    pullRequestCompletionEffect,
    providerRegistry: { resolve: () => { throw new Error("No provider needed for orchestration publication"); },
      resolveAll: () => [], async shutdown() {} },
    publishPermissionRequest: vi.fn(),
    publishPermissionResolved: vi.fn(),
    publishThreadStatus,
  });

  expect(publicationRegistry.isBound()).toBe(true);
  return {
    publish: (event: AgentEvent) => publicationRegistry.publish(event),
    publicationRegistry,
    database,
    thread,
    runtime,
    threadRepo,
    publishThreadStatus,
    pullRequestCompletionEffect,
    async close() {
      try { await publicationRegistry.drain(); }
      finally { reader.close(true); await database.close(); }
    },
  };
}

describe("agent orchestration", () => {
  it("keeps terminal status publication on the parent event path", async () => {
    const orchestration = await buildOrchestration();
    try {
      orchestration.database.db.run("BEGIN IMMEDIATE");
      const event: AgentEvent = {
        type: AgentEventType.TurnComplete,
        threadId: orchestration.thread.id,
        reason: "completed",
        costUsd: null,
        tokensIn: 1,
        tokensOut: 1,
      };

      orchestration.publish(event);

      expect(orchestration.threadRepo.updateStatus).toHaveBeenCalledWith(orchestration.thread.id, "completed");
      expect(orchestration.publishThreadStatus).toHaveBeenCalledWith({
        threadId: orchestration.thread.id,
        status: "completed",
      });
      expect(orchestration.pullRequestCompletionEffect.schedule).toHaveBeenCalledWith(orchestration.thread.id);
      expect(orchestration.threadRepo.findById(orchestration.thread.id)?.status).toBe("active");
      let drained = false;
      const draining = orchestration.publicationRegistry.drain().then(() => { drained = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(drained).toBe(false);
      orchestration.database.db.run("COMMIT");
      await draining;
      expect(orchestration.threadRepo.findById(orchestration.thread.id)?.status).toBe("completed");
    } finally {
      if (orchestration.database.db.inTransaction) orchestration.database.db.run("ROLLBACK");
      await orchestration.close();
    }
  });

  it("suppresses a replayed terminal status but releases a committed terminal receipt", async () => {
    const orchestration = await buildOrchestration();
    try {
      orchestration.runtime.shouldSuppressTurnComplete.mockReturnValue(true);
      const legacy: AgentEvent = { type: AgentEventType.TurnComplete, threadId: orchestration.thread.id,
        reason: "completed", costUsd: null, tokensIn: 1, tokensOut: 1 };
      orchestration.publish(legacy);
      expect(orchestration.threadRepo.updateStatus).not.toHaveBeenCalled();

      const committed: AgentEvent = { ...legacy,
        turnExecutionId: "00000000-0000-4000-8000-000000000001", publicationId: "1" };
      orchestration.publish(committed);
      expect(orchestration.threadRepo.updateStatus).not.toHaveBeenCalled();
      expect(orchestration.publishThreadStatus).not.toHaveBeenCalled();
      expect(orchestration.pullRequestCompletionEffect.schedule).toHaveBeenCalledWith(orchestration.thread.id);
      await orchestration.publicationRegistry.drain();
      expect(orchestration.threadRepo.findById(orchestration.thread.id)?.status).toBe("active");
    } finally { await orchestration.close(); }
  });
});
