/**
 * Static per-model maximum context window (tokens) for models whose limits
 * are known up-front. This fills the UI gauge and server-side budgeting
 * before the first turn; the provider-reported live value takes precedence
 * once a turn completes.
 *
 * Source: https://platform.claude.com/docs/en/docs/about-claude/models/overview
 * (verified 2026-04-22).
 */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

/**
 * Precomputed longest-first key list so dated SDK variants
 * (e.g. `claude-haiku-4-5-20251001`) resolve to the closest base ID
 * without being shadowed by a shorter prefix.
 */
const SORTED_KEYS: readonly string[] = Object.keys(MODEL_CONTEXT_WINDOWS)
  .sort((a, b) => b.length - a.length);

/**
 * Returns the static context window (in tokens) for a model ID, including
 * prefix matches against dated SDK variants. Returns undefined when the
 * model is unknown.
 */
export function getModelContextWindow(modelId: string): number | undefined {
  if (!modelId) return undefined;
  const exact = MODEL_CONTEXT_WINDOWS[modelId];
  if (exact !== undefined) return exact;
  const base = SORTED_KEYS.find((k) => modelId.startsWith(`${k}-`));
  return base ? MODEL_CONTEXT_WINDOWS[base] : undefined;
}
