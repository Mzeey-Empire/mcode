import { AgentEventType, type AgentEvent, type IProviderRegistry, type PermissionRequest } from "@mcode/contracts";
import type { TurnPullRequestCompletionEffect } from "../../pull-requests/index.js";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { publishParentProviderEvent } from "../events/provider-event-publication.js";
import { publishAgentPermissionEvents } from "../permissions/permission-publication.js";
import { serverWorkTrace } from "../diagnostics/server-work-trace.js";
import { logger } from "@mcode/shared";

/** The runtime read surface needed to gate provider event status transitions. */
export interface AgentEventPublicationRuntime {
  getCurrentFileEffectTurnId(threadId: string): string | undefined;
  shouldSuppressTurnEnded(threadId: string): boolean;
  shouldSuppressTurnComplete(threadId: string): boolean;
  shouldSuppressTransientTurnError(threadId: string, errorMessage: string): boolean;
}

/** Dependencies required to publish already-normalized provider events. */
export interface AgentEventPublicationDependencies {
  runtime: AgentEventPublicationRuntime;
  threads: Pick<ThreadRepo, "updateStatus">;
  pullRequests: Pick<TurnPullRequestCompletionEffect, "schedule">;
  providers: IProviderRegistry;
  publishPermissionRequest(request: PermissionRequest): void;
  publishPermissionResolved(payload: { requestId: string; decision: "allow" | "allow-session" | "deny" | "cancelled"; optionLabel?: string }): void;
  publishThreadStatus(payload: { threadId: string; status: "completed" | "errored" | "interrupted" }): void;
}

/** Owns renderer publication and post-terminal best-effort completion effects. */
export class AgentEventPublicationService {
  private readonly pendingStatuses = new Set<Promise<unknown>>();
  constructor(private readonly dependencies: AgentEventPublicationDependencies) {}

  /** Register the provider-neutral permission publication bridge. */
  start(): void {
    publishAgentPermissionEvents({
      providerRegistry: this.dependencies.providers,
      publishPermissionRequest: this.dependencies.publishPermissionRequest,
      publishPermissionResolved: this.dependencies.publishPermissionResolved,
    });
  }

  /** Publish accepted progress while observing compatibility status saves independently. */
  publish(event: AgentEvent): void {
    if (serverWorkTrace) {
      serverWorkTrace.measure("publication", event.threadId, event.turnExecutionId, () => this.publishCore(event));
      return;
    }
    this.publishCore(event);
  }

  private publishCore(event: AgentEvent): void {
    if (this.shouldSuppress(event)) return;
    const published = publishParentProviderEvent(event, {
      updateThreadStatus: (threadId, status) => this.observeStatus(threadId, status),
      publishThreadStatus: this.dependencies.publishThreadStatus,
    });
    if (published && event.type === AgentEventType.TurnComplete) this.dependencies.pullRequests.schedule(event.threadId);
  }

  /** Await status commands already submitted before the database owner closes. */
  async drain(): Promise<void> {
    const results = await Promise.allSettled(this.pendingStatuses);
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Agent publication status saves failed");
  }

  private observeStatus(threadId: string, status: "completed" | "errored" | "interrupted"): void {
    const pending = this.dependencies.threads.updateStatus(threadId, status);
    this.pendingStatuses.add(pending);
    void pending.then(() => this.pendingStatuses.delete(pending), (error: unknown) => {
      this.pendingStatuses.delete(pending);
      logger.error("Failed to persist published thread status", { threadId, status, error: String(error) });
    });
  }

  private shouldSuppress(event: AgentEvent): boolean {
    // A stable publication already passed the writer's semantic and terminal barriers.
    if (event.publicationId) return false;
    if (event.type === AgentEventType.Ended) return this.dependencies.runtime.shouldSuppressTurnEnded(event.threadId);
    if (event.type === AgentEventType.TurnComplete) return this.dependencies.runtime.shouldSuppressTurnComplete(event.threadId);
    return event.type === AgentEventType.Error
      && this.dependencies.runtime.shouldSuppressTransientTurnError(event.threadId, event.error ?? "");
  }
}
