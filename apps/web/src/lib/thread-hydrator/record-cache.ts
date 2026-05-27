import { LruCache } from "@/lib/lru-cache";
import { forgetScrollTop } from "@/components/chat/scrollPositionMemory";
import type { ThreadRecord } from "@/stores/thread-record";

/**
 * Initial default thread cache capacity.
 * Overridden by the `performance.threadCacheSize` user setting at runtime.
 */
export const RECORD_CACHE_SIZE = 15;

/**
 * Module-scoped LRU cache of evicted {@link ThreadRecord}s.
 * The hydrator owns this cache: an active-thread switch evicts records into
 * here so the next visit restores synchronously without an RPC round-trip.
 */
const cache = new LruCache<string, ThreadRecord>(RECORD_CACHE_SIZE);

/** Read the cached record for a thread, refreshing LRU recency on hit. */
export function getCachedRecord(threadId: string): ThreadRecord | undefined {
  return cache.get(threadId);
}

/** Check if a thread has a cached record without promoting LRU recency. */
export function hasCachedRecord(threadId: string): boolean {
  return cache.has(threadId);
}

/** Store a record for the given thread, evicting the LRU entry if at capacity. */
export function cacheRecord(threadId: string, record: ThreadRecord): void {
  const evicted = cache.set(threadId, record);
  if (evicted) {
    forgetScrollTop(evicted);
  }
}

/** Remove a single thread's cached record. No-op when absent. */
export function evictCachedRecord(threadId: string): void {
  cache.delete(threadId);
}

/** Drop all cached records. Used in tests and on workspace deletion. */
export function clearRecordCache(): void {
  cache.clear();
}

/**
 * Change the record-cache capacity at runtime. Clamped to a minimum of 1.
 * When shrinking, evicts the least-recently-used threads until size <= capacity
 * and forgets each evicted thread's scroll position to keep scroll memory
 * consistent with cache contents.
 */
export function resizeRecordCache(capacity: number): void {
  const evicted = cache.resize(capacity);
  for (const threadId of evicted) {
    forgetScrollTop(threadId);
  }
}
