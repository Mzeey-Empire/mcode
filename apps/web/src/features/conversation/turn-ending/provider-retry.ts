import { PROVIDER_CATALOG } from "@mcode/contracts";
import { formatDuration } from "@/lib/time";

/** The provider's latest automatic retry notice, held until the next non-retry event. */
export interface ProviderRetry {
  attempt?: number;
  maxRetries?: number;
  delayMs?: number;
  /** HTTP status that triggered the retry. Absent for connection errors. */
  errorStatus?: number;
  /** Client epoch ms when the notice arrived; the countdown runs from here. */
  receivedAt: number;
}

/** A retry paired with the provider name the line shows, for example "Codex". */
export interface ProviderRetryNotice {
  retry: ProviderRetry;
  providerLabel: string;
}

/** Reason phrases for the statuses providers retry on. Unlisted statuses render as "HTTP {status}". */
const STATUS_PHRASES: Readonly<Record<number, string>> = {
  408: "Request Timeout",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  529: "Overloaded",
};

/** Formats an HTTP status as "502 Bad Gateway", or "HTTP 520" when the status has no phrase. */
export function statusPhrase(status: number): string {
  const phrase = STATUS_PHRASES[status];
  return phrase ? `${status} ${phrase}` : `HTTP ${status}`;
}

/** Display name for a thread's provider id, or a neutral noun when the id is unknown. */
export function providerDisplayName(providerId: string | undefined): string {
  return PROVIDER_CATALOG.find((entry) => entry.id === providerId)?.name ?? "The provider";
}

/** Whole seconds until the next attempt, or 0 once the delay has elapsed or is unknown. */
export function secondsUntilNextAttempt(retry: ProviderRetry, nowMs: number): number {
  if (retry.delayMs === undefined) return 0;
  return Math.max(0, Math.ceil((retry.receivedAt + retry.delayMs - nowMs) / 1000));
}

function attemptPart(retry: ProviderRetry): string | undefined {
  if (retry.attempt === undefined) return undefined;
  return retry.maxRetries === undefined
    ? `attempt ${retry.attempt}`
    : `attempt ${retry.attempt} of ${retry.maxRetries}`;
}

/**
 * The detail under "{Provider} is retrying", for example "502 Bad Gateway · attempt 2 of 10 · next in 8s".
 * Parts the provider did not report are left out, and null means no part is known.
 */
export function providerRetryDetail(retry: ProviderRetry, nowMs: number): string | null {
  const seconds = secondsUntilNextAttempt(retry, nowMs);
  const parts = [
    retry.errorStatus === undefined ? undefined : statusPhrase(retry.errorStatus),
    attemptPart(retry),
    seconds > 0 ? `next in ${formatDuration(seconds)}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : null;
}
