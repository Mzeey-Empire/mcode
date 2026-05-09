/**
 * Turns raw provider rejection messages into actionable copy without hiding
 * the original exception text downstream users may grep in logs.
 */

function cursorUpstreamPreamble(original: string): string {
  return [
    `The Cursor CLI reported an upstream error (usually Cursor cloud, auth limits, or a stale session token).`,
    `Mcode surfaced the tool error unchanged below.`,
    ``,
    `Try refreshing Cursor CLI auth, shortening very long chats (fork plus summary), or retrying.`,
    ``,
    `Original:`,
    original,
  ].join("\n");
}

/**
 * Applies provider-specific substitutions for repetitive failure patterns.
 *
 * @param providerId - Thread provider id (`claude`, `cursor`, etc.).
 * @param message - Raw error string from a provider or subprocess.
 */
export function normalizeAgentProviderError(providerId: string, message: string): string {
  const cursorPreambleAlready =
    message.startsWith("The Cursor CLI reported an upstream error");
  if (
    providerId === "cursor" &&
    !cursorPreambleAlready &&
    /\binternal\s+server\s+error\b|\b(?:http\s*)?502\b|\b(?:http\s*)?503\b|status\s*code\s*:\s*5\d\d/i.test(
      message,
    )
  ) {
    return cursorUpstreamPreamble(message);
  }

  const hasEnoent = message.includes("ENOENT");
  const spawnWithEnoent = message.includes("spawn") && message.includes("ENOENT");

  if (hasEnoent || spawnWithEnoent) {
    if (providerId === "claude") {
      return "Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code\n\nOr set a custom path in Settings > Model.";
    }
    if (providerId === "codex") {
      return "Codex CLI not found. Install it with: npm install -g @openai/codex\n\nOr set a custom path in Settings > Model.";
    }
    if (providerId === "copilot") {
      return "Copilot CLI not found. Install it with: npm install -g @github/copilot\n\nOr set a custom path in Settings > Provider > Copilot CLI path.";
    }
    return `${providerId} CLI not found. Check the CLI path in Settings > Model.`;
  }

  return message;
}
