function issueMessage(issue: unknown): string | null {
  if (typeof issue !== "object" || issue === null || !("message" in issue)) return null;
  return typeof issue.message === "string" && issue.message.length > 0 ? issue.message : null;
}

function validationIssueMessages(message: string): string | null {
  if (!message.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const messages = parsed.map(issueMessage);
  return messages.every((entry) => entry !== null) ? messages.join("; ") : null;
}

/** Returns a readable RPC failure reason, extracting messages from serialized validation issues. */
export function rpcFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return validationIssueMessages(message) ?? message;
}
