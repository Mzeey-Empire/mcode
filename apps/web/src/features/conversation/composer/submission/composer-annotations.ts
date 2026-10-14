import {
  isDiffAnnotationPayload,
  isFileAnnotationPayload,
  type DiffAnnotationPayload,
  type DraftDiffComment,
  type DraftFileComment,
  type FileAnnotationPayload,
  type PreviewAnnotationBundle,
} from "@mcode/contracts";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import {
  clearVisibleDiffComments,
  numberDiffComments,
  readVisibleDiffComments,
  restoreQueuedDiffComments,
} from "../draft/draft-diff-comments";
import {
  clearVisibleFileComments,
  numberFileComments,
  readVisibleFileComments,
  restoreQueuedFileComments,
} from "../draft/draft-file-comments";

/** Strips draft bookkeeping so the bundle carries only the annotation payload. */
function toPayload({ revision: _revision, ...payload }: DraftDiffComment): DiffAnnotationPayload {
  return payload;
}

function toFilePayload({ revision: _revision, ...payload }: DraftFileComment): FileAnnotationPayload {
  return payload;
}

/**
 * Builds the annotation bundle for the next Send from the scope's Browser
 * annotations and the thread draft's visible Review and Files comments,
 * numbered in that order.
 */
export function buildComposerAnnotationBundle(
  scopeId: string | undefined,
  diffComments: readonly DraftDiffComment[] = scopeId ? readVisibleDiffComments(scopeId) : [],
  fileComments: readonly DraftFileComment[] = scopeId ? readVisibleFileComments(scopeId) : [],
): PreviewAnnotationBundle | undefined {
  if (!scopeId) return undefined;
  const preview = usePreviewAnnotationStore.getState().buildBundle(scopeId)?.annotations ?? [];
  const annotations = [
    ...preview,
    ...numberDiffComments(diffComments, preview.length).map(toPayload),
    ...numberFileComments(fileComments, preview.length + diffComments.length).map(toFilePayload),
  ];
  return annotations.length > 0 ? { schemaVersion: 1, annotations } : undefined;
}

/** Clears the scope's Browser annotations and visible Review and Files comments. */
export function clearComposerAnnotations(scopeId: string): void {
  usePreviewAnnotationStore.getState().clearThread(scopeId);
  clearVisibleDiffComments(scopeId);
  clearVisibleFileComments(scopeId);
}

/** Restores a queued bundle: Browser annotations to their store, Review and Files comments to the draft. */
export function restoreComposerAnnotations(
  scopeId: string,
  bundle: PreviewAnnotationBundle | undefined,
): boolean {
  const restored = usePreviewAnnotationStore.getState().restoreBundle(scopeId, bundle);
  clearVisibleDiffComments(scopeId);
  clearVisibleFileComments(scopeId);
  if (restored && bundle) {
    restoreQueuedDiffComments(scopeId, bundle.annotations.filter(isDiffAnnotationPayload));
    restoreQueuedFileComments(scopeId, bundle.annotations.filter(isFileAnnotationPayload));
  }
  return restored;
}
