import type { HandoffBudgetInput } from "./types.js";

/** Maximum token allowance spent on replayed history. */
export const HANDOFF_TOKEN_CAP = 16_000;
/** Maximum UTF-8 bytes in the rendered handoff. */
export const HANDOFF_BYTE_CAP = 64_000;
/** Context window assumed when the provider has not reported one. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Context reserved for each image attached to the new message. */
export const IMAGE_ATTACHMENT_RESERVE = 8_192;
/** Context reserved for each file attached to the new message. */
export const FILE_ATTACHMENT_RESERVE = 4_096;
/** Minimum context left for the incoming provider's response. */
export const MIN_RESPONSE_RESERVE = 16_000;

/** Compute space for history after the new message and response reservations. */
export function handoffBudgetBytes(input: HandoffBudgetInput): number {
  let window = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  if (!Number.isFinite(window) || window <= 0) window = DEFAULT_CONTEXT_WINDOW;
  const nativeContextTokens = input.nativeContextTokens ?? 0;
  if (!Number.isFinite(nativeContextTokens)) {
    throw new RangeError("Native context tokens must be finite.");
  }
  let current = Buffer.byteLength(JSON.stringify(input.userText), "utf8");
  for (const attachment of input.attachments) {
    current += attachment.kind === "image" ? IMAGE_ATTACHMENT_RESERVE : FILE_ATTACHMENT_RESERVE;
  }
  const reserve = Math.max(MIN_RESPONSE_RESERVE, Math.ceil(window / 4));
  // Counting one token per UTF-8 byte conservatively budgets across provider tokenizers.
  const remaining = window - nativeContextTokens - current - reserve;
  return Math.max(0, Math.min(HANDOFF_TOKEN_CAP, HANDOFF_BYTE_CAP, remaining));
}
