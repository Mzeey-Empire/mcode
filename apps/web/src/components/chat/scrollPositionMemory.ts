/**
 * Module-scoped per-thread scrollTop memory used by MessageList to restore
 * scroll position when returning to a thread. Lives outside React so it
 * survives MessageList re-renders without coupling to component state.
 *
 * Entries are not bounded — the message LRU cache governs lifecycle of
 * cached threads, and {@link forgetScrollTop} is called when a thread is
 * deleted or evicted.
 */
const positions = new Map<string, number>();

/** Persist the latest scrollTop for a thread. Ignores non-finite/negative values. */
export function rememberScrollTop(threadId: string, scrollTop: number): void {
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return;
  positions.set(threadId, scrollTop);
}

/** Recall the most recently saved scrollTop for a thread, or undefined. */
export function recallScrollTop(threadId: string): number | undefined {
  return positions.get(threadId);
}

/** Drop the saved scroll position for a thread. */
export function forgetScrollTop(threadId: string): void {
  positions.delete(threadId);
}

/** Drop all saved scroll positions. Used by tests and on full reset. */
export function clearScrollMemory(): void {
  positions.clear();
}
