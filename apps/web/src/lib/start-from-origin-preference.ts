const STORAGE_KEY = "mcode-start-from-origin";

function readProjectIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Whether the project last started a New worktree thread with Start from origin on. Off by default. */
export function readRememberedStartFromOrigin(workspaceId: string | null): boolean {
  if (typeof window === "undefined" || !workspaceId) return false;
  return readProjectIds().includes(workspaceId);
}

/** Remembers the Start from origin switch per project, so the next new thread there starts the same way. */
export function rememberStartFromOrigin(workspaceId: string, on: boolean): void {
  if (typeof window === "undefined") return;
  const others = readProjectIds().filter((id) => id !== workspaceId);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(on ? [...others, workspaceId] : others));
  } catch {
    // Browser storage can be unavailable; the switch still applies to the current thread.
  }
}
