import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
import type { TurnFailure } from "@mcode/contracts/models/turn-failure";
import type { TurnFailureKind } from "@mcode/contracts/compat/agent-model";
import { failureCode, failureRetries, httpStatus, kindByHttpStatus, retryAfterMsUntil, turnFailure } from "../turn-failure-fields.js";

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
  /**
   * The CLI's internal `api_error`, carried on main-thread assistant messages and results but absent
   * from `sdk.d.ts`. It names causes that `assistantError` folds into broader values.
   */
  apiError?: string;
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
  // "Credit balance is too low": waiting does not lift it, so it carries no reset window.
  ["billing_error", "usage_limit"],
  ["server_error", "retryable"],
  ["overloaded", "retryable"],
  ["invalid_request", "fatal"],
  ["model_not_found", "fatal"],
  ["max_output_tokens", "fatal"],
  ["account_on_hold", "fatal"],
  ["verification_required", "fatal"],
  // Expired or missing cloud provider (Bedrock, Vertex) credentials: refreshing them is a sign-in.
  ["cloud_credential_error", "auth"],
];
// "rate_limit" is absent too: the CLI sends it for any 429, including short capacity throttling,
// so only a live subscription rejection makes it a usage limit (see claudeFailureKind).
// "unknown" is deliberately absent so the other signals still decide the kind.
const KIND_BY_ASSISTANT_ERROR: ReadonlyMap<string, TurnFailureKind> = new Map(ASSISTANT_ERROR_KINDS);

// Values whose `assistantError` misleads: the gateway ones arrive as "unknown", the disabled
// credentials as "invalid_request", and the credit ones as "rate_limit" though waiting never lifts them.
// Unlisted values (pdf_too_large, tls_untrusted_ca, ...) leave the other signals to decide.
const KIND_BY_API_ERROR: ReadonlyMap<string, TurnFailureKind> = new Map([
  ["gateway_signin_required", "auth"],
  ["gateway_session_expired", "auth"],
  ["api_key_auth_disabled", "auth"],
  ["org_disabled_credential", "auth"],
  ["provider_credentials", "auth"],
  ["invalid_credential_header", "auth"],
  ["model_requires_usage_credits", "usage_limit"],
  ["long_context_credits_required", "usage_limit"],
]);

// Only a missing gateway sign-in is fixed by signing in. The rest are configuration, or
// (org_verify_failed, remote_settings_required_unavailable) mix network and setup causes the CLI
// does not separate, so retrying them blindly could loop.
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
  const usageLimit = kind === "usage_limit" && !creditShortfall(evidence) && stillRejected(evidence.rateLimit, now)
    ? evidence.rateLimit
    : undefined;
  return turnFailure(kind, {
    status: httpStatus(evidence.apiErrorStatus),
    code: claudeFailureCode(evidence),
    retryAfterMs: retryAfterMsUntil(usageLimit?.resetsAt, now),
    limitType: failureCode(usageLimit?.rateLimitType),
    retries: failureRetries(evidence.apiRetry?.attempt, evidence.apiRetry?.maxRetries),
  });
}

function claudeFailureKind(evidence: ClaudeFailureEvidence, now: number): TurnFailureKind {
  const named = namedKind(evidence);
  if (named) return named;
  if (stillRejected(evidence.rateLimit, now)) return "usage_limit";
  if (evidence.assistantError === "rate_limit") return "retryable";
  const status = httpStatus(evidence.apiErrorStatus);
  // A status that predicts the same failure again leaves the stream code a chance to say otherwise.
  const statusKind = status === undefined ? undefined : kindByHttpStatus(status);
  if (statusKind !== undefined && statusKind !== "fatal") return statusKind;
  if (evidence.streamErrorCode !== undefined && RETRYABLE_STREAM_ERROR_CODES.has(evidence.streamErrorCode)) return "retryable";
  return "fatal";
}

// The most specific name wins: api_error refines assistantError.
function namedKind(evidence: ClaudeFailureEvidence): TurnFailureKind | undefined {
  return lookup(KIND_BY_API_ERROR, evidence.apiError)
    ?? lookup(KIND_BY_ASSISTANT_ERROR, evidence.assistantError)
    ?? lookup(KIND_BY_STARTUP_FAILURE, evidence.startupFailureReason);
}

// Missing credit is lifted by buying it or switching model, never by waiting, so a concurrent
// subscription reset must not become a "Retry at" time.
function creditShortfall(evidence: ClaudeFailureEvidence): boolean {
  return evidence.assistantError === "billing_error"
    || evidence.apiError === "model_requires_usage_credits"
    || evidence.apiError === "long_context_credits_required";
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
  return [evidence.apiError, assistantError, evidence.startupFailureReason, resultSubtype, evidence.terminalReason, evidence.streamErrorCode]
    .map(failureCode)
    .find((code) => code !== undefined);
}

function lookup(table: ReadonlyMap<string, TurnFailureKind>, key: string | undefined): TurnFailureKind | undefined {
  return key === undefined ? undefined : table.get(key);
}
