import {
  isDiffAnnotationPayload,
  isFileAnnotationPayload,
  type DiffAnnotationPayload,
  type DraftBrowserNotePage,
  type DraftDiffComment,
  type DraftFileComment,
  type FileAnnotationPayload,
  type PreviewAnnotationBundle,
} from "@mcode/contracts";
import {
  browserPagesToBundle,
  clearVisibleBrowserNotes,
  readVisibleBrowserNotePages,
  restoreQueuedBrowserNotes,
} from "../draft/draft-browser-notes";
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
 * Builds the annotation bundle for the next Send from the thread draft's
 * visible Browser notes, Review comments and Files comments, numbered in that order.
 */
export function buildComposerAnnotationBundle(
  scopeId: string | undefined,
  diffComments: readonly DraftDiffComment[] = scopeId ? readVisibleDiffComments(scopeId) : [],
  fileComments: readonly DraftFileComment[] = scopeId ? readVisibleFileComments(scopeId) : [],
  browserNotePages: readonly DraftBrowserNotePage[] = scopeId ? readVisibleBrowserNotePages(scopeId) : [],
): PreviewAnnotationBundle | undefined {
  if (!scopeId) return undefined;
  const { pages, annotations: preview } = browserPagesToBundle(browserNotePages);
  const annotations = [
    ...preview,
    ...numberDiffComments(diffComments, preview.length).map(toPayload),
    ...numberFileComments(fileComments, preview.length + diffComments.length).map(toFilePayload),
  ];
  if (annotations.length === 0) return undefined;
  return { schemaVersion: 2, pages, annotations };
}

/** Clears the scope's visible Browser notes, Review comments and Files comments. */
export function clearComposerAnnotations(scopeId: string): void {
  clearVisibleBrowserNotes(scopeId);
  clearVisibleDiffComments(scopeId);
  clearVisibleFileComments(scopeId);
}

/** Restores a queued bundle's Browser notes, Review comments and Files comments to the draft. */
export function restoreComposerAnnotations(
  scopeId: string,
  bundle: PreviewAnnotationBundle | undefined,
): boolean {
  const restored = restoreQueuedBrowserNotes(scopeId, bundle);
  clearVisibleDiffComments(scopeId);
  clearVisibleFileComments(scopeId);
  if (restored && bundle) {
    restoreQueuedDiffComments(scopeId, bundle.annotations.filter(isDiffAnnotationPayload));
    restoreQueuedFileComments(scopeId, bundle.annotations.filter(isFileAnnotationPayload));
  }
  return restored;
}
