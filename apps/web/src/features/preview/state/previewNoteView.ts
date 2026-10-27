import type { DraftBrowserNotePage, StagedDraftImage } from "@mcode/contracts/models/next-message-draft";
import type { McodeBrowserCaptureV2, PreviewAnnotationPayloadV2 } from "@mcode/contracts/models/browser-preview";
import {
  visibleBrowserNotePages,
  type NextMessageDraft,
} from "@/features/conversation/composer/draft/draft-submission";

/** Saved note with stable identity and creation ordering. Bounds are document pixels. */
export interface SavedPreviewAnnotation extends PreviewAnnotationPayloadV2 {
  /** Position in the draft's creation order; pages are ordered by when they were last annotated. */
  readonly createdAt: number;
}

/** The unmarked viewport screenshot a page's marked snapshot is redrawn from. */
export interface PreviewCleanCapture {
  /** PNG bytes of the page viewport with no markers. */
  readonly bytes: Uint8Array;
  /** Page context at the moment of capture; its bounds give the viewport size in CSS pixels. */
  readonly capture: McodeBrowserCaptureV2;
  readonly scroll: { readonly x: number; readonly y: number };
}

/** A clean screenshot after staging: the draft keeps the reference, never the bytes. */
export interface StagedCleanCapture {
  readonly image: StagedDraftImage;
  readonly capture: McodeBrowserCaptureV2;
  readonly scroll: { readonly x: number; readonly y: number };
}

/** One page of notes as the composer shows it. */
export interface PreviewPageRecord {
  readonly pageIdentity: string;
  readonly url: string;
  readonly title: string | null;
  readonly faviconUrl: string | null;
  /** Null for a page restored from a queued message, which only kept the marked image. */
  readonly clean: StagedCleanCapture | null;
  /** The marked image of the page's current notes; null until redrawn after they change. */
  readonly snapshot: StagedDraftImage | null;
}

/** What the composer and Browser panel show of the draft's current Browser notes. */
export interface BrowserNoteView {
  readonly notes: SavedPreviewAnnotation[];
  /** Page records by page identity. */
  readonly pages: Record<string, PreviewPageRecord>;
}

function pageRecord(page: DraftBrowserNotePage): PreviewPageRecord {
  return {
    pageIdentity: page.pageIdentity,
    url: page.url,
    title: page.title,
    faviconUrl: page.faviconUrl,
    clean: page.cleanCapture ? { image: page.cleanCapture, capture: page.capture, scroll: page.scroll } : null,
    snapshot: page.snapshot,
  };
}

/**
 * Projects the notes no pending Send holds into the shapes the preview UI
 * reads. The draft stays the only owner; this view is rebuilt whenever the
 * draft's pages or submissions change.
 */
export function projectBrowserNotes(draft: NextMessageDraft | undefined): BrowserNoteView {
  const notes: SavedPreviewAnnotation[] = [];
  const pages: Record<string, PreviewPageRecord> = {};
  for (const page of draft ? visibleBrowserNotePages(draft) : []) {
    pages[page.pageIdentity] = pageRecord(page);
    for (const { revision: _revision, ...note } of page.notes) {
      notes.push({ ...note, createdAt: notes.length });
    }
  }
  return { notes, pages };
}
