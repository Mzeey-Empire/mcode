import type { TurnFailure } from "@mcode/contracts";

/**
 * Error an adapter throws when it already knows how a turn failed.
 * The server reads `failure` when dispatch fails; any other thrown value is classified as fatal.
 */
export class ProviderTurnError extends Error {
  readonly failure: TurnFailure;

  constructor(message: string, failure: TurnFailure, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ProviderTurnError";
    this.failure = failure;
  }
}

/** Failure code for a turn that had to continue a saved session that no longer exists. */
export const SESSION_RESUME_UNAVAILABLE_CODE = "session_resume_unavailable";

/**
 * Thrown when a saved provider session cannot be resumed. A turn sent with
 * `resumeRequired` fails with this instead of quietly starting a fresh session,
 * so the server can decide how to continue.
 */
export class SessionResumeUnavailableError extends ProviderTurnError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, { kind: "fatal", code: SESSION_RESUME_UNAVAILABLE_CODE }, options);
    this.name = "SessionResumeUnavailableError";
  }
}
