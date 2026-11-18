import type { TerminalProfileReference } from "@mcode/contracts/models/terminal";
import type { TerminalPreferencesUpdate } from "@mcode/contracts/models/terminal-settings";
import type { SettingsPatch } from "./settingsStore";

/**
 * What one local write sends. A Settings visit counts a changed setting as this window's own only when an in-flight
 * write sends the value it now reads; a write that pulls in the whole settings object (a fetch) must not claim the rest.
 */
export type LocalWriteScope =
  | { readonly sink: "settings"; readonly patch: SettingsPatch }
  | { readonly sink: "terminalPreferences"; readonly patch: TerminalPreferencesUpdate }
  | { readonly sink: "terminalGlobalDefault"; readonly profileId: TerminalProfileReference }
  // A null profile resets the project to the global default.
  | { readonly sink: "terminalProjectDefault"; readonly workspaceId: string; readonly profileId: TerminalProfileReference | null };

let lastWriteSeq = 0;
const inFlight = new Map<number, LocalWriteScope>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Marks a local settings write and what it writes, so a Settings visit can tell it from a push from elsewhere.
 * Nested and parallel writes count. Every store action that writes a revertible setting must run inside this, or its
 * changes look external.
 */
export async function trackLocalSettingsWrite<T>(scope: LocalWriteScope, write: () => Promise<T>): Promise<T> {
  const seq = ++lastWriteSeq;
  inFlight.set(seq, scope);
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
  for (const seq of inFlight.keys()) if (seq > sinceSeq) return true;
  return false;
}

/** Scopes of the local writes in flight that started after `sinceSeq`. */
export function localSettingsWriteScopes(sinceSeq: number): readonly LocalWriteScope[] {
  return [...inFlight].filter(([seq]) => seq > sinceSeq).map(([, scope]) => scope);
}

/** Calls `listener` whenever a local write starts or ends. Returns the unsubscribe function. */
export function subscribeLocalSettingsWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
