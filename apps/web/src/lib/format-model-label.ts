/**
 * Convert a raw provider model identifier into a friendly label for display.
 *
 * Examples:
 *   formatModelLabel("claude-opus-4-7")               // "Claude Opus 4.7"
 *   formatModelLabel("claude-sonnet-4-6")             // "Claude Sonnet 4.6"
 *   formatModelLabel("claude-haiku-4-5-20251001")     // "Claude Haiku 4.5"
 *   formatModelLabel("cursor-agent")                  // "Cursor"
 *   formatModelLabel("codex")                         // "Codex"
 *
 * Unknown formats are returned unchanged so we never display an empty or
 * misleading label.
 */
const CLAUDE_PATTERN = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-.+)?$/;

export function formatModelLabel(modelId: string): string {
  // Anthropic Claude family — claude-{tier}-{major}-{minor}[-{datestamp}]
  const claudeMatch = modelId.match(CLAUDE_PATTERN);
  if (claudeMatch) {
    const [, tier, major, minor] = claudeMatch;
    const titled = tier.charAt(0).toUpperCase() + tier.slice(1);
    return `Claude ${titled} ${major}.${minor}`;
  }

  // First-segment fallback for single-word providers ("codex", "cursor-agent")
  const firstSeg = modelId.split(/[-_]/)[0];
  if (firstSeg.length > 0) {
    return firstSeg.charAt(0).toUpperCase() + firstSeg.slice(1);
  }

  return modelId;
}
