import { getTransport } from "@/transport";
import { useDiffStore } from "@/stores/diffStore";

/**
 * Refresh Review state after `turn.persisted`. Centralizes the Review panel
 * update so chat (`threadStore`) and Changes (`diffStore`) stay aligned on the
 * same turn-end event. Every turn gets an ordinal, so a loaded turn list
 * refetches even when the turn touched no files; snapshots refetch only when
 * it did.
 */
export function refreshTurnSnapshotsAfterPersist(
  threadId: string,
  filesChanged: string[],
): void {
  refreshLoadedReviewTurns(threadId);
  if (filesChanged.length === 0) return;

  useDiffStore.getState().bumpDiffRevision(threadId);

  const transport = getTransport();

  void transport
    .listSnapshots(threadId)
    .then((snapshots) => useDiffStore.getState().setSnapshots(threadId, snapshots))
    .catch(() => { /* non-critical */ });
}

function refreshLoadedReviewTurns(threadId: string): void {
  const state = useDiffStore.getState();
  if (state.reviewTurnsByThread[threadId] === undefined && state.reviewTurnsErrorByThread[threadId] === undefined) return;
  void getTransport()
    .listReviewTurns(threadId)
    .then((turns) => useDiffStore.getState().setReviewTurns(threadId, turns))
    .catch((error: unknown) => {
      useDiffStore.getState().setReviewTurnsError(threadId, error instanceof Error ? error.message : String(error));
    });
}
