/** One Go to file result with the path indices its letters matched. */
export interface RankedFilePath {
  readonly path: string;
  readonly score: number;
  /** Ascending indices into {@link path} of the matched characters. */
  readonly matches: readonly number[];
}

const MATCH_SCORE = 1;
const BOUNDARY_BONUS = 8;
const CONSECUTIVE_BONUS = 5;
const BASENAME_BONUS = 12;
const BASENAME_START_BONUS = 6;
const SEPARATORS = new Set(["/", "\\", "-", "_", ".", " "]);

/** Default number of results Go to file shows. */
export const GO_TO_FILE_RESULT_LIMIT = 50;

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1];
  if (SEPARATORS.has(previous)) return true;
  const current = text[index];
  return current !== current.toLowerCase() && previous === previous.toLowerCase() && previous !== previous.toUpperCase();
}

function isSubsequence(lower: string, query: string, from: number): boolean {
  let position = from;
  for (const character of query) {
    position = lower.indexOf(character, position);
    if (position < 0) return false;
    position += 1;
  }
  return true;
}

function nextBoundaryOccurrence(text: string, lower: string, query: string, index: number, from: number): number {
  let candidate = lower.indexOf(query[index], from);
  while (candidate >= 0) {
    if (isBoundary(text, candidate) && isSubsequence(lower, query.slice(index + 1), candidate + 1)) return candidate;
    candidate = lower.indexOf(query[index], candidate + 1);
  }
  return -1;
}

/**
 * Matches `query` as a subsequence of `text` from `start`. A letter that does
 * not continue the previous match jumps to a later segment start when the rest
 * of the query still fits, so "thread act" lands on "ThreadActions" rather
 * than on scattered letters.
 */
function matchFrom(text: string, lower: string, query: string, start: number): number[] | null {
  const positions: number[] = [];
  let position = start;
  for (let index = 0; index < query.length; index += 1) {
    const first = lower.indexOf(query[index], position);
    if (first < 0) return null;
    const continuesRun = positions.length > 0 && first === position;
    const boundary = continuesRun || isBoundary(text, first) ? -1 : nextBoundaryOccurrence(text, lower, query, index, first + 1);
    const chosen = boundary >= 0 ? boundary : first;
    positions.push(chosen);
    position = chosen + 1;
  }
  return positions;
}

function scorePositions(text: string, positions: readonly number[], basenameStart: number): number {
  let score = 0;
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    score += MATCH_SCORE;
    if (isBoundary(text, position)) score += BOUNDARY_BONUS;
    if (index > 0 && positions[index - 1] === position - 1) score += CONSECUTIVE_BONUS;
  }
  if (positions[0] >= basenameStart) score += BASENAME_BONUS;
  if (positions[0] === basenameStart) score += BASENAME_START_BONUS;
  return score;
}

/** Lowercases the query and drops whitespace, which only separates words. */
export function normalizeFileQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, "");
}

/**
 * Scores one path against a normalized query, or returns null when the query
 * is not a subsequence of the path. Matches inside the basename win over
 * matches spread through folders.
 */
export function scoreFilePath(path: string, normalizedQuery: string): RankedFilePath | null {
  if (normalizedQuery.length === 0) return { path, score: 0, matches: [] };
  const lower = path.toLowerCase();
  if (!isSubsequence(lower, normalizedQuery, 0)) return null;
  const basenameStart = path.lastIndexOf("/") + 1;
  const positions = matchFrom(path, lower, normalizedQuery, basenameStart) ?? matchFrom(path, lower, normalizedQuery, 0);
  if (!positions) return null;
  return { path, score: scorePositions(path, positions, basenameStart), matches: positions };
}

function compareRanked(left: RankedFilePath, right: RankedFilePath): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.path.length !== right.path.length) return left.path.length - right.path.length;
  return left.path.localeCompare(right.path);
}

/**
 * Fuzzy-ranks workspace paths for Go to file: subsequence match, basename and
 * segment-start bonuses, shorter paths first on ties. An empty query keeps the
 * list order.
 */
export function rankFilePaths(
  paths: readonly string[],
  query: string,
  limit: number = GO_TO_FILE_RESULT_LIMIT,
): RankedFilePath[] {
  const normalized = normalizeFileQuery(query);
  if (normalized.length === 0) {
    return paths.slice(0, limit).map((path) => ({ path, score: 0, matches: [] }));
  }
  const ranked: RankedFilePath[] = [];
  for (const path of paths) {
    const result = scoreFilePath(path, normalized);
    if (result) ranked.push(result);
  }
  ranked.sort(compareRanked);
  return ranked.slice(0, limit);
}
