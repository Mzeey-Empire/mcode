import type { Message } from "@/transport";
import { LruCache } from "@/lib/lru-cache";
import { forgetScrollTop } from "@/components/chat/scrollPositionMemory";

/**
 * Snapshot of the message-loading state for one thread, stored in the
 * module-scoped LRU cache so subsequent visits skip the getMessages RPC.
 *
 * The shape mirrors the fields written to the Zustand store on a fresh load;
 * the cache-hit path restores each field so UI behaves identically to a fresh
 * RPC-driven load.
 */
export interface MessageCacheSnapshot {
  messages: Message[];
  oldestLoadedSequence: number;
  hasMoreMessages: boolean;
  persistedToolCallCounts: Record<string, number>;
  persistedFilesChanged: Record<string, string[]>;
  latestTurnWithChanges: string | null;
}

/** Initial default number of threads kept in the message cache. Overridden by user settings at runtime via resizeMessageCache. */
export const MESSAGE_CACHE_SIZE = 15;

const cache = new LruCache<string, MessageCacheSnapshot>(MESSAGE_CACHE_SIZE);

/** Read the cached snapshot for a thread, refreshing LRU recency on hit. */
export function getCachedSnapshot(threadId: string): MessageCacheSnapshot | undefined {
  return cache.get(threadId);
}

/** Check if a thread has a cached snapshot without promoting LRU recency. */
export function hasCachedSnapshot(threadId: string): boolean {
  return cache.has(threadId);
}

/** Store a snapshot for the given thread, evicting the LRU entry if at capacity. */
export function cacheSnapshot(threadId: string, snapshot: MessageCacheSnapshot): void {
  const evicted = cache.set(threadId, snapshot);
  if (evicted) {
    forgetScrollTop(evicted);
  }
}

/** Remove a single thread's snapshot. No-op when absent. */
export function evictThread(threadId: string): void {
  cache.delete(threadId);
}

/** Drop all cached snapshots. Used in tests and on workspace deletion. */
export function clearMessageCache(): void {
  cache.clear();
}

/**
 * Change the message-cache capacity at runtime. Clamped to a minimum of 1.
 * When shrinking, evicts the least-recently-used threads until size <= capacity
 * and forgets each evicted thread's scroll position to keep scroll memory
 * consistent with cache contents.
 * Wired to the `performance.threadCacheSize` user setting from the App root.
 */
export function resizeMessageCache(capacity: number): void {
  const evicted = cache.resize(capacity);
  for (const threadId of evicted) {
    forgetScrollTop(threadId);
  }
}
