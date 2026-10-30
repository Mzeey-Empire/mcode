// Session storage, not local storage: a reload of this window reopens its thread,
// while a fresh window or app launch still starts on New thread.
const STORAGE_KEY = "mcode-open-thread";

/** The thread this window had open before it reloaded, or null when it had none. */
export function readRememberedOpenThread(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Remembers the open thread so a reload of this window can reopen it; null forgets it. */
export function rememberOpenThread(threadId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (threadId) window.sessionStorage.setItem(STORAGE_KEY, threadId);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Browser storage can be unavailable; the selection still applies until the next reload.
  }
}
