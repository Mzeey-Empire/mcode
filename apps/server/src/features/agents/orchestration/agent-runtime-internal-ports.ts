import type { AgentEventPublicationRuntime } from "./agent-event-publication-service.js";

/** Provides renderer-event enrichment without exposing the AgentService facade. */
export class AgentEventPublicationRuntimePort implements AgentEventPublicationRuntime {
  private target: AgentEventPublicationRuntime | undefined;

  /** Bind the single runtime owner during composition. */
  bind(target: AgentEventPublicationRuntime): void {
    this.target = target;
  }

  /** Return the active file-effect generation for a thread. */
  getCurrentFileEffectTurnId(threadId: string): string | undefined {
    return this.requireTarget().getCurrentFileEffectTurnId(threadId);
  }

  /** Return whether an ended event remains private during retry or stopping. */
  shouldSuppressTurnEnded(threadId: string): boolean {
    return this.requireTarget().shouldSuppressTurnEnded(threadId);
  }

  /** Return whether a terminal completion belongs to a suppressed retry. */
  shouldSuppressTurnComplete(threadId: string): boolean {
    return this.requireTarget().shouldSuppressTurnComplete(threadId);
  }

  /** Return whether a transient provider error remains private during retry. */
  shouldSuppressTransientTurnError(threadId: string, errorMessage: string): boolean {
    return this.requireTarget().shouldSuppressTransientTurnError(threadId, errorMessage);
  }

  private requireTarget(): AgentEventPublicationRuntime {
    if (!this.target) throw new Error("Agent event publication runtime is not configured");
    return this.target;
  }
}
