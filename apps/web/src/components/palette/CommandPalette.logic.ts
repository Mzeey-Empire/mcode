/**
 * Pure palette logic: normalization, ranking, filtering, and item builders.
 * No React or store imports -- fully testable in isolation.
 */

/** A palette item with searchable fields. */
export interface PaletteItem {
  /** Unique value used to identify the item when selected. */
  value: string;
  /** Primary label shown in the palette list. */
  title: string;
  /** Optional secondary label (e.g. file path). */
  description?: string;
  /** Ordered list of strings to match against the query. Earlier entries rank higher. */
  searchTerms: string[];
}

/** A group of palette items with a section heading. */
export interface PaletteGroup {
  /** Heading displayed above the group in the palette. */
  heading: string;
  /** Items belonging to this group. */
  items: PaletteItem[];
}

/**
 * Normalize a search query: trim leading/trailing whitespace, lowercase,
 * and collapse internal runs of whitespace to a single space.
 */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Score how well `field` matches `term`.
 * Returns 3 for exact match, 2 for prefix match, 1 for substring, -Infinity for no match.
 * Comparison is case-insensitive.
 */
export function rankSearchFieldMatch(field: string, term: string): number {
  const f = field.toLowerCase();
  const t = term.toLowerCase();
  if (f === t) return 3;
  if (f.startsWith(t)) return 2;
  if (f.includes(t)) return 1;
  return -Infinity;
}

/**
 * Score a PaletteItem against a single query token.
 * Earlier searchTerms earn an index bonus (1000 - index * 100) so that
 * matches on the primary term outrank matches on secondary terms.
 */
function scoreItemForToken(item: PaletteItem, token: string): number {
  let best = -Infinity;
  for (let i = 0; i < item.searchTerms.length; i++) {
    const fieldRank = rankSearchFieldMatch(item.searchTerms[i], token);
    if (fieldRank > -Infinity) {
      const score = 1000 - i * 100 + fieldRank;
      if (score > best) best = score;
    }
  }
  return best;
}

/**
 * Filter and rank palette groups against a query string.
 * When the query is empty, all groups are returned unchanged.
 * Items that do not match any token are dropped; groups that become empty are dropped.
 * Surviving items within each group are sorted by score descending.
 */
export function filterCommandPaletteGroups(groups: PaletteGroup[], query: string): PaletteGroup[] {
  const q = normalizeQuery(query);
  if (!q) return groups;
  const tokens = q.split(" ");

  return groups
    .map((group) => {
      const scored = group.items
        .map((item) => {
          // An item must match all tokens; any single -Infinity token eliminates it.
          const score = tokens.reduce<number>((acc, token) => {
            const s = scoreItemForToken(item, token);
            return s === -Infinity ? -Infinity : acc + s;
          }, 0);
          return { item, score };
        })
        .filter(({ score }) => score > -Infinity)
        .sort((a, b) => b.score - a.score)
        .map(({ item }) => item);

      return { ...group, items: scored };
    })
    .filter((g) => g.items.length > 0);
}

/** Minimal workspace shape required by palette logic. Avoids a direct contracts import. */
export interface WorkspaceLike {
  /** Numeric workspace identifier. */
  id: number;
  /** Human-readable workspace name. */
  name: string;
  /** Absolute filesystem path. */
  path: string;
  /** Whether the workspace is pinned to the top of the list. */
  pinned: boolean;
  /** Timestamp of last open, or null if never. */
  lastOpenedAt: number | null;
  /** Whether the workspace root is a git repository. */
  isGitRepo: boolean;
  /** Creation timestamp (unix ms). */
  createdAt: number;
  /** Last-updated timestamp (unix ms). */
  updatedAt: number;
}

/** Minimal thread shape required by palette logic. */
export interface ThreadLike {
  /** Thread UUID. */
  id: string;
  /** Optional user-visible thread title. */
  title?: string | null;
  /** ID of the workspace this thread belongs to. */
  workspaceId: number;
  /** Creation timestamp (unix ms). */
  createdAt: number;
  /** Last-updated timestamp (unix ms). */
  updatedAt: number;
}

/**
 * Build palette items for a list of workspaces.
 * Each item matches on workspace name and path.
 */
export function buildProjectActionItems(workspaces: WorkspaceLike[]): PaletteItem[] {
  return workspaces.map((ws) => ({
    value: `workspace:${ws.id}`,
    title: ws.name,
    description: ws.path,
    searchTerms: [ws.name, ws.path],
  }));
}

/**
 * Build palette items for a list of threads.
 * Untitled threads fall back to the label "Untitled thread".
 */
export function buildThreadActionItems(threads: ThreadLike[]): PaletteItem[] {
  return threads.map((t) => ({
    value: `thread:${t.id}`,
    title: t.title ?? "Untitled thread",
    description: undefined,
    searchTerms: [t.title ?? "untitled thread"],
  }));
}
