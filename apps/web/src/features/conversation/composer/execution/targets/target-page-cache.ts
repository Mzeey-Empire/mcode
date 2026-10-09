import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/** A rejected transport call, such as a closed socket or a timeout, mapped to a visible failure. */
export interface TransportFailure {
  readonly code: "transport";
  readonly message: string;
}

/** Where a paged list stands. `loading` covers page one, a next page, and a revalidation. */
export type TargetPageStatus<E> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly error: E | TransportFailure };

/** What a paged list looks like to a hook consumer. */
export interface TargetPageList<T, E> {
  readonly items: readonly T[];
  /** Server total for the query; null before page one lands or after page one failed. */
  readonly total: number | null;
  readonly status: TargetPageStatus<E>;
  /** Fetches the next page. Does nothing while a request is in flight, after a failure, or when exhausted. */
  loadMore(): void;
  /** Asks again for the page that failed. */
  retry(): void;
}

/** One page as an RPC returns it. */
export type TargetPageResult<W, E> =
  | { readonly ok: true; readonly items: readonly W[]; readonly total: number; readonly nextCursor: string | null }
  | { readonly ok: false; readonly error: E };

/** How one RPC plugs into {@link createTargetPageCache}. */
export interface TargetPageCacheOptions<P, W, T, E> {
  readonly fetchPage: (params: P, cursor: string | undefined) => Promise<TargetPageResult<W, E>>;
  readonly toItem: (wire: W) => T;
  /** One entry per key. Cursors live on their entry, so a cursor never crosses to another query. */
  readonly keyOf: (params: P) => string;
  /** The list a key belongs to regardless of query, so a new query can keep showing that list's rows. */
  readonly listOf: (params: P) => string;
  readonly workspaceOf: (params: P) => string;
  /** Whether an entry outlives its last subscriber. Page-one lists stay so the next open shows rows at once. */
  readonly keepsUnsubscribed: (params: P) => boolean;
  /** Whether a failed later page means its cursor expired, so the list restarts from page one. */
  readonly isStaleCursor?: (error: E | TransportFailure) => boolean;
}

/** A keyed, paged list cache shared by every hook reading the same request. */
export interface TargetPageCache<P, T, E> {
  readonly listOf: (params: P) => string;
  /** Subscribes to the entry for `params`, starting page one if absent. Returns the unsubscribe. */
  subscribe(params: P, onChange: () => void): () => void;
  snapshot(params: P): TargetPageList<T, E> | undefined;
  /** Refetches page one, keeping the current rows on screen until it lands. */
  revalidate(params: P): void;
  /** Drops the workspace's unsubscribed entries and refetches page one of the subscribed ones. */
  invalidateWorkspace(workspaceId: string): void;
}

interface Entry<P, T, E> {
  readonly key: string;
  readonly params: P;
  items: readonly T[];
  total: number | null;
  nextCursor: string | null;
  status: TargetPageStatus<E>;
  /** The cursor of the page that failed, so Retry asks for that page and not page one. */
  failedCursor: string | undefined;
  /** Bumped when page one is refetched; a response from an older generation is dropped. */
  generation: number;
  /** The request on its way, or null. `{ cursor: undefined }` is page one. */
  pending: { readonly cursor: string | undefined } | null;
  /** Set when revalidation was asked while nobody listened, so the next subscriber refetches page one. */
  stale: boolean;
  readonly listeners: Set<() => void>;
  snapshot: TargetPageList<T, E>;
}

const LOADING = { kind: "loading" } as const;
const READY = { kind: "ready" } as const;
const noop = () => {};

/** What a hook reads before its entry exists, and while it subscribes to nothing. */
const PENDING_LIST: TargetPageList<never, never> = { items: [], total: null, status: LOADING, loadMore: noop, retry: noop };

/** Creates one keyed cache. One instance per RPC; the target hooks are the only callers. */
export function createTargetPageCache<P, W, T, E>(options: TargetPageCacheOptions<P, W, T, E>): TargetPageCache<P, T, E> {
  const entries = new Map<string, Entry<P, T, E>>();

  const isCurrent = (entry: Entry<P, T, E>, generation: number) =>
    entries.get(entry.key) === entry && entry.generation === generation;

  const fetchPage = async (entry: Entry<P, T, E>, cursor: string | undefined): Promise<void> => {
    if (entry.pending) return;
    const generation = entry.generation;
    entry.pending = { cursor };
    entry.status = LOADING;
    publish(entry);
    const result = await requestPage(options, entry.params, cursor);
    // Revalidated, invalidated or evicted while in flight: a newer request owns this entry now.
    if (!isCurrent(entry, generation)) return;
    entry.pending = null;
    if (!result.ok && cursor !== undefined && options.isStaleCursor?.(result.error)) {
      restart(entry);
      return;
    }
    applyPage(entry, cursor, result, options.toItem);
    publish(entry);
  };

  const restart = (entry: Entry<P, T, E>) => {
    entry.items = [];
    entry.total = null;
    entry.nextCursor = null;
    void fetchPage(entry, undefined);
  };

  const refetchPageOne = (entry: Entry<P, T, E>, force: boolean) => {
    if (!force && entry.pending !== null && entry.pending.cursor === undefined) return;
    entry.generation += 1;
    entry.pending = null;
    void fetchPage(entry, undefined);
  };

  const createEntry = (params: P, key: string): Entry<P, T, E> => {
    const entry: Entry<P, T, E> = {
      key, params, items: [], total: null, nextCursor: null, status: LOADING, failedCursor: undefined,
      generation: 0, pending: null, stale: false, listeners: new Set(), snapshot: PENDING_LIST,
    };
    entry.snapshot = {
      ...PENDING_LIST,
      loadMore: () => {
        if (entry.status.kind === "ready" && entry.nextCursor !== null) void fetchPage(entry, entry.nextCursor);
      },
      retry: () => {
        if (entry.status.kind === "failed") void fetchPage(entry, entry.failedCursor);
      },
    };
    entries.set(key, entry);
    return entry;
  };

  return {
    listOf: options.listOf,
    subscribe(params, onChange) {
      const key = options.keyOf(params);
      const existing = entries.get(key);
      const entry = existing ?? createEntry(params, key);
      entry.listeners.add(onChange);
      if (!existing) void fetchPage(entry, undefined);
      // A kept entry that failed or went stale while nobody watched must not greet the next viewer with old news.
      else if (entry.stale || entry.status.kind === "failed") refetchPageOne(entry, false);
      entry.stale = false;
      return () => {
        entry.listeners.delete(onChange);
        if (entry.listeners.size > 0 || options.keepsUnsubscribed(entry.params)) return;
        if (entries.get(key) === entry) entries.delete(key);
      };
    },
    snapshot(params) {
      return entries.get(options.keyOf(params))?.snapshot;
    },
    revalidate(params) {
      const entry = entries.get(options.keyOf(params));
      if (!entry) return;
      if (entry.listeners.size === 0) entry.stale = true;
      else refetchPageOne(entry, false);
    },
    invalidateWorkspace(workspaceId) {
      // Deleting the entry being visited is safe while iterating a Map.
      for (const entry of entries.values()) {
        if (options.workspaceOf(entry.params) !== workspaceId) continue;
        // A page-one request already in flight may have read the old state, so invalidation always refetches.
        if (entry.listeners.size > 0) refetchPageOne(entry, true);
        else entries.delete(entry.key);
      }
    },
  };
}

function publish<P, T, E>(entry: Entry<P, T, E>): void {
  entry.snapshot = { ...entry.snapshot, items: entry.items, total: entry.total, status: entry.status };
  for (const listener of entry.listeners) listener();
}

async function requestPage<P, W, T, E>(
  options: TargetPageCacheOptions<P, W, T, E>,
  params: P,
  cursor: string | undefined,
): Promise<TargetPageResult<W, E | TransportFailure>> {
  try {
    return await options.fetchPage(params, cursor);
  } catch (error) {
    return { ok: false, error: { code: "transport", message: error instanceof Error ? error.message : String(error) } };
  }
}

function applyPage<P, W, T, E>(
  entry: Entry<P, T, E>,
  cursor: string | undefined,
  result: TargetPageResult<W, E | TransportFailure>,
  toItem: (wire: W) => T,
): void {
  if (!result.ok) {
    entry.status = { kind: "failed", error: result.error };
    entry.failedCursor = cursor;
    // A failed page one leaves no trustworthy count; a failed later page keeps the rows and count already shown.
    if (cursor === undefined) entry.total = null;
    return;
  }
  const items = result.items.map(toItem);
  entry.items = cursor === undefined ? items : [...entry.items, ...items];
  entry.total = result.total;
  entry.nextCursor = result.nextCursor;
  entry.failedCursor = undefined;
  entry.status = READY;
}

/**
 * Reads one cache entry. `params` must be memoized by the caller, since a new object resubscribes. While a new
 * query's page one loads with nothing to show, the rows last shown for the same list stay on screen, so typing
 * never blanks the list.
 */
export function useTargetPageList<P, T, E>(cache: TargetPageCache<P, T, E>, params: P | null): TargetPageList<T, E> {
  const subscribe = useCallback(
    (onChange: () => void) => (params === null ? noop : cache.subscribe(params, onChange)),
    [cache, params],
  );
  const getSnapshot = useCallback(
    (): TargetPageList<T, E> => (params === null ? PENDING_LIST : cache.snapshot(params) ?? PENDING_LIST),
    [cache, params],
  );
  const list = useSyncExternalStore(subscribe, getSnapshot);
  const listId = params === null ? null : cache.listOf(params);
  return useShownRowsWhileLoading(list, listId);
}

function useShownRowsWhileLoading<T, E>(list: TargetPageList<T, E>, listId: string | null): TargetPageList<T, E> {
  const shown = useRef<{ readonly listId: string; readonly list: TargetPageList<T, E> } | null>(null);
  const waiting = list.items.length === 0 && list.status.kind === "loading";
  useEffect(() => {
    // A hook that stopped subscribing starts over, so reopening a list never shows rows from an earlier query.
    if (listId === null) shown.current = null;
    else if (!waiting) shown.current = { listId, list };
  }, [list, listId, waiting]);
  const previous = shown.current;
  if (!waiting || previous === null || previous.listId !== listId) return list;
  return { ...previous.list, status: LOADING, loadMore: noop, retry: noop };
}
