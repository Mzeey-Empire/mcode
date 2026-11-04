const MAX_STRING_LENGTH = 512;
const MAX_COLLECTION_ITEMS = 32;
const MAX_DEPTH = 4;
const SECRET_KEY = /^(token|api[_-]?key|secret|password|authorization)$/i;

/** Secret redaction shared by every diagnostics channel. */
export function redactDiagnostic(value: string): string {
  const withoutBearer = value.replace(/\bBearer\s+[^\s,;}]+/gi, "Bearer [redacted]");
  const withoutAssignments = withoutBearer.replace(
    /\b(token|api[_-]?key|secret|password|authorization)\s*[:=]\s*["']?[^\s,;}"']+/gi,
    "$1=[redacted]",
  );
  const withoutJwts = withoutAssignments.replace(/\beyJ[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
  return withoutJwts.replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]");
}

function boundEntry(key: string, item: unknown, depth: number): [string, unknown] {
  const boundKey = key.slice(0, MAX_STRING_LENGTH);
  if (SECRET_KEY.test(key)) return [boundKey, "[redacted]"];
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
