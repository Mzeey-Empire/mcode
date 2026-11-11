/** Error code that marks a save the writer refused because of the batch's own contents. */
export const ACCEPTED_CONTENT_REJECTED_CODE = "MCODE_ACCEPTED_CONTENT_REJECTED";

/** How an accepted save failure is handled: retried, replaced, or reported while retries continue. */
export type SaveFailureClass = "transient" | "content" | "environment";

/**
 * The writer throws this only at explicit checks of a batch's own payload shape or size.
 * Identity, lease, ordinal, ownership, and routing checks never use it, so a replacement cannot hide those bugs.
 */
export class AcceptedContentRejected extends Error {
  override readonly name = "AcceptedContentRejected";
  readonly code = ACCEPTED_CONTENT_REJECTED_CODE;

  constructor(readonly reason: string, options?: ErrorOptions) {
    super(`Accepted content rejected: ${reason}`, options);
  }
}

/** Error code a client receives when a thread refuses new turns behind a failed save. */
export const THREAD_SAVE_BLOCKED_CODE = "THREAD_SAVE_BLOCKED";

/**
 * A new turn command refused because an earlier save of the thread cannot complete. Later saves wait behind
 * the failed one in order, so the thread accepts no new turn until the save succeeds or the server restarts.
 */
export class ThreadSaveBlockedError extends Error {
  override readonly name = "ThreadSaveBlockedError";
  readonly code = THREAD_SAVE_BLOCKED_CODE;

  constructor(cause: Error) {
    super(`This thread cannot save new work because an earlier save failed (${cause.message || cause.name}). `
      + "Restart Mcode to recover the thread.", { cause });
  }
}

/**
 * Whether an error is a save-blocked refusal. Checks the code, not the class, because a send's refusal reaches
 * the router rebuilt as a plain `Error` after it crosses the execution worker.
 */
export function isThreadSaveBlocked(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === THREAD_SAVE_BLOCKED_CODE;
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

function findCode(error: Error, matches: (code: string) => boolean): Error | undefined {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth += 1) {
    if ("code" in current && typeof current.code === "string" && matches(current.code)) return current;
  }
  return undefined;
}
