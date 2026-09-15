import { useEffect } from "react";
import { getTransport } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

/** Subscribes an active workspace scope to server-owned local file invalidations. */
export function useWorkspaceFileInvalidation(
  workspaceId: string | null | undefined,
  threadId: string | null | undefined,
): void {
  const connectionStatus = useConnectionStore((state) => state.status);
  // Optimistic placeholders are never persisted, so thread-scoped watches would
  // fail with "Thread not found" until the create RPC swaps in the real row.
  const clientOnlyThread = useWorkspaceStore((state) => {
    if (!threadId) return false;
    const row = state.threads.find((candidate) => candidate.id === threadId);
    return Boolean(row?.clientPreparing || row?.clientError);
  });

  useEffect(() => {
    if (!workspaceId || connectionStatus !== "connected") return;
    const scope = clientOnlyThread ? undefined : (threadId ?? undefined);
    void getTransport().watchWorkspaceFiles(workspaceId, scope).catch((error: unknown) => {
      if (isConnectionRace(error)) return;
      console.error("[files] Failed to subscribe to workspace invalidation", error);
    });
  }, [clientOnlyThread, connectionStatus, threadId, workspaceId]);
}

function isConnectionRace(error: unknown): boolean {
  return error instanceof Error && (error.message === "WebSocket disconnected" || error.message === "Transport closed");
}
