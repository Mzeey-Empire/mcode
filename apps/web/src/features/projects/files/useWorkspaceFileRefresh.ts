import { useEffect } from "react";
import { getTransport } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

const REFRESH_THROTTLE_MS = 1500;
const lastRefreshAtByScope = new Map<string, number>();

/**
 * Asks the server to diff the scope's dirty file set and emit `files.changed`
 * when it moved. Throttled per scope so attention triggers (focus, panel
 * mount, picker open) collapse into at most one status query each.
 */
export function refreshWorkspaceFiles(workspaceId: string, threadId?: string): void {
  // Optimistic placeholders are never persisted, so thread-scoped refreshes
  // would fail with "Thread not found" until the create RPC swaps in the row.
  const scope = isClientOnlyThread(threadId) ? undefined : threadId;
  const throttleKey = scope ? `${workspaceId}:${scope}` : workspaceId;
  const now = Date.now();
  if (now - (lastRefreshAtByScope.get(throttleKey) ?? 0) < REFRESH_THROTTLE_MS) return;
  lastRefreshAtByScope.set(throttleKey, now);
  void getTransport().refreshWorkspaceFiles(workspaceId, scope).catch((error: unknown) => {
    if (isConnectionRace(error)) return;
    console.error("[files] Failed to refresh workspace files", error);
  });
}

/** Refreshes an active workspace scope on mount, scope change, reconnect, and window focus. */
export function useWorkspaceFileRefresh(
  workspaceId: string | null | undefined,
  threadId: string | null | undefined,
): void {
  const connectionStatus = useConnectionStore((state) => state.status);
  // Re-runs the effect when a placeholder thread resolves into a persisted row.
  const clientOnlyThread = useWorkspaceStore((state) => isClientOnlyThread(threadId ?? undefined, state.threads));

  useEffect(() => {
    if (!workspaceId || connectionStatus !== "connected") return;
    const refresh = () => refreshWorkspaceFiles(workspaceId, threadId ?? undefined);
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [clientOnlyThread, connectionStatus, threadId, workspaceId]);
}

function isClientOnlyThread(
  threadId: string | undefined,
  threads = useWorkspaceStore.getState().threads,
): boolean {
  if (!threadId) return false;
  const row = threads.find((candidate) => candidate.id === threadId);
  return Boolean(row?.clientPreparing || row?.clientError);
}

function isConnectionRace(error: unknown): boolean {
  return error instanceof Error && (error.message === "WebSocket disconnected" || error.message === "Transport closed");
}
