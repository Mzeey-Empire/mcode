import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";
import { logger } from "@mcode/shared";

/** Receives one batch of canonical events after SQLite saved them. */
export type CommittedCanonicalEventsListener = (events: readonly CanonicalAgentEventEnvelope[]) => void;

const listeners = new Set<CommittedCanonicalEventsListener>();

/**
 * Observe canonical events once they are durable. Server features that react to turn facts use this instead of the
 * renderer push channel, so they see the same batches every client sees. Returns the unsubscribe function.
 */
export function subscribeCommittedCanonicalEvents(listener: CommittedCanonicalEventsListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Deliver one saved batch to every observer. A failing observer is logged so it cannot undo or block the save. */
export function notifyCommittedCanonicalEvents(events: readonly CanonicalAgentEventEnvelope[]): void {
  if (events.length === 0) return;
  for (const listener of listeners) {
    try {
      listener(events);
    } catch (error) {
      logger.error("Committed canonical event observer failed", { error });
    }
  }
}
