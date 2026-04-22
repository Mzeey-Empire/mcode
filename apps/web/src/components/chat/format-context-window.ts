/**
 * Formats a context window token count for compact badge display.
 *
 * - >= 1,000,000 tokens: "1M", "1.5M", "2M"
 * - < 1,000,000 tokens: "200K", "128K"
 * - undefined input: returns undefined (no badge)
 */
export function formatContextWindow(tokens: number | undefined): string | undefined {
  if (tokens === undefined) return undefined;
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions}M`;
  }
  return `${Math.round(tokens / 1_000)}K`;
}
