import {
  PreviewAnnotationBundleSchema,
  readPreviewAnnotationBundle,
  toPreviewAnnotationBundleV2,
  type DraftBrowserNote,
  type DraftBrowserNotePage,
  type DraftElementMeta,
  type PreviewAnnotationBundle,
  type PreviewAnnotationPayloadV2,
  type StagedDraftImage,
} from "@mcode/contracts";
import { useComposerDraftStore, type ComposerDraft } from "@/stores/composerDraftStore";
import {
  removeBrowserNote,
  removeTakenBrowserNotes,
  saveBrowserNote,
  setBrowserPageSnapshot,
  visibleBrowserNotePages,
  type BrowserNoteContent,
  type BrowserPageCapture,
} from "./draft-submission";

const STAGING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function updateThread(threadId: string, update: (draft: ComposerDraft) => ComposerDraft): void {
  useComposerDraftStore.getState().updateNextMessage(threadId, update);
}

/** Browser pages a thread's next Send would carry, hiding notes a pending Send holds. */
export function readVisibleBrowserNotePages(threadId: string): DraftBrowserNotePage[] {
  const draft = useComposerDraftStore.getState().drafts[threadId];
  return draft ? visibleBrowserNotePages(draft) : [];
}

/** The notes of these pages with the draft's revision, which a settled Send compares. */
export function browserNoteElements(pages: readonly DraftBrowserNotePage[]): DraftElementMeta[] {
  return pages.flatMap((page) => page.notes.map(({ id, revision }) => ({ id, revision })));
}

function toPayload({ revision: _revision, ...note }: DraftBrowserNote): PreviewAnnotationPayloadV2 {
  return note;
}

/**
 * Turns draft pages into the wire bundle's pages and notes. A staged snapshot
 * travels as `id: stagingId` with an empty `sourcePath`; the server resolves it
 * from draft storage. Pages without a drawn snapshot are left out.
 */
export function browserPagesToBundle(pages: readonly DraftBrowserNotePage[]) {
  const drawn = pages.filter((page) => page.snapshot);
  return {
    pages: drawn.map((page) => ({
      pageIdentity: page.pageIdentity,
      url: page.url,
      title: page.title,
      faviconUrl: page.faviconUrl,
      snapshot: {
        id: page.snapshot!.stagingId,
        name: page.snapshot!.name,
        mimeType: "image/png" as const,
        sizeBytes: page.snapshot!.sizeBytes,
        sourcePath: "",
        capture: page.capture,
        scroll: page.scroll,
      },
    })),
    annotations: drawn.flatMap((page) => page.notes.map(toPayload)),
  };
}

/** Saves a note into its page, replacing the page's clean capture, and marks the page for redraw. */
export function saveDraftBrowserNote(
  threadId: string,
  page: BrowserPageCapture,
  content: BrowserNoteContent,
  noteId?: string,
): void {
  updateThread(threadId, (draft) => saveBrowserNote(draft, page, content, noteId));
}

/** Drops the draft's reference to one Browser note. A page left without notes goes with it. */
export function deleteDraftBrowserNote(threadId: string, noteId: string): void {
  updateThread(threadId, (draft) => removeBrowserNote(draft, noteId));
}

/** Records a page's redrawn snapshot. */
export function setDraftBrowserPageSnapshot(
  threadId: string,
  pageIdentity: string,
  snapshot: StagedDraftImage,
): void {
  updateThread(threadId, (draft) => setBrowserPageSnapshot(draft, pageIdentity, snapshot));
}

/** Drops every visible Browser note of a thread. Notes a pending Send holds stay with it. */
export function clearVisibleBrowserNotes(threadId: string): void {
  updateThread(threadId, (draft) => removeTakenBrowserNotes(
    draft,
    browserNoteElements(visibleBrowserNotePages(draft)),
  ));
}

/**
 * Removes notes a queued or sent message took with it, unless they were
 * edited since; a later revision is a new note the message does not own.
 */
export function removeTakenBrowserNotePages(threadId: string, taken: readonly DraftElementMeta[]): void {
  if (taken.length === 0) return;
  updateThread(threadId, (draft) => removeTakenBrowserNotes(draft, taken));
}

function pageFromBundle(
  view: ReturnType<typeof readPreviewAnnotationBundle>["pages"][number],
): DraftBrowserNotePage {
  const snapshot = view.snapshot;
  const staged = snapshot && STAGING_ID.test(snapshot.id)
    ? { stagingId: snapshot.id, name: snapshot.name, mimeType: snapshot.mimeType, sizeBytes: snapshot.sizeBytes }
    : null;
  return {
    pageIdentity: view.pageIdentity,
    url: view.url,
    title: view.title,
    faviconUrl: view.faviconUrl,
    capture: snapshot?.capture ?? view.notes[0]!.pageContext,
    scroll: snapshot?.scroll ?? { x: 0, y: 0 },
    // A queued message kept only the marked image, so this page cannot redraw until retaken.
    cleanCapture: null,
    snapshot: staged,
    notes: view.notes.map((note, index) => ({
      ...note,
      pageIdentity: view.pageIdentity,
      displayNumber: index + 1,
      revision: 1,
    })),
  };
}

/**
 * Puts the Browser notes of a queued message back into the draft, replacing
 * the visible ones. Returns false when the bundle is not a valid annotation bundle.
 */
export function restoreQueuedBrowserNotes(threadId: string, bundle: PreviewAnnotationBundle | undefined): boolean {
  clearVisibleBrowserNotes(threadId);
  if (!bundle) return true;
  const parsed = PreviewAnnotationBundleSchema().safeParse(bundle);
  if (!parsed.success) return false;
  // v1 bounds are viewport coordinates; the draft holds document coordinates.
  const pages = readPreviewAnnotationBundle(toPreviewAnnotationBundleV2(parsed.data)).pages
    .filter((page) => page.notes.length > 0)
    .map(pageFromBundle);
  if (pages.length === 0) return true;
  updateThread(threadId, (draft) => ({
    ...draft,
    browserNotePages: [...(draft.browserNotePages ?? []), ...pages],
  }));
  return true;
}
