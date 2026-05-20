import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ReasoningLevel } from "@mcode/contracts";
import {
  logger,
  normalizeReasoningLevelForModel,
  supportsEffortParameter,
  supportsThinkingToggle,
} from "@mcode/shared";

/**
 * Build the SDK reasoning options from a reasoning level, model ID, and
 * optional thinking toggle.
 *
 * - For models with no effort support (Haiku-class), the `effort` field is
 *   omitted entirely. If `thinking` is true and the model exposes the boolean
 *   thinking toggle, we still emit `thinking: { type: "adaptive" }` so Haiku
 *   uses its extended thinking pathway.
 * - "ultrathink" is a Mcode virtual tier — it is mapped to `effort: "max"` at
 *   the SDK boundary because the SDK's EffortLevel union does not include it.
 *   The "Ultrathink:\n" prompt prefix is applied separately by
 *   `applyUltrathinkPrefix` in the message-building path.
 * - All other levels are normalized to the highest tier the model accepts via
 *   the shared tier-ladder helper, with a warning logged on clamp.
 */
export function buildReasoningOptions(
  reasoningLevel: ReasoningLevel | undefined,
  modelId: string,
  thinking?: boolean,
): Pick<Options, "effort" | "thinking"> {
  // Models that ignore the effort parameter (Haiku 4.5).
  if (!supportsEffortParameter(modelId)) {
    if (thinking === true && supportsThinkingToggle(modelId)) {
      return { thinking: { type: "adaptive" } };
    }
    return {};
  }

  if (reasoningLevel === undefined) return {};

  const normalized = normalizeReasoningLevelForModel(modelId, reasoningLevel);
  if (normalized !== reasoningLevel) {
    logger.warn("Reasoning level clamped for model", {
      modelId,
      requested: reasoningLevel,
      effective: normalized,
    });
  }

  // Ultrathink is a Mcode virtual tier; the SDK only accepts up through "max".
  // "none" / "minimal" are OpenAI Codex presets; Claude path normalizes them to "low" above.
  const sdkEffort = normalized === "ultrathink" ? "max" : normalized;

  return {
    // "xhigh" is valid for claude-opus-4-7; the SDK's EffortLevel union does not
    // include "xhigh" yet, so we cast to any to avoid a compile-time rejection.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    effort: sdkEffort as any,
    thinking: { type: "adaptive" },
  };
}
