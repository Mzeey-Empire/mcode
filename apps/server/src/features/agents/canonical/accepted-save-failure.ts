/** Error code that marks a save the writer refused because of the batch's own contents. */
export const ACCEPTED_CONTENT_REJECTED_CODE = "MCODE_ACCEPTED_CONTENT_REJECTED";

/** How an accepted save failure is handled: retried, replaced, or reported while retries continue. */
export type SaveFailureClass = "transient" | "content" | "environment";

/**
 * The writer throws this only where it rejects a batch's compatibility, feature, or message contents.
 * Identity, lease, ordinal, and routing checks never use it, so a replacement cannot hide an ownership bug.
 */
export class AcceptedContentRejected extends Error {
  override readonly name = "AcceptedContentRejected";
  readonly code = ACCEPTED_CONTENT_REJECTED_CODE;

  constructor(readonly reason: string, options?: ErrorOptions) {
    super(`Accepted content rejected: ${reason}`, options);
  }
}

/** Classify a failed save by the codes on its error and `cause` chain. */
export function classifySaveFailure(error: Error): SaveFailureClass {
  if (findCode(error, (code) => /^SQLITE_(BUSY|LOCKED)/.test(code))) return "transient";
  if (findCode(error, (code) => code === ACCEPTED_CONTENT_REJECTED_CODE)) return "content";
  return "environment";
}

/** The short reason a content rejection carries, for the replacement and its marker event. */
export function contentRejectionReason(error: Error): string {
  const rejection = findCode(error, (code) => code === ACCEPTED_CONTENT_REJECTED_CODE);
  const reason = rejection instanceof AcceptedContentRejected ? rejection.reason : rejection?.message;
  return (reason || "content rejected").slice(0, 500);
}

/**
 * Run one step that stores a batch's own contents. Its failures become content rejections, except
 * SQLite failures, which belong to the environment, and any failure `passThrough` keeps.
 */
export function stageAcceptedContent<T>(reason: string, work: () => T, passThrough?: (error: Error) => boolean): T {
  try {
    return work();
  } catch (error) {
    if (!(error instanceof Error) || error instanceof AcceptedContentRejected || passThrough?.(error)
      || findCode(error, (code) => code.startsWith("SQLITE_"))) throw error;
    throw new AcceptedContentRejected(reason, { cause: error });
  }
}

function findCode(error: Error, matches: (code: string) => boolean): Error | undefined {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth += 1) {
    if ("code" in current && typeof current.code === "string" && matches(current.code)) return current;
  }
  return undefined;
}
