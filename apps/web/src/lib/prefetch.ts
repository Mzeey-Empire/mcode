import { hasCachedSnapshot, cacheSnapshot } from "@/stores/messageCache";
import { getTransport } from "@/transport";
import type { MessageCacheSnapshot } from "@/stores/messageCache";

/** Threads currently being prefetched, to avoid duplicate requests. */
const inflight = new Set<string>();

/** Debounce timer for hover prefetch. */
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounce delay before triggering prefetch on hover (ms). */
const HOVER_DEBOUNCE_MS = 150;

/** Maximum messages to prefetch per thread. */
const PREFETCH_LIMIT = 100;

/**
 * Schedule a background prefetch of messages for a thread.
 * Debounced so rapid mouse movements across the sidebar don't
 * fire dozens of RPCs. No-ops if the thread is already cached
 * or a prefetch is in flight.
 */
export function schedulePrefetch(threadId: string): void {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    prefetchThread(threadId);
  }, HOVER_DEBOUNCE_MS);
}

/** Cancel any pending hover prefetch (e.g. on mouse leave). */
export function cancelPrefetch(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
}

/**
 * Immediately prefetch a thread's messages into the cache.
 * Skips if already cached or in flight. Failures are silent
 * since this is a speculative optimisation.
 */
async function prefetchThread(threadId: string): Promise<void> {
  if (hasCachedSnapshot(threadId) || inflight.has(threadId)) return;
  inflight.add(threadId);
  try {
    const { messages, hasMore } = await getTransport().getMessages(threadId, PREFETCH_LIMIT);
    // Don't overwrite a snapshot that loadMessages populated while we were in flight
    if (hasCachedSnapshot(threadId)) return;

    const counts: Record<string, number> = {};
    for (const msg of messages) {
      if (msg.tool_call_count && msg.tool_call_count > 0) {
        counts[msg.id] = msg.tool_call_count;
      }
    }
    const oldest = messages.length > 0 ? messages[0].sequence : 0;

    const snapshot: MessageCacheSnapshot = {
      messages,
      oldestLoadedSequence: oldest,
      hasMoreMessages: hasMore,
      persistedToolCallCounts: counts,
      persistedFilesChanged: {},
      latestTurnWithChanges: null,
    };
    cacheSnapshot(threadId, snapshot);
  } catch {
    // Prefetch is speculative; swallow errors silently
  } finally {
    inflight.delete(threadId);
  }
}

/** Clear inflight tracking. Used by tests. */
export function __resetPrefetchForTests(): void {
  inflight.clear();
  cancelPrefetch();
}
