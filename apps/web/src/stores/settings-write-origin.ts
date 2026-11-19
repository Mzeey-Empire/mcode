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

/** One in-flight local write: its start sequence and what it sends. */
export interface LocalWrite {
  readonly seq: number;
  readonly scope: LocalWriteScope;
}

let lastWriteSeq = 0;
const inFlight = new Map<number, LocalWriteScope>();
const listeners = new Set<() => void>();
const failureListeners = new Set<(seq: number) => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Marks a local settings write and what it writes, so a Settings visit can tell it from a push from elsewhere.
 * Nested and parallel writes count. Every store action that writes a revertible setting must run inside this, or its
 * changes look external. `landed` tells from the write's result whether it was saved; a write that throws or did not
 * land is reported to `subscribeFailedLocalSettingsWrites` listeners.
 */
export async function trackLocalSettingsWrite<T>(scope: LocalWriteScope, write: () => Promise<T>, landed: (result: T) => boolean): Promise<T> {
  const seq = ++lastWriteSeq;
  inFlight.set(seq, scope);
  notify();
  let saved = false;
  try {
    const result = await write();
    saved = landed(result);
    return result;
  } finally {
    inFlight.delete(seq);
    if (!saved) for (const listener of failureListeners) listener(seq);
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

/** The local writes in flight that started after `sinceSeq`. */
export function localSettingsWrites(sinceSeq: number): readonly LocalWrite[] {
  return [...inFlight].filter(([seq]) => seq > sinceSeq).map(([seq, scope]) => ({ seq, scope }));
}

/** Calls `listener` with the sequence of each local write that failed or did not land. Returns the unsubscribe function. */
export function subscribeFailedLocalSettingsWrites(listener: (seq: number) => void): () => void {
  failureListeners.add(listener);
  return () => {
    failureListeners.delete(listener);
  };
}

/** Calls `listener` whenever a local write starts or ends. Returns the unsubscribe function. */
export function subscribeLocalSettingsWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
