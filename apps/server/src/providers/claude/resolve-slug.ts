import type { ContextWindowMode, ReasoningLevel } from "@mcode/contracts";
import { supports1MContextWindow, supportsUltrathink } from "@mcode/shared";

/**
 * Append the `[1m]` suffix that the Claude Agent SDK uses to enable the
 * 1,000,000-token context window beta. The SDK translates the suffix into the
 * `context-1m-2025-08-07` beta header on the wire.
 *
 * Falls through to the bare model ID when:
 *   - the user did not opt into 1M mode (mode !== "1m"), or
 *   - the model does not support the extended window (e.g. Haiku 4.5).
 */
export function resolveSdkModelSlug(
  modelId: string,
  mode: ContextWindowMode | undefined,
): string {
  if (mode === "1m" && supports1MContextWindow(modelId)) {
    return `${modelId}[1m]`;
  }
  return modelId;
}

/** Prefix the SDK passes through verbatim to flip the model into ultrathink mode. */
const ULTRATHINK_PREFIX = "Ultrathink:\n";

/**
 * Conditionally prepend "Ultrathink:\n" to the user prompt.
 *
 * Ultrathink is a Mcode virtual tier on top of "max" effort. The prefix is the
 * documented signal the model uses to engage the deepest reasoning path; the
 * matching `effort: "max"` is emitted by `buildReasoningOptions`.
 *
 * Returns the original message untouched when:
 *   - the level is not "ultrathink", or
 *   - the model does not support ultrathink (e.g. Haiku 4.5).
 */
export function applyUltrathinkPrefix(
  message: string,
  reasoningLevel: ReasoningLevel | undefined,
  modelId: string,
): string {
  if (reasoningLevel !== "ultrathink") return message;
  if (!supportsUltrathink(modelId)) return message;
  if (message.startsWith(ULTRATHINK_PREFIX)) return message;
  return `${ULTRATHINK_PREFIX}${message}`;
}
