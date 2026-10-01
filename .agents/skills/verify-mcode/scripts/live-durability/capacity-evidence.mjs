/** Distinguishes exact retained-save rejection from provider publication saturation and ordinary writer errors. */
export function classifyCapacityEvidence(lines, { threadId, executionId, invokedAt }) {
  const matching = [];
  for (const line of lines) {
    const entry = matchingEntry(line, { threadId, executionId, invokedAt });
    if (!entry) continue;
    const error = errorMessage(entry);
    if (typeof error !== 'string') continue;
    const kind = errorKind(error);
    matching.push({ at: entry.timestamp, executionId: entry.executionId ?? null, kind,
      error: error.slice(0, 512), message: String(entry.message ?? '').slice(0, 512), exhausted: entry.exhausted ?? null });
  }
  return matching;
}

function matchingEntry(line, { threadId, executionId, invokedAt }) {
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (!entry || entry.threadId !== threadId || Date.parse(entry.timestamp) < Date.parse(invokedAt) || !Number.isFinite(Date.parse(entry.timestamp))) return null;
  if (entry.executionId && entry.executionId !== executionId) return null;
  return entry;
}

function errorMessage(entry) { return typeof entry.error === 'string' ? entry.error : entry.error?.message; }

function errorKind(error) {
  if (error === 'Accepted progress admission rejected: retention-exhausted') return 'retained-save-capacity';
  if (/^(?:Devin|Codex) canonical event queue overflowed for execution /.test(error)) return 'provider-publisher-capacity';
  return error.includes('database is locked') ? 'sqlite-busy' : 'other';
}
