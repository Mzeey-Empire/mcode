import { clampPreviewPageLabel, clampPreviewPageUrl } from "@mcode/contracts";
import {
  deleteDraftBrowserNote,
  saveDraftBrowserNote,
} from "@/features/conversation/composer/draft/draft-browser-notes";
import {
  toBrowserNoteContent,
  usePreviewAnnotationStore,
  type PreviewCleanCapture,
  type PreviewDraftAnnotation,
} from "../state/previewAnnotationStore";
import { schedulePageSnapshot } from "./previewNoteSnapshots";
import { stageDraftImage } from "./stagedDraftImages";

/**
 * Saves a note into the thread's draft with the page screenshot taken for it, then queues the
 * page's marked image to be redrawn. A fresh screenshot replaces the page's old one, so every
 * note on the page is drawn on it. Rejects, leaving the bubble open, when the note is blank or the screenshot cannot be staged.
 */
export async function savePreviewNote(
  threadId: string,
  draft: PreviewDraftAnnotation,
  clean: PreviewCleanCapture,
  editingId?: string,
): Promise<void> {
  if (!draft.note.trim()) throw new Error("annotation note is required");
  const cleanCapture = await stageDraftImage(threadId, clean.bytes, "page-capture.png");
  saveDraftBrowserNote(
    threadId,
    {
      pageIdentity: draft.pageIdentity,
      url: clampPreviewPageUrl(clean.capture.pageUrl),
      title: clean.capture.pageTitle ? clampPreviewPageLabel(clean.capture.pageTitle) : null,
      faviconUrl: null,
      capture: clean.capture,
      scroll: clean.scroll,
      cleanCapture,
    },
    toBrowserNoteContent(draft),
    editingId,
  );
  usePreviewAnnotationStore.getState().setDraft(threadId, undefined);
  schedulePageSnapshot(threadId, draft.pageIdentity);
}

/** Removes one note, renumbers its page, and queues the page's marked image to be redrawn. */
export function removePreviewNote(threadId: string, noteId: string): void {
  const removed = usePreviewAnnotationStore.getState().getThreadAnnotations(threadId)
    .find((note) => note.id === noteId);
  deleteDraftBrowserNote(threadId, noteId);
  if (removed) schedulePageSnapshot(threadId, removed.pageIdentity);
}
