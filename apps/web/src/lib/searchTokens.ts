/**
 * Shared multi-token search helpers for composer and settings pickers.
 * Queries split on whitespace; every token must match as a substring somewhere
 * in the joined candidate fields (AND semantics).
 */

/** Splits a query into lowercase tokens (whitespace). Empty input yields no tokens. */
export function tokenizeSearch(raw: string): string[] {
  return raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Requires every token to appear as a substring in the joined parts string. */
export function matchesAllTokens(parts: string[], tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = parts.join(" ").toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}
