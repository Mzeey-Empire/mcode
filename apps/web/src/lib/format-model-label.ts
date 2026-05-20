import { findModelById, type ModelDefinition } from "./model-registry.js";

/**
 * Convert a raw provider model identifier into a friendly label for display.
 *
 * Prefer {@link resolveModelDisplayLabel} when a provider catalog may be available;
 * this function is the last-resort formatter for unknown or retired model IDs.
 *
 * Examples:
 *   formatModelLabel("claude-opus-4-7")               // "Claude Opus 4.7"
 *   formatModelLabel("composer-2.5-fast")           // "Composer 2.5 Fast"
 *   formatModelLabel("cursor-agent")                  // "Cursor"
 *   formatModelLabel("codex")                         // "Codex"
 */
const CLAUDE_PATTERN = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-.+)?$/;
const COMPOSER_PATTERN = /^composer-(\d+(?:\.\d+)?)(?:-(.+))?$/;

/** Title-cases a single hyphenated word (e.g. "fast" -> "Fast"). */
function titleCaseWord(word: string): string {
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Resolves a human-readable model label using catalog, static registry, then heuristics.
 *
 * @param modelId - Raw model id stored on the message or thread.
 * @param options.catalog - Live provider models (e.g. from {@link useProviderModelsStore}).
 */
export function resolveModelDisplayLabel(
  modelId: string,
  options?: { catalog?: readonly ModelDefinition[] },
): string {
  const id = modelId.trim();
  if (!id) return "";

  const catalogHit = options?.catalog?.find((m) => m.id === id);
  if (catalogHit) return catalogHit.label;

  const registryHit = findModelById(id);
  if (registryHit) return registryHit.label;

  return formatModelLabel(id);
}

export function formatModelLabel(modelId: string): string {
  const id = modelId.trim();
  if (!id) return "";

  if (id === "auto") return "Auto";

  const claudeMatch = id.match(CLAUDE_PATTERN);
  if (claudeMatch) {
    const [, tier, major, minor] = claudeMatch;
    const titled = tier.charAt(0).toUpperCase() + tier.slice(1);
    return `Claude ${titled} ${major}.${minor}`;
  }

  const composerMatch = id.match(COMPOSER_PATTERN);
  if (composerMatch) {
    const [, version, tier] = composerMatch;
    if (tier) {
      return `Composer ${version} ${titleCaseWord(tier)}`;
    }
    return `Composer ${version}`;
  }

  if (id === "cursor-agent") return "Cursor";

  // Multi-segment ids: title-case each segment so retired catalog entries stay readable.
  const segments = id.split(/[-_]/).filter(Boolean);
  if (segments.length > 1) {
    return segments.map(titleCaseWord).join(" ");
  }

  const firstSeg = segments[0] ?? id;
  if (firstSeg.length > 0) {
    return titleCaseWord(firstSeg);
  }

  return id;
}
