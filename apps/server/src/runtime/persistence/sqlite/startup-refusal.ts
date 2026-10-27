import { describeRefusal, type StartupRefusal } from "@mcode/contracts/startup-failure";

/** A refusal raised as an error. Its message is `describeRefusal`; `refusal` keeps the data. */
export class DatabaseStartupRefusal extends Error {
  override readonly name = "DatabaseStartupRefusal";

  constructor(readonly refusal: StartupRefusal, options?: ErrorOptions) {
    super(describeRefusal(refusal), options);
  }
}

function leafMessages(error: unknown, depthLeft: number): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const children = error instanceof AggregateError ? error.errors : error.cause === undefined ? [] : [error.cause];
  if (children.length === 0 || depthLeft <= 0) return [error.message];
  return children.flatMap((child) => leafMessages(child, depthLeft - 1));
}

/**
 * The message of the innermost error behind a failure. Drizzle wraps SQLite errors in its own, so
 * the useful text is at the bottom. Walks `cause` links and `AggregateError.errors`.
 *
 * @param maxDepth How many `cause` links to follow before settling for the current message.
 */
export function rootCauseMessage(error: unknown, maxDepth = 8): string {
  return [...new Set(leafMessages(error, maxDepth))].join("; ");
}
