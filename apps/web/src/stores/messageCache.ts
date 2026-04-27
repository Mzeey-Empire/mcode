import type { Message } from "@/transport";
import { LruCache } from "@/lib/lru-cache";

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

/** Maximum number of threads kept in the message cache. */
export const MESSAGE_CACHE_SIZE = 10;

const cache = new LruCache<string, MessageCacheSnapshot>(MESSAGE_CACHE_SIZE);

/** Read the cached snapshot for a thread, refreshing LRU recency on hit. */
export function getCachedSnapshot(threadId: string): MessageCacheSnapshot | undefined {
  return cache.get(threadId);
}

/** Store a snapshot for the given thread, evicting the LRU entry if at capacity. */
export function cacheSnapshot(threadId: string, snapshot: MessageCacheSnapshot): void {
  cache.set(threadId, snapshot);
}

/** Remove a single thread's snapshot. No-op when absent. */
export function evictThread(threadId: string): void {
  cacheDelete(threadId);
}

/** Internal: delete from LRU cache. Temporary scaffold until LruCache.delete() is added. */
function cacheDelete(threadId: string): void {
  // @ts-expect-error - private map access is acceptable here; a public delete() is added in Task 1a
  cache["map"].delete(threadId);
}

/** Drop all cached snapshots. Used in tests and on workspace deletion. */
export function clearMessageCache(): void {
  cache.clear();
}
