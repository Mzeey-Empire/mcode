let lastWriteSeq = 0;
const inFlight = new Set<number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Marks a local settings write so a Settings visit can tell it from a push from elsewhere. Nested and parallel writes
 * count. Every store action that writes a revertible setting must run inside this, or its changes look external.
 */
export async function trackLocalSettingsWrite<T>(write: () => Promise<T>): Promise<T> {
  const seq = ++lastWriteSeq;
  inFlight.add(seq);
  notify();
  try {
    return await write();
  } finally {
    inFlight.delete(seq);
    notify();
  }
}

/** Sequence number of the latest local write to start; a visit keeps it so earlier writes never count as its own. */
export function latestLocalSettingsWriteSeq(): number {
  return lastWriteSeq;
}

/** True while a local write that started after `sinceSeq` is in flight. */
export function isLocalSettingsWriteInFlight(sinceSeq = 0): boolean {
  for (const seq of inFlight) if (seq > sinceSeq) return true;
  return false;
}

/** Calls `listener` whenever a local write starts or ends. Returns the unsubscribe function. */
export function subscribeLocalSettingsWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
