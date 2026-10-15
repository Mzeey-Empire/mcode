import { clampPreviewPageLabel, clampPreviewPageUrl } from "@mcode/contracts";
import {
  usePreviewAnnotationStore,
  type PreviewCleanCapture,
  type PreviewDraftAnnotation,
  type SavedPreviewAnnotation,
} from "../state/previewAnnotationStore";
import { schedulePageSnapshot } from "./previewNoteSnapshots";

/**
 * Saves a note with the page screenshot taken for it, then queues the page's marked image to be
 * redrawn. A fresh screenshot replaces the page's old one, so every note on the page is drawn on it.
 */
export function savePreviewNote(
  threadId: string,
  draft: PreviewDraftAnnotation,
  clean: PreviewCleanCapture,
  editingId?: string,
): SavedPreviewAnnotation {
  const store = usePreviewAnnotationStore.getState();
  store.setPageCapture(threadId, {
    pageIdentity: draft.pageIdentity,
    url: clampPreviewPageUrl(clean.capture.pageUrl),
    title: clean.capture.pageTitle ? clampPreviewPageLabel(clean.capture.pageTitle) : null,
    faviconUrl: null,
    clean,
  });
  const saved = store.saveAnnotation(threadId, draft, editingId);
  schedulePageSnapshot(threadId, draft.pageIdentity);
  return saved;
}

/** Removes one note, renumbers its page, and queues the page's marked image to be redrawn. */
export function removePreviewNote(threadId: string, noteId: string): void {
  const store = usePreviewAnnotationStore.getState();
  const removed = store.getThreadAnnotations(threadId).find((note) => note.id === noteId);
  store.deleteAnnotation(threadId, noteId);
  if (removed) schedulePageSnapshot(threadId, removed.pageIdentity);
}
