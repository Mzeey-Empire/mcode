/** The provider's latest automatic retry notice, held until the next non-retry event. */
export interface ProviderRetry {
  /** HTTP status that triggered the retry. Absent for connection errors. */
  errorStatus?: number;
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
