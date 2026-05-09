/**
 * Heuristics for detecting transient `session/prompt` failures worth a single retry.
 */

const TRANSIENT_RE = new RegExp(
  [
    "\\binternal\\s+server\\s+error\\b",
    "\\b502\\b",
    "\\b503\\b",
    "\\b504\\b",
    "\\b429\\b",
    "ETIMEDOUT",
    "ECONNRESET",
    "ENOTFOUND",
    "fetch failed",
    "socket hang up",
    "\\b503\\s+service",
    "temporar(il)?y\\s+unavailable",
  ].join("|"),
  "i",
);

/**
 * Returns whether a Cursor CLI `prompt` rejection likely indicates a retryable flake.
 *
 * Intentionally conservative: only obvious transport or generic HTTP outages qualify.
 *
 * @param message - Serialized error (`Error.message` or stderr snippet).
 */
export function isLikelyTransientCursorPromptFailure(message: string): boolean {
  return TRANSIENT_RE.test(message);
}
