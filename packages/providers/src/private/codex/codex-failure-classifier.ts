import type { TurnFailure, TurnFailureKind } from "@mcode/contracts";
import { failureCode, failureRetries, httpStatus, retryAfterMsUntil, turnFailure } from "../turn-failure-fields.js";
import type { CodexHttpErrorInfoName, CodexRateLimitWindow, CodexUnitErrorInfo } from "./codex-types.js";

/** The latest known Codex account rate-limit windows. */
export interface CodexRateLimitWindows {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
}

/** Native Codex signals gathered while a turn ran, read when it fails. */
export interface CodexFailureEvidence {
  /** `TurnError.codexErrorInfo` from the failed turn. */
  codexErrorInfo?: unknown;
  /** Windows from the latest `account/rateLimits/updated`. */
  rateLimits?: CodexRateLimitWindows;
  /** `error` notifications with `willRetry` seen during the turn. */
  retriesMade?: number;
}

/** A `CodexErrorInfo` reduced to its variant name and forwarded HTTP status. */
export interface CodexErrorInfoSummary {
  code?: string;
  status?: number;
}

const CODEX_ERROR_KINDS: ReadonlyArray<readonly [CodexUnitErrorInfo | CodexHttpErrorInfoName, TurnFailureKind]> = [
  ["usageLimitExceeded", "usage_limit"],
  ["unauthorized", "auth"],
  // Codex sends rateLimitExceeded for short request-rate throttling; account quota is usageLimitExceeded.
  ["rateLimitExceeded", "retryable"],
  ["serverOverloaded", "retryable"],
  ["internalServerError", "retryable"],
  ["httpConnectionFailed", "retryable"],
  ["responseStreamConnectionFailed", "retryable"],
  ["responseStreamDisconnected", "retryable"],
  ["responseTooManyFailedAttempts", "retryable"],
];
const KIND_BY_CODEX_ERROR: ReadonlyMap<string, TurnFailureKind> = new Map(CODEX_ERROR_KINDS);

const LIMIT_TYPE_BY_WINDOW_MINUTES: ReadonlyMap<number, string> = new Map([
  [300, "five_hour"],
  [10_080, "seven_day"],
]);

/**
 * Classifies a failed Codex turn from its native evidence.
 * Pure: `now` is the emission time used to turn the rate-limit reset into a relative wait.
 */
export function classifyCodexFailure(evidence: CodexFailureEvidence, now: number): TurnFailure {
  const { code, status } = readCodexErrorInfo(evidence.codexErrorInfo);
  const kind = (code === undefined ? undefined : KIND_BY_CODEX_ERROR.get(code)) ?? "fatal";
  const window = kind === "usage_limit" ? limitingWindow(evidence.rateLimits) : undefined;
  return turnFailure(kind, {
    status,
    code,
    retryAfterMs: retryAfterMsUntil(window?.resetsAt, now),
    limitType: window?.windowDurationMins === undefined ? undefined : LIMIT_TYPE_BY_WINDOW_MINUTES.get(window.windowDurationMins),
    // No willRetry notice means Codex reported no retries, so the field stays absent rather than claiming zero.
    retries: evidence.retriesMade ? failureRetries(evidence.retriesMade) : undefined,
  });
}

/** Reads the variant name and forwarded HTTP status from a native `CodexErrorInfo`. */
export function readCodexErrorInfo(value: unknown): CodexErrorInfoSummary {
  // "other" is the serialized untagged fallback and names nothing.
  if (typeof value === "string") return value === "other" ? {} : { code: failureCode(value) };
  if (!isRecord(value)) return {};
  const names = Object.keys(value);
  const name = names.length === 1 ? names[0] : undefined;
  if (name === undefined) return {};
  const payload = value[name];
  return { code: failureCode(name), status: isRecord(payload) ? httpStatus(payload.httpStatusCode) : undefined };
}

/** Picks the window that blocked the account: the fullest one, and on a tie the one that resets last. */
function limitingWindow(windows: CodexRateLimitWindows | undefined): CodexRateLimitWindow | undefined {
  const candidates = [windows?.primary, windows?.secondary].filter((window): window is CodexRateLimitWindow => window != null);
  return candidates.reduce<CodexRateLimitWindow | undefined>((best, window) => (best === undefined || blocksLonger(window, best) ? window : best), undefined);
}

function blocksLonger(window: CodexRateLimitWindow, other: CodexRateLimitWindow): boolean {
  const used = window.usedPercent ?? -1;
  const otherUsed = other.usedPercent ?? -1;
  if (used !== otherUsed) return used > otherUsed;
  return (window.resetsAt ?? -1) > (other.resetsAt ?? -1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
