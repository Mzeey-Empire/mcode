import { findModelById } from "./model-registry.js";

/**
 * Convert a raw provider model identifier into a friendly label for display.
 *
 * Examples:
 *   formatModelLabel("claude-opus-4-7")               // "Claude Opus 4.7"
 *   formatModelLabel("claude-sonnet-4-6")             // "Claude Sonnet 4.6"
 *   formatModelLabel("gpt-5.2-codex")                 // "GPT-5.2 Codex"
 *   formatModelLabel("cursor-agent")                  // "Cursor"
 *
 * Unknown formats are returned unchanged so we never display an empty or
 * misleading label.
 */
const CLAUDE_PATTERN = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-.+)?$/;

export function formatModelLabel(modelId: string): string {
  const registryLabel = findModelById(modelId)?.label;
  if (registryLabel) return registryLabel;

  // Anthropic Claude family — claude-{tier}-{major}-{minor}[-{datestamp}]
  const claudeMatch = modelId.match(CLAUDE_PATTERN);
  if (claudeMatch) {
    const [, tier, major, minor] = claudeMatch;
    const titled = tier.charAt(0).toUpperCase() + tier.slice(1);
    return `Claude ${titled} ${major}.${minor}`;
  }

  // OpenAI-style ids (gpt-5.2-codex) — avoid truncating to "Gpt" via first-segment logic
  if (/^gpt[-_]/i.test(modelId)) {
    return `GPT-${modelId.replace(/^gpt[-_]/i, "")}`;
  }

  // First-segment fallback for single-word providers ("codex", "cursor-agent")
  const firstSeg = modelId.split(/[-_]/)[0];
  if (firstSeg.length > 0) {
    return firstSeg.charAt(0).toUpperCase() + firstSeg.slice(1);
  }

  return modelId;
}
