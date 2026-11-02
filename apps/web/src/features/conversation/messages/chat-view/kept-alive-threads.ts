/** Transcripts kept mounted across thread switches. */
export interface KeptAliveThreads {
  /** Thread ids in render order, which stays fixed while a transcript is mounted. */
  readonly mounted: readonly string[];
  /** The same thread ids, most recently selected first, for eviction. */
  readonly recency: readonly string[];
}

/** No transcripts mounted yet. */
export const NO_KEPT_ALIVE_THREADS: KeptAliveThreads = { mounted: [], recency: [] };

/**
 * Keeps the selected thread's transcript mounted, evicting the least recently selected beyond `limit`.
 *
 * A mounted transcript never changes position: reordering keyed children moves their DOM nodes, a moved
 * scroller loses its scrollTop without a scroll event, and React StrictMode re-runs a moved component's
 * effects, rebuilding the viewport.
 */
export function keepThreadAlive(kept: KeptAliveThreads, threadId: string, limit: number): KeptAliveThreads {
  const recency = [threadId, ...kept.recency.filter((id) => id !== threadId)].slice(0, limit);
  const retained = new Set(recency);
  const mounted = kept.mounted.filter((id) => retained.has(id));
  return { mounted: mounted.includes(threadId) ? mounted : [...mounted, threadId], recency };
}
