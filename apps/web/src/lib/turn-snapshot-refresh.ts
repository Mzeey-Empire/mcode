import { getTransport } from "@/transport";
import { useDiffStore } from "@/stores/diffStore";

/**
 * Refresh turn snapshots after `turn.persisted` when a turn touched files.
 * Centralizes the Review panel update so chat (`threadStore`) and Changes
 * (`diffStore`) stay aligned on the same turn-end event.
 */
export function refreshTurnSnapshotsAfterPersist(
  threadId: string,
  filesChanged: string[],
): void {
  if (filesChanged.length === 0) return;

  useDiffStore.getState().bumpDiffRevision(threadId);

  const transport = getTransport();

  void transport
    .listSnapshots(threadId)
    .then((snapshots) => useDiffStore.getState().setSnapshots(threadId, snapshots))
    .catch(() => { /* non-critical */ });
}
