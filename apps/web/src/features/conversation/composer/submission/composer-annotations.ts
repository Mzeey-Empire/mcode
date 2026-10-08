import {
  isDiffAnnotationPayload,
  type DiffAnnotationPayload,
  type DraftDiffComment,
  type PreviewAnnotationBundle,
} from "@mcode/contracts";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import {
  clearVisibleDiffComments,
  numberDiffComments,
  readVisibleDiffComments,
  restoreQueuedDiffComments,
} from "../draft/draft-diff-comments";

/** Strips draft bookkeeping so the bundle carries only the annotation payload. */
function toPayload({ revision: _revision, ...payload }: DraftDiffComment): DiffAnnotationPayload {
  return payload;
}

/**
 * Builds the annotation bundle for the next Send from the scope's Browser
 * annotations and the thread draft's visible Review comments.
 */
export function buildComposerAnnotationBundle(
  scopeId: string | undefined,
  diffComments: readonly DraftDiffComment[] = scopeId ? readVisibleDiffComments(scopeId) : [],
): PreviewAnnotationBundle | undefined {
  if (!scopeId) return undefined;
  const preview = usePreviewAnnotationStore.getState().buildBundle(scopeId)?.annotations ?? [];
  const annotations = [...preview, ...numberDiffComments(diffComments, preview.length).map(toPayload)];
  return annotations.length > 0 ? { schemaVersion: 1, annotations } : undefined;
}

/** Clears the scope's Browser annotations and visible Review comments. */
export function clearComposerAnnotations(scopeId: string): void {
  usePreviewAnnotationStore.getState().clearThread(scopeId);
  clearVisibleDiffComments(scopeId);
}

/** Restores a queued bundle: Browser annotations to their store, Review comments to the draft. */
export function restoreComposerAnnotations(
  scopeId: string,
  bundle: PreviewAnnotationBundle | undefined,
): boolean {
  const restored = usePreviewAnnotationStore.getState().restoreBundle(scopeId, bundle);
  clearVisibleDiffComments(scopeId);
  if (restored && bundle) {
    restoreQueuedDiffComments(scopeId, bundle.annotations.filter(isDiffAnnotationPayload));
  }
  return restored;
}
