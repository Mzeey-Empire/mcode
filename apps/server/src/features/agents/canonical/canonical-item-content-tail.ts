import type { Database } from "bun:sqlite";
import { getTableColumns, sql } from "drizzle-orm";
import { appendItemContent, type AgentItem, type CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import { canonicalAgentItems } from "../../../runtime/persistence/sqlite/schema.js";

/**
 * Columns every read of a `canonical_agent_items` row selects. The correlated
 * subquery returns the row's ordered content tail in the same statement, so no
 * reader can see a row from one snapshot and its tail from another.
 */
export const canonicalItemRowSelection = {
  ...getTableColumns(canonicalAgentItems),
  contentAppendsJson: sql<string>`(SELECT json_group_array(json_array(tail."offset", tail.text_json, tail.updated_at) ORDER BY tail."offset")
    FROM canonical_agent_item_content_appends tail WHERE tail.item_id = ${canonicalAgentItems.id})`,
};

/** A stored content tail that does not extend its item row; the store never returns truncated text. */
export class CanonicalItemContentTailMismatch extends Error {
  constructor(readonly itemId: string, detail: string) {
    super(`Canonical item ${itemId} content tail does not match its row: ${detail}`);
    this.name = "CanonicalItemContentTailMismatch";
  }
}

/**
 * Applies a row's stored tail, the `contentAppendsJson` column of
 * `canonicalItemRowSelection`, with the reducer's own append rule.
 */
export function foldItemContentTail(item: AgentItem, contentAppendsJson: unknown): AgentItem {
  if (typeof contentAppendsJson !== "string") {
    throw new Error(`Canonical item ${item.id} was read without its content tail`);
  }
  const rows = parseTailRows(item.id, contentAppendsJson);
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last) return item;
  let extent = first.offset;
  for (const row of rows) {
    if (row.offset !== extent) throw new CanonicalItemContentTailMismatch(item.id, `gap at offset ${row.offset}`);
    extent += row.text.length;
  }
  const text = rows.map((row) => row.text).join("");
  const result = appendItemContent(item, { offset: first.offset, text, updatedAt: last.updatedAt });
  if (result.kind !== "appended") {
    throw new CanonicalItemContentTailMismatch(item.id, `${result.kind} at offset ${first.offset}`);
  }
  return result.item;
}

interface TailRow {
  readonly offset: number;
  readonly text: string;
  readonly updatedAt: string;
}

function parseTailRows(itemId: string, json: string): TailRow[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new CanonicalItemContentTailMismatch(itemId, "tail is not a list");
  return parsed.map((entry: unknown) => {
    if (!Array.isArray(entry)) throw new CanonicalItemContentTailMismatch(itemId, "malformed tail row");
    const [offset, textJson, updatedAt] = entry as unknown[];
    const text: unknown = typeof textJson === "string" ? JSON.parse(textJson) : undefined;
    if (typeof offset !== "number" || typeof text !== "string" || typeof updatedAt !== "string") {
      throw new CanonicalItemContentTailMismatch(itemId, "malformed tail row");
    }
    return { offset, text, updatedAt };
  });
}

/** Writer options; correctness never depends on the cache. */
export interface CanonicalItemContentTailOptions {
  /** False makes this store fold every append base from SQLite. */
  readonly cache?: boolean;
}

interface CachedItem {
  readonly item: AgentItem;
  readonly token: number;
}

const MAX_CACHED_ITEMS = 64;

/**
 * Keeps the writer from re-folding the whole stored answer on every append batch.
 * An entry counts only while its token is in a TEMP table written in the same
 * transaction as its tail rows, so a rollback reverts the token and voids it.
 */
class CommittedItemCache {
  private readonly entries = new Map<string, CachedItem>();
  private lastToken = 0;
  private readonly selectToken;
  private readonly upsertToken;
  private readonly selectLastAppend;

  constructor(db: Database) {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS canonical_item_content_cache_tokens (
      item_id TEXT PRIMARY KEY NOT NULL, token INTEGER NOT NULL) WITHOUT ROWID`);
    this.selectToken = db.prepare<{ token: number }, [string]>("SELECT token FROM temp.canonical_item_content_cache_tokens WHERE item_id = ?");
    this.upsertToken = db.prepare("INSERT OR REPLACE INTO temp.canonical_item_content_cache_tokens (item_id, token) VALUES (?, ?)");
    this.selectLastAppend = db.prepare<{ offset: number; textJson: string }, [string]>(`SELECT "offset" AS "offset", text_json AS textJson
      FROM canonical_agent_item_content_appends WHERE item_id = ? ORDER BY "offset" DESC LIMIT 1`);
  }

  get(itemId: string): AgentItem | undefined {
    const cached = this.entries.get(itemId);
    if (cached && this.valid(itemId, cached)) return cached.item;
    this.entries.delete(itemId);
    return undefined;
  }

  remember(item: AgentItem): void {
    this.lastToken += 1;
    this.upsertToken.run(item.id, this.lastToken);
    this.entries.delete(item.id);
    this.entries.set(item.id, { item, token: this.lastToken });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_CACHED_ITEMS) break;
      this.entries.delete(oldest);
    }
  }

  forget(itemId: string): void {
    this.entries.delete(itemId);
  }

  private valid(itemId: string, cached: CachedItem): boolean {
    if (this.selectToken.get(itemId)?.token !== cached.token) return false;
    const last = this.selectLastAppend.get(itemId);
    if (!last) return false;
    const extent = last.offset + (JSON.parse(last.textJson) as string).length;
    const content = cached.item.payload.content;
    return typeof content === "string" && content.length === extent;
  }
}

const committedItemCaches = new WeakMap<Database, CommittedItemCache | null>();

/** A TEMP table created inside a transaction vanishes if it rolls back, so that connection gets no cache. */
function committedItemCache(db: Database): CommittedItemCache | null {
  const existing = committedItemCaches.get(db);
  if (existing !== undefined) return existing;
  const queryOnly = db.prepare<{ query_only: number }, []>("PRAGMA query_only").get()?.query_only === 1;
  const cache = queryOnly || db.inTransaction ? null : new CommittedItemCache(db);
  committedItemCaches.set(db, cache);
  return cache;
}

/** Append-only storage for streamed item content. */
export class CanonicalItemContentTail {
  private readonly cache: CommittedItemCache | null;
  private readonly readsCache: boolean;
  private readonly insertAppend;
  private readonly deleteAppends;

  constructor(db: Database, options: CanonicalItemContentTailOptions = {}) {
    this.insertAppend = db.prepare(`INSERT INTO canonical_agent_item_content_appends (item_id, "offset", text_json, updated_at)
      VALUES (?, ?, ?, ?)`);
    this.deleteAppends = db.prepare("DELETE FROM canonical_agent_item_content_appends WHERE item_id = ?");
    this.cache = committedItemCache(db);
    this.readsCache = options.cache ?? true;
  }

  /** The folded item an append extends: a validated committed cache entry, else `loadFolded`. */
  appendBase(itemId: string, loadFolded: (itemId: string) => AgentItem | null): AgentItem | null {
    const cached = this.readsCache ? this.cache?.get(itemId) : undefined;
    return cached ?? loadFolded(itemId);
  }

  /**
   * Inserts one tail row per append the reducer applied to `base`, then caches
   * the extended item. An append already present in `base` inserts nothing.
   */
  persistAppends(base: AgentItem, events: readonly CanonicalAgentEventEnvelope[]): AgentItem {
    let current = base;
    for (const event of events) {
      if (event.payload.type !== "item.content-appended" || event.routing.itemId !== base.id) continue;
      const result = appendItemContent(current, event.payload);
      if (result.kind === "already-applied") continue;
      if (result.kind === "base-mismatch") throw new CanonicalItemContentTailMismatch(base.id, `append at offset ${event.payload.offset}`);
      this.insertAppend.run(base.id, event.payload.offset, JSON.stringify(event.payload.text), event.payload.updatedAt);
      current = result.item;
    }
    if (current !== base) this.cache?.remember(current);
    return current;
  }

  /** Deletes the tail of an item whose row was just written whole. */
  clear(item: AgentItem): void {
    this.cache?.forget(item.id);
    this.deleteAppends.run(item.id);
  }
}
