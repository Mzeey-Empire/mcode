/** Most matches one search reports; past this the count reads "10000+" and the rest are not highlighted. */
export const MAX_FIND_MATCHES = 10_000;

export interface FindOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

/** One match: a half-open `[start, end)` range of UTF-16 offsets inside a single line. */
export interface FindMatch {
  /** Zero-based line index. */
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

export type FindResult =
  | { readonly status: "idle" }
  | { readonly status: "invalid" }
  | {
      readonly status: "ready";
      /** In document order. */
      readonly matches: readonly FindMatch[];
      /** True when the search stopped at {@link MAX_FIND_MATCHES}. */
      readonly capped: boolean;
    };

export const IDLE_FIND_RESULT: FindResult = { status: "idle" };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(query: string, options: FindOptions): RegExp | null {
  const body = options.regex ? query : escapeRegExp(query);
  const source = options.wholeWord ? `\\b(?:${body})\\b` : body;
  try {
    return new RegExp(source, options.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

/**
 * Finds every match of `query` line by line. Matches never span lines, so a
 * pattern containing `\n` finds nothing. An empty query is idle, a pattern that
 * does not compile is invalid, and a pattern that can match nothing (`a*` on
 * "bbb") skips the empty hits instead of reporting them.
 */
export function findInLines(lines: readonly string[], query: string, options: FindOptions): FindResult {
  if (query.length === 0) return IDLE_FIND_RESULT;
  const pattern = buildPattern(query, options);
  if (!pattern) return { status: "invalid" };

  const matches: FindMatch[] = [];
  for (let line = 0; line < lines.length; line += 1) {
    pattern.lastIndex = 0;
    for (let hit = pattern.exec(lines[line]!); hit; hit = pattern.exec(lines[line]!)) {
      if (hit[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      matches.push({ line, start: hit.index, end: hit.index + hit[0].length });
      if (matches.length >= MAX_FIND_MATCHES) return { status: "ready", matches, capped: true };
    }
  }
  return { status: "ready", matches, capped: false };
}

/** Wraps a step index into `[0, count)`; a count of 0 yields 0. */
export function stepMatchIndex(current: number, direction: 1 | -1, count: number): number {
  return count === 0 ? 0 : (current + direction + count) % count;
}

export interface LinePiece {
  readonly content: string;
  readonly color?: string;
  /** Set when the piece lies inside a match. */
  readonly match?: "match" | "current";
}

export interface LineHighlight {
  readonly start: number;
  readonly end: number;
  readonly current: boolean;
}

/**
 * Cuts a line's pieces (syntax tokens, or the plain text as one piece) at the
 * edges of its highlights, so a match that crosses tokens keeps each token's color.
 * `highlights` must be sorted and non-overlapping, as `findInLines` produces them.
 */
export function splitPieces(pieces: readonly LinePiece[], highlights: readonly LineHighlight[]): LinePiece[] {
  const out: LinePiece[] = [];
  let offset = 0;
  for (const piece of pieces) {
    out.push(...cutPiece(piece, offset, highlights));
    offset += piece.content.length;
  }
  return out;
}

function cutPiece(piece: LinePiece, offset: number, highlights: readonly LineHighlight[]): LinePiece[] {
  const end = offset + piece.content.length;
  const slice = (from: number, to: number, match?: LinePiece["match"]): LinePiece => ({
    ...piece,
    content: piece.content.slice(from - offset, to - offset),
    ...(match && { match }),
  });
  const cut: LinePiece[] = [];
  let cursor = offset;
  for (const highlight of highlights) {
    if (highlight.end <= cursor) continue;
    if (highlight.start >= end) break;
    const from = Math.max(highlight.start, cursor);
    const to = Math.min(highlight.end, end);
    if (from > cursor) cut.push(slice(cursor, from));
    cut.push(slice(from, to, highlight.current ? "current" : "match"));
    cursor = to;
  }
  if (cursor < end) cut.push(slice(cursor, end));
  return cut;
}
