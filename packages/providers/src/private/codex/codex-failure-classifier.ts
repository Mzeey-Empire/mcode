import type { TurnFailure, TurnFailureKind } from "@mcode/contracts";
import { failureCode, failureRetries, httpStatus, kindByHttpStatus, retryAfterMsUntil, turnFailure } from "../turn-failure-fields.js";
import { ProviderTurnError } from "../../provider-turn-error.js";
import { CodexRpcResponseError, CodexTransportError } from "./codex-rpc-client.js";
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
  // Flex capacity is a 429 that clears on its own (codex-rs protocol/src/error.rs http_status_code_value).
  ["flexUnavailable", "retryable"],
  ["internalServerError", "retryable"],
  ["httpConnectionFailed", "retryable"],
  ["responseStreamConnectionFailed", "retryable"],
  ["responseStreamDisconnected", "retryable"],
  ["responseTooManyFailedAttempts", "retryable"],
];
const KIND_BY_CODEX_ERROR: ReadonlyMap<string, TurnFailureKind> = new Map(CODEX_ERROR_KINDS);

/**
 * Codex wraps every HTTP status it has no special case for (a 401 after token refresh is exhausted,
 * a 403 block, a 404 model) in these variants, so the forwarded status decides the kind. The split
 * follows codex-rs's own retry policy (ext/guardian-reviewer/src/retry.rs).
 */
const HTTP_ERROR_INFO_NAMES: ReadonlySet<string> = new Set<CodexHttpErrorInfoName>([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);

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
  const kind = codexFailureKind(code, status);
  const window = kind === "usage_limit" ? exhaustedWindow(evidence.rateLimits, now) : undefined;
  return turnFailure(kind, {
    status,
    code,
    retryAfterMs: retryAfterMsUntil(window?.resetsAt, now),
    limitType: window?.windowDurationMins === undefined ? undefined : LIMIT_TYPE_BY_WINDOW_MINUTES.get(window.windowDurationMins),
    // No willRetry notice means Codex reported no retries, so the field stays absent rather than claiming zero.
    retries: evidence.retriesMade ? failureRetries(evidence.retriesMade) : undefined,
  });
}

function codexFailureKind(code: string | undefined, status: number | undefined): TurnFailureKind {
  if (code === undefined) return "fatal";
  if (status !== undefined && HTTP_ERROR_INFO_NAMES.has(code)) return kindByHttpStatus(status);
  return KIND_BY_CODEX_ERROR.get(code) ?? "fatal";
}

/**
 * Classifies an error Mcode raised itself while driving the app-server, before or outside a
 * `turn/completed`. These carry no `codexErrorInfo` (app-server JSON-RPC errors have none), so
 * only a lost connection is retryable and anything else, including a JSON-RPC refusal, is fatal.
 */
export function classifyCodexLocalFailure(error: unknown): TurnFailure {
  if (error instanceof ProviderTurnError) return error.failure;
  if (error instanceof CodexTransportError) return { kind: "retryable" };
  const code = error instanceof CodexRpcResponseError && error.code !== undefined ? String(error.code) : undefined;
  return turnFailure("fatal", { code: failureCode(code) });
}

/** Reads the variant name and forwarded HTTP status from a native `CodexErrorInfo`. */
export function readCodexErrorInfo(value: unknown): CodexErrorInfoSummary {
  // "other" is the serialized untagged fallback and names nothing. codex-rs folds both
  // exhausted stream and timeout retries and content filters, invalid requests, and spawn
  // failures into it (protocol/src/error.rs to_codex_protocol_error), so it stays fatal.
  if (typeof value === "string") return value === "other" ? {} : { code: failureCode(value) };
  if (!isRecord(value)) return {};
  const names = Object.keys(value);
  const name = names.length === 1 ? names[0] : undefined;
  if (name === undefined) return {};
  const payload = value[name];
  return { code: failureCode(name), status: isRecord(payload) ? httpStatus(payload.httpStatusCode) : undefined };
}

/**
 * Picks the window that is blocking the account: full and not yet reset, the later reset winning.
 * usageLimitExceeded also covers API quota and plan-upgrade errors that no window explains, and the
 * cached windows can be stale, so a window that is not full or has reset gives no wait at all.
 */
function exhaustedWindow(windows: CodexRateLimitWindows | undefined, now: number): CodexRateLimitWindow | undefined {
  return [windows?.primary, windows?.secondary]
    .filter((window): window is BlockingWindow => window != null && blocksNow(window, now))
    .reduce<BlockingWindow | undefined>((latest, window) => (latest === undefined || window.resetsAt > latest.resetsAt ? window : latest), undefined);
}

type BlockingWindow = CodexRateLimitWindow & { resetsAt: number };

function blocksNow(window: CodexRateLimitWindow, now: number): window is BlockingWindow {
  return (window.usedPercent ?? 0) >= 100 && window.resetsAt !== undefined && window.resetsAt * 1000 > now;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
