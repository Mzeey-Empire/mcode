import type { TurnFileEvidenceEvent } from "@mcode/contracts/models/turn-file-evidence";

/** File evidence per execution id. */
export type FileEvidenceByExecution = Readonly<Record<string, TurnFileEvidenceEvent>>;

/** Shared empty value so records without evidence keep a stable reference. */
export const EMPTY_FILE_EVIDENCE: FileEvidenceByExecution = Object.freeze({});

/** Whether the server finished observing the execution's files. */
export function isResolvedFileEvidence(event: TurnFileEvidenceEvent | undefined): boolean {
  return event !== undefined && event.evidence.state !== "tracking";
}

/**
 * Merge evidence monotonically. The server resolves each execution once, but
 * pushes, pages and caches arrive in any order, so a stale `tracking` copy must
 * never put a resolved execution back to pending. Returns `current` unchanged
 * when nothing new was learned, so selectors keep their reference.
 */
export function mergeFileEvidence(
  current: FileEvidenceByExecution,
  incoming: readonly TurnFileEvidenceEvent[],
): FileEvidenceByExecution {
  let merged: Record<string, TurnFileEvidenceEvent> | undefined;
  for (const event of incoming) {
    const existing = (merged ?? current)[event.executionId];
    if (existing && (isResolvedFileEvidence(existing) || !isResolvedFileEvidence(event))) continue;
    merged ??= { ...current };
    merged[event.executionId] = event;
  }
  return merged ?? current;
}

/**
 * Changed paths from recorded evidence keyed by the transcript message that
 * shows them. `localMessageId` maps a server message id to the resident row.
 */
export function recordedEvidencePaths(
  evidence: FileEvidenceByExecution,
  localMessageId: (serverMessageId: string) => string = (id) => id,
): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const event of Object.values(evidence)) {
    if (event.evidence.state !== "recorded" || event.messageId === null || event.evidence.filesChanged.length === 0) continue;
    paths[localMessageId(event.messageId)] = event.evidence.filesChanged;
  }
  return paths;
}
