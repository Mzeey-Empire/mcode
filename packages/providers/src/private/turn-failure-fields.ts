import type { TurnFailure, TurnFailureKind } from "@mcode/contracts";

/** Longest wait `TurnFailure.retryAfterMs` accepts on the wire. */
const MAX_RETRY_AFTER_MS = 31 * 24 * 3_600_000;
const MAX_CODE_LENGTH = 128;

/** Returns an HTTP status only when the provider value is a real status code. */
export function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/**
 * Classifies a failed HTTP request by status alone: 401 needs a sign-in, timeouts, throttling and
 * server errors clear on retry, and any other status will fail the same way again.
 */
export function kindByHttpStatus(status: number): TurnFailureKind {
  if (status === 401) return "auth";
  if (status === 408 || status === 429 || status >= 500) return "retryable";
  return "fatal";
}

/**
 * Converts a provider reset time in Unix seconds to the wait from `now`.
 * A reset already in the past means the limit has lifted, so the wait is zero.
 */
export function retryAfterMsUntil(resetsAtSeconds: unknown, now: number): number | undefined {
  if (typeof resetsAtSeconds !== "number" || !Number.isFinite(resetsAtSeconds)) return undefined;
  // A wait beyond the wire bound is clamped rather than dropped: the limit is real, only its length is capped.
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(resetsAtSeconds * 1000 - now)));
}

/** Returns a provider code that fits the wire bounds, or undefined. */
export function failureCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  return code.length > 0 && code.length <= MAX_CODE_LENGTH ? code : undefined;
}

/** Builds a failure that omits absent fields, so equal failures stay equal after a JSON round trip. */
export function turnFailure(kind: TurnFailure["kind"], fields: Omit<Partial<TurnFailure>, "kind">): TurnFailure {
  const failure: TurnFailure = { kind };
  if (fields.status !== undefined) failure.status = fields.status;
  if (fields.code !== undefined) failure.code = fields.code;
  if (fields.retryAfterMs !== undefined) failure.retryAfterMs = fields.retryAfterMs;
  if (fields.limitType !== undefined) failure.limitType = fields.limitType;
  if (fields.retries !== undefined) failure.retries = fields.retries;
  return failure;
}

/** Builds `TurnFailure.retries` from the provider's own retry counters. */
export function failureRetries(made: unknown, max?: unknown): TurnFailure["retries"] {
  if (typeof made !== "number" || !Number.isInteger(made) || made < 0) return undefined;
  const validMax = typeof max === "number" && Number.isInteger(max) && max > 0 ? max : undefined;
  return validMax === undefined ? { made } : { made, max: validMax };
}
