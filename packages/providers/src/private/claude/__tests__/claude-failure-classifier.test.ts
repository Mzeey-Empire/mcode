import { describe, expect, it } from "vitest";
import { classifyClaudeFailure } from "../claude-failure-classifier.js";

const NOW = 1_700_000_000_000;

describe("classifyClaudeFailure", () => {
  it.each([
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
  ])("classifies assistant error %s as %s", (assistantError, kind) => {
    expect(classifyClaudeFailure({ assistantError }, NOW)).toEqual({ kind, code: assistantError });
  });

  it("lets other signals decide when the assistant error is unknown", () => {
    expect(classifyClaudeFailure({ assistantError: "unknown", apiErrorStatus: 503 }, NOW)).toEqual({ kind: "retryable", status: 503 });
    expect(classifyClaudeFailure({ assistantError: "unknown" }, NOW)).toEqual({ kind: "fatal" });
  });

  it("classifies a missing gateway sign-in as auth", () => {
    expect(classifyClaudeFailure({ resultSubtype: "error_during_execution", startupFailureReason: "gateway_signin_required" }, NOW))
      .toEqual({ kind: "auth", code: "gateway_signin_required" });
  });

  it("gives a rejected rate limit its reset window and limit type", () => {
    const rateLimit = { status: "rejected", resetsAt: NOW / 1000 + 90, rateLimitType: "five_hour" };
    expect(classifyClaudeFailure({ rateLimit }, NOW)).toEqual({ kind: "usage_limit", retryAfterMs: 90_000, limitType: "five_hour" });
  });

  it("omits the wait when no reset is known", () => {
    expect(classifyClaudeFailure({ rateLimit: { status: "rejected" } }, NOW)).toEqual({ kind: "usage_limit" });
  });

  it("ignores a rejection whose reset has already passed", () => {
    expect(classifyClaudeFailure({ rateLimit: { status: "rejected", resetsAt: NOW / 1000 } }, NOW)).toEqual({ kind: "fatal" });
    expect(classifyClaudeFailure({ rateLimit: { status: "rejected", resetsAt: NOW / 1000 - 1 }, apiErrorStatus: 502 }, NOW))
      .toEqual({ kind: "retryable", status: 502 });
  });

  it("reports a zero wait when a rate_limit error arrives after the reset", () => {
    expect(classifyClaudeFailure({ assistantError: "rate_limit", rateLimit: { status: "rejected", resetsAt: NOW / 1000 - 1 } }, NOW))
      .toEqual({ kind: "usage_limit", code: "rate_limit", retryAfterMs: 0 });
  });

  it("caps a reset beyond the wire bound at 31 days", () => {
    const rateLimit = { status: "rejected", resetsAt: NOW / 1000 + 40 * 86_400 };
    expect(classifyClaudeFailure({ rateLimit }, NOW)).toEqual({ kind: "usage_limit", retryAfterMs: 31 * 86_400_000 });
  });

  it("keeps the reset window off failures that are not usage limits", () => {
    const rateLimit = { status: "allowed_warning", resetsAt: NOW / 1000 + 90, rateLimitType: "five_hour" };
    expect(classifyClaudeFailure({ assistantError: "authentication_failed", rateLimit }, NOW)).toEqual({ kind: "auth", code: "authentication_failed" });
    expect(classifyClaudeFailure({ rateLimit }, NOW)).toEqual({ kind: "fatal" });
  });

  it("treats 500 and above as retryable and ignores values that are not HTTP statuses", () => {
    expect(classifyClaudeFailure({ apiErrorStatus: 499 }, NOW)).toEqual({ kind: "fatal", status: 499 });
    expect(classifyClaudeFailure({ apiErrorStatus: 500 }, NOW)).toEqual({ kind: "retryable", status: 500 });
    expect(classifyClaudeFailure({ apiErrorStatus: 599 }, NOW)).toEqual({ kind: "retryable", status: 599 });
    expect(classifyClaudeFailure({ apiErrorStatus: 600 }, NOW)).toEqual({ kind: "fatal" });
    expect(classifyClaudeFailure({ apiErrorStatus: null }, NOW)).toEqual({ kind: "fatal" });
  });

  it("treats a socket reset as retryable and other stream codes as fatal", () => {
    expect(classifyClaudeFailure({ streamErrorCode: "ECONNRESET" }, NOW)).toEqual({ kind: "retryable", code: "ECONNRESET" });
    expect(classifyClaudeFailure({ streamErrorCode: "ENOENT" }, NOW)).toEqual({ kind: "fatal", code: "ENOENT" });
  });

  it("names a budget or turn cap by its result subtype and an over-long prompt by its terminal reason", () => {
    expect(classifyClaudeFailure({ resultSubtype: "error_max_turns", terminalReason: "max_turns" }, NOW)).toEqual({ kind: "fatal", code: "error_max_turns" });
    expect(classifyClaudeFailure({ resultSubtype: "error_max_budget_usd" }, NOW)).toEqual({ kind: "fatal", code: "error_max_budget_usd" });
    expect(classifyClaudeFailure({ resultSubtype: "success", terminalReason: "prompt_too_long", apiErrorStatus: 400 }, NOW))
      .toEqual({ kind: "fatal", status: 400, code: "prompt_too_long" });
  });

  it("carries the provider's retry counters and drops invalid ones", () => {
    expect(classifyClaudeFailure({ assistantError: "overloaded", apiRetry: { attempt: 3, maxRetries: 10 } }, NOW))
      .toEqual({ kind: "retryable", code: "overloaded", retries: { made: 3, max: 10 } });
    expect(classifyClaudeFailure({ apiRetry: { attempt: 0, maxRetries: 0 } }, NOW)).toEqual({ kind: "fatal", retries: { made: 0 } });
    expect(classifyClaudeFailure({ apiRetry: { attempt: -1 } }, NOW)).toEqual({ kind: "fatal" });
  });

  it("drops a code that does not fit the wire bounds", () => {
    expect(classifyClaudeFailure({ resultSubtype: "x".repeat(129), terminalReason: "  " }, NOW)).toEqual({ kind: "fatal" });
  });
});
