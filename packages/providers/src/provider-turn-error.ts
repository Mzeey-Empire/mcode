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
