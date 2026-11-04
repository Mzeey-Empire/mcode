const MAX_STRING_LENGTH = 512;
const MAX_COLLECTION_ITEMS = 32;
const MAX_DEPTH = 4;
// Matches the suffix of a normalized key, so "accessToken" and "client_secret" redact while counters such as "tokensIn" stay readable.
const SECRET_KEY_SUFFIX = /(token|secret|password|passwd|apikey|privatekey|authorization|cookie|credentials?)$/;
const PROVIDER_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_SUFFIX.test(key.toLowerCase().replace(/[_-]/g, ""));
}

/** Secret redaction shared by every diagnostics channel. */
export function redactDiagnostic(value: string): string {
  const withoutBearer = value.replace(/\bBearer\s+[^\s,;}]+/gi, "Bearer [redacted]");
  const withoutAssignments = withoutBearer.replace(
    /\b(token|api[_-]?key|secret|password|authorization)\s*[:=]\s*["']?[^\s,;}"']+/gi,
    "$1=[redacted]",
  );
  const withoutJwts = withoutAssignments.replace(/\beyJ[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
  const withoutProviderTokens = withoutJwts.replace(PROVIDER_TOKEN, "[redacted]");
  return withoutProviderTokens.replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]");
}

function boundEntry(key: string, item: unknown, depth: number): [string, unknown] {
  const boundKey = key.slice(0, MAX_STRING_LENGTH);
  if (isSecretKey(key)) return [boundKey, "[redacted]"];
  return [boundKey, boundPayload(item, depth + 1)];
}

/** Bounds work and output even for recursive or unexpectedly large payloads. */
export function boundPayload(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return redactDiagnostic(value).slice(0, MAX_STRING_LENGTH);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[bounded]";

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_COLLECTION_ITEMS);
    return items.map((item) => boundPayload(item, depth + 1));
  }

  const entries = Object.entries(value).slice(0, MAX_COLLECTION_ITEMS);
  const boundEntries = entries.map(([key, item]) => boundEntry(key, item, depth));
  // fromEntries defines own properties, so a "__proto__" key cannot change the prototype.
  return Object.fromEntries(boundEntries);
}
