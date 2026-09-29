import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import { startAgentOrchestration } from "../start-agent-orchestration.js";
import { AgentEventPublicationRegistry } from "../agent-event-publication-registry.js";

function buildOrchestration() {
  let publish: ((event: AgentEvent) => void) | undefined;
  const runtime = {
    getCurrentFileEffectTurnId: vi.fn(() => undefined),
    shouldSuppressTurnEnded: vi.fn(() => false),
    shouldSuppressTurnComplete: vi.fn(() => false),
    shouldSuppressTransientTurnError: vi.fn(() => false),
  };
  const publicationRegistry = new AgentEventPublicationRegistry();
  publicationRegistry.bind = vi.fn((callback: (event: AgentEvent) => void) => {
    publish = callback;
  });
  const threadRepo = {
    findById: vi.fn(() => ({
      id: "thread-1",
      provider: "claude",
      branch: "main",
      workspace_id: "workspace-1",
      pr_number: null,
      pr_status: null,
    })),
    updateStatus: vi.fn(),
  };
  const publishThreadStatus = vi.fn();
  const pullRequestCompletionEffect = { schedule: vi.fn() };

  startAgentOrchestration({
    runtime,
    publicationRegistry,
    threadRepo,
    pullRequestCompletionEffect,
    providerRegistry: { resolveAll: vi.fn(() => []) },
    publishPermissionRequest: vi.fn(),
    publishPermissionResolved: vi.fn(),
    publishThreadStatus,
  } as never);

  if (!publish) throw new Error("orchestration did not register publication callback");
  return {
    publish,
    runtime,
    threadRepo,
    publishThreadStatus,
    pullRequestCompletionEffect,
  };
}

describe("agent orchestration", () => {
  it("keeps terminal status publication on the parent event path", () => {
    const orchestration = buildOrchestration();
    const event: AgentEvent = {
      type: AgentEventType.TurnComplete,
      threadId: "thread-1",
      reason: "completed",
      costUsd: null,
      tokensIn: 1,
      tokensOut: 1,
    };

    orchestration.publish(event);

    expect(orchestration.threadRepo.updateStatus).toHaveBeenCalledWith("thread-1", "completed");
    expect(orchestration.publishThreadStatus).toHaveBeenCalledWith({
      threadId: "thread-1",
      status: "completed",
    });
    expect(orchestration.pullRequestCompletionEffect.schedule).toHaveBeenCalledWith("thread-1");
  });

  it("suppresses a replayed terminal status but releases a committed terminal receipt", () => {
    const orchestration = buildOrchestration();
    orchestration.runtime.shouldSuppressTurnComplete.mockReturnValue(true);
    const legacy: AgentEvent = { type: AgentEventType.TurnComplete, threadId: "thread-1",
      reason: "completed", costUsd: null, tokensIn: 1, tokensOut: 1 };
    orchestration.publish(legacy);
    expect(orchestration.threadRepo.updateStatus).not.toHaveBeenCalled();

    const committed: AgentEvent = { ...legacy,
      turnExecutionId: "00000000-0000-4000-8000-000000000001", publicationId: "1" };
    orchestration.publish(committed);
    expect(orchestration.threadRepo.updateStatus).not.toHaveBeenCalled();
    expect(orchestration.publishThreadStatus).not.toHaveBeenCalled();
    expect(orchestration.pullRequestCompletionEffect.schedule).toHaveBeenCalledWith("thread-1");
  });
});
