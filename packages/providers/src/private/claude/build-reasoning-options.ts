import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ReasoningLevel } from "@mcode/contracts/models/settings";
import {
  isKnownClaudeModelId,
  logger,
  normalizeReasoningLevelForModel,
  clampReasoningLevel,
  supportsEffortParameter,
  supportsThinkingToggle,
} from "@mcode/shared";

type ReasoningOptions = Pick<Options, "effort" | "thinking">;

function adaptiveEffort(level: ReasoningLevel): ReasoningOptions {
  return {
    effort: level === "none" || level === "minimal" ? "low" : level,
    // Newer models omit thinking text unless display is summarized; Mcode renders it in Thought rows.
    thinking: { type: "adaptive", display: "summarized" },
  };
}

/** A model that takes no effort (Haiku 4.5) may still use its extended thinking pathway. */
function withoutEffort(modelId: string, thinking: boolean | undefined): ReasoningOptions {
  return thinking === true && supportsThinkingToggle(modelId) ? { thinking: { type: "adaptive", display: "summarized" } } : {};
}

/** Claude Code's report outranks the static tables; a saved level it does not offer moves to the nearest it does. */
function fromDiscoveredEfforts(level: ReasoningLevel | undefined, modelId: string, thinking: boolean | undefined,
  efforts: readonly ReasoningLevel[]): ReasoningOptions {
  if (efforts.length === 0) return withoutEffort(modelId, thinking);
  if (level === undefined) return {};
  return adaptiveEffort(clampReasoningLevel(level, efforts));
}

function fromStaticTables(level: ReasoningLevel | undefined, modelId: string, thinking: boolean | undefined): ReasoningOptions {
  if (!supportsEffortParameter(modelId)) return withoutEffort(modelId, thinking);
  if (level === undefined) return {};
  const normalized = normalizeReasoningLevelForModel(modelId, level);
  if (normalized !== level) {
    logger.warn("Reasoning level clamped for model", { modelId, requested: level, effective: normalized });
  }
  return adaptiveEffort(normalized);
}

/**
 * Build the SDK reasoning options from a reasoning level, model ID, and
 * optional thinking toggle.
 *
 * - `discoveredEfforts`, when Claude Code has reported the model, decides:
 *   empty means no effort, otherwise the level must be one it lists.
 * - Without a report, a Claude id the static tables do not know keeps the
 *   requested level, because those tables match by prefix.
 * - Otherwise the static tables omit effort for Haiku-class models and clamp
 *   the level to the highest tier the model accepts, logging a warning.
 */
export function buildReasoningOptions(
  reasoningLevel: ReasoningLevel | undefined,
  modelId: string,
  thinking?: boolean,
  discoveredEfforts?: readonly ReasoningLevel[],
): ReasoningOptions {
  if (discoveredEfforts) return fromDiscoveredEfforts(reasoningLevel, modelId, thinking, discoveredEfforts);
  if (reasoningLevel !== undefined && modelId.startsWith("claude-") && !isKnownClaudeModelId(modelId)) {
    return adaptiveEffort(reasoningLevel);
  }
  return fromStaticTables(reasoningLevel, modelId, thinking);
}
