import type { IProviderRegistry, PermissionRequest } from "@mcode/contracts";
import { AgentEventPublicationRegistry } from "./agent-event-publication-registry.js";
import type { AgentEventPublicationRuntime } from "./agent-event-publication-service.js";
import type { TurnPullRequestCompletionEffect } from "../../pull-requests/index.js";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { AgentEventPublicationService } from "./agent-event-publication-service.js";

interface AgentOrchestrationDependencies {
  runtime: AgentEventPublicationRuntime;
  publicationRegistry: AgentEventPublicationRegistry;
  threadRepo: ThreadRepo;
  pullRequestCompletionEffect: Pick<TurnPullRequestCompletionEffect, "schedule">;
  providerRegistry: IProviderRegistry;
  stopSession: (threadId: string) => Promise<unknown>;
  publishPermissionRequest: (request: PermissionRequest) => void;
  publishPermissionResolved: (payload: { requestId: string; decision: "allow" | "allow-session" | "deny" | "cancelled"; optionLabel?: string }) => void;
  publishThreadStatus: (payload: { threadId: string; status: "completed" | "errored" | "interrupted" }) => void;
}

/**
 * Start agent execution and publish each normalized provider event after its
 * synchronous internal pass; deferred replays do not publish duplicates.
 */
export function startAgentOrchestration({
  runtime,
  publicationRegistry,
  threadRepo,
  pullRequestCompletionEffect,
  providerRegistry,
  stopSession,
  publishPermissionRequest,
  publishPermissionResolved,
  publishThreadStatus,
}: AgentOrchestrationDependencies): void {
  const publication = new AgentEventPublicationService({
    runtime,
    threads: threadRepo,
    pullRequests: pullRequestCompletionEffect,
    providers: providerRegistry,
    stopSession,
    publishPermissionRequest,
    publishPermissionResolved,
    publishThreadStatus,
  });
  publication.start();
  publicationRegistry.bind((event) => publication.publish(event), () => publication.drain());
  publicationRegistry.start();
}
