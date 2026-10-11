import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
import type { TurnFailure, TurnFailureKind } from "@mcode/contracts";
import { failureCode, failureRetries, httpStatus, retryAfterMsUntil, turnFailure } from "../turn-failure-fields.js";

/** The last `rate_limit_event.rate_limit_info` the turn saw. */
export interface ClaudeRateLimitEvidence {
  status?: string;
  /** Unix seconds. */
  resetsAt?: number;
  rateLimitType?: string;
}

/** The last `system/api_retry` message the turn saw. */
export interface ClaudeApiRetryEvidence {
  attempt?: number;
  maxRetries?: number;
}

/** Native Claude signals gathered while a turn ran, read when it fails. */
export interface ClaudeFailureEvidence {
  /** `SDKAssistantMessage.error` from the turn's last assistant message that carried one. */
  assistantError?: string;
  /** `SDKResultMessage.subtype`. */
  resultSubtype?: string;
  /** `SDKResultMessage.terminal_reason`. */
  terminalReason?: string;
  /** `SDKResultError.startup_failure_reason`. */
  startupFailureReason?: string;
  /** `SDKResultSuccess.api_error_status`, set when an `is_error` result ended on an API error. */
  apiErrorStatus?: number | null;
  rateLimit?: ClaudeRateLimitEvidence;
  apiRetry?: ClaudeApiRetryEvidence;
  /** Node error code of an exception thrown by the SDK stream, e.g. "ECONNRESET". */
  streamErrorCode?: string;
}

const ASSISTANT_ERROR_KINDS: ReadonlyArray<readonly [SDKAssistantMessageError, TurnFailureKind]> = [
  ["authentication_failed", "auth"],
  ["oauth_org_not_allowed", "auth"],
  ["rate_limit", "usage_limit"],
  ["billing_error", "usage_limit"],
  ["server_error", "retryable"],
  ["overloaded", "retryable"],
  ["invalid_request", "fatal"],
  ["model_not_found", "fatal"],
  ["max_output_tokens", "fatal"],
  ["account_on_hold", "fatal"],
  ["verification_required", "fatal"],
  ["cloud_credential_error", "fatal"],
];
// "unknown" is deliberately absent so the other signals still decide the kind.
const KIND_BY_ASSISTANT_ERROR: ReadonlyMap<string, TurnFailureKind> = new Map(ASSISTANT_ERROR_KINDS);

// Only a missing gateway sign-in is fixed by signing in; the other startup failures are configuration.
const KIND_BY_STARTUP_FAILURE: ReadonlyMap<string, TurnFailureKind> = new Map([["gateway_signin_required", "auth"]]);

/** Socket failures that end the SDK stream without saying anything about the request itself. */
const RETRYABLE_STREAM_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETRESET",
]);

/**
 * Classifies a failed Claude turn from its native evidence.
 * Pure: `now` is the emission time used to turn the rate-limit reset into a relative wait.
 */
export function classifyClaudeFailure(evidence: ClaudeFailureEvidence, now: number): TurnFailure {
  const kind = claudeFailureKind(evidence, now);
  const usageLimit = kind === "usage_limit" ? evidence.rateLimit : undefined;
  return turnFailure(kind, {
    status: httpStatus(evidence.apiErrorStatus),
    code: claudeFailureCode(evidence),
    retryAfterMs: retryAfterMsUntil(usageLimit?.resetsAt, now),
    limitType: failureCode(usageLimit?.rateLimitType),
    retries: failureRetries(evidence.apiRetry?.attempt, evidence.apiRetry?.maxRetries),
  });
}

function claudeFailureKind(evidence: ClaudeFailureEvidence, now: number): TurnFailureKind {
  const named = lookup(KIND_BY_ASSISTANT_ERROR, evidence.assistantError) ?? lookup(KIND_BY_STARTUP_FAILURE, evidence.startupFailureReason);
  if (named) return named;
  if (stillRejected(evidence.rateLimit, now)) return "usage_limit";
  if ((httpStatus(evidence.apiErrorStatus) ?? 0) >= 500) return "retryable";
  if (evidence.streamErrorCode !== undefined && RETRYABLE_STREAM_ERROR_CODES.has(evidence.streamErrorCode)) return "retryable";
  return "fatal";
}

// The last rate-limit report outlives turns, so a rejection whose reset has passed no longer explains a failure.
function stillRejected(rateLimit: ClaudeRateLimitEvidence | undefined, now: number): boolean {
  if (rateLimit?.status !== "rejected") return false;
  return rateLimit.resetsAt === undefined || rateLimit.resetsAt * 1000 > now;
}

function claudeFailureCode(evidence: ClaudeFailureEvidence): string | undefined {
  const assistantError = evidence.assistantError === "unknown" ? undefined : evidence.assistantError;
  // "success" with is_error means the turn ended on an API error; the subtype names nothing.
  const resultSubtype = evidence.resultSubtype === "success" ? undefined : evidence.resultSubtype;
  return [assistantError, evidence.startupFailureReason, resultSubtype, evidence.terminalReason, evidence.streamErrorCode]
    .map(failureCode)
    .find((code) => code !== undefined);
}

function lookup(table: ReadonlyMap<string, TurnFailureKind>, key: string | undefined): TurnFailureKind | undefined {
  return key === undefined ? undefined : table.get(key);
}
