import type { CanonicalAgentEvent, CanonicalAgentEventEnvelope, ThreadStartup } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { subscribeCommittedCanonicalEvents } from "../agents/canonical/committed-canonical-events.js";
import type { ThreadStartupService } from "./thread-startup-service.js";

const MAX_FAILURE_DETAIL_LENGTH = 2_000;

/** Startup transitions the observer drives; a narrow seam so tests can supply a fake service. */
export type StartupAgentPhaseTransitions = Pick<ThreadStartupService, "findByThreadId" | "get" | "complete" | "fail" | "markCancelled">;

/** Subscribes an observer to committed canonical events and returns the unsubscribe function. */
export type CommittedCanonicalEventsSubscription = (
  listener: (events: readonly CanonicalAgentEventEnvelope[]) => void,
) => () => void;

type StartupTransition = (startups: StartupAgentPhaseTransitions, startupId: string) => Promise<ThreadStartup>;

function failure(message: string, detail: string): StartupTransition {
  const trimmed = detail.trim().slice(0, MAX_FAILURE_DETAIL_LENGTH).trim();
  return (startups, startupId) => startups.fail(startupId, {
    code: "AGENT_START_FAILED", message, retryable: true, ...(trimmed ? { detail: trimmed } : {}),
  });
}

// A startup past its agent phase is settled; replayed or later turn facts must not move it.
function inAgentPhase(startup: ThreadStartup | null): startup is ThreadStartup {
  return startup?.state === "running" && startup.phase === "agent";
}

const complete: StartupTransition = (startups, startupId) => startups.complete(startupId);

/**
 * Turn facts that settle the agent phase. The first provider frame honours cancellation intent; a turn that ends before any frame
 * reports how it ended. A completed turn also completes the startup: the provider-started event leads every batch
 * that carries a frame, so this only matters for a turn finished from saved state, which must not leave the
 * spinner running.
 */
function transitionFor(event: CanonicalAgentEvent): StartupTransition | undefined {
  switch (event.type) {
    case "turn.provider-started": return (startups, startupId) => startups.get(startupId)?.cancellation === "requested"
      ? startups.markCancelled(startupId)
      : startups.complete(startupId);
    case "turn.completed": return complete;
    case "turn.cancelled": return (startups, startupId) => startups.markCancelled(startupId);
    case "turn.errored": return failure("Agent failed to start", event.error);
    case "turn.interrupted": return failure("Agent was interrupted before it answered", event.reason);
    default: return undefined;
  }
}

/**
 * Holds a thread startup in its agent phase until the provider answers the first turn, then completes, fails, or
 * cancels it from the saved turn facts. Admission alone no longer completes a startup, because a provider can
 * accept a turn and still fail before it sends anything.
 */
export class StartupAgentPhaseObserver {
  private unsubscribe: (() => void) | undefined;
  // Transitions for one startup run in arrival order so a later fact never races an earlier one.
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly startups: StartupAgentPhaseTransitions,
    private readonly subscribe: CommittedCanonicalEventsSubscription = subscribeCommittedCanonicalEvents,
  ) {}

  /** Begin observing committed canonical events. Calling it twice keeps one subscription. */
  start(): void {
    this.unsubscribe ??= this.subscribe((events) => this.observe(events));
  }

  /** Stop observing and wait for transitions already in flight. */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await Promise.all(this.pending.values());
  }

  private observe(events: readonly CanonicalAgentEventEnvelope[]): void {
    for (const event of events) {
      const transition = transitionFor(event.payload);
      if (!transition) continue;
      const startup = this.startups.findByThreadId(event.routing.threadId);
      if (inAgentPhase(startup)) this.enqueue(startup.startupId, transition);
    }
  }

  private enqueue(startupId: string, transition: StartupTransition): void {
    const previous = this.pending.get(startupId) ?? Promise.resolve();
    const next = previous
      .then(() => this.applyIfStillInAgentPhase(startupId, transition))
      .catch((error: unknown) => { logger.error("Thread startup agent phase transition failed", { startupId, error }); });
    this.pending.set(startupId, next);
    void next.finally(() => {
      if (this.pending.get(startupId) === next) this.pending.delete(startupId);
    });
  }

  private async applyIfStillInAgentPhase(startupId: string, transition: StartupTransition): Promise<void> {
    // An earlier queued fact may already have settled this startup.
    if (inAgentPhase(this.startups.get(startupId))) await transition(this.startups, startupId);
  }
}
