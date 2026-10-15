import { previewAnnotationPageSnapshotName, type DraftBrowserNotePage } from "@mcode/contracts";
import { setDraftBrowserPageSnapshot } from "@/features/conversation/composer/draft/draft-browser-notes";
import { visibleBrowserNotePages } from "@/features/conversation/composer/draft/draft-submission";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { renderPageSnapshot } from "./renderPageSnapshot";
import { readStagedDraftImage, stageDraftImage } from "./stagedDraftImages";

/** How long note edits settle before a page's marked image is redrawn. */
export const PAGE_SNAPSHOT_DEBOUNCE_MS = 300;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Map<string, Promise<void>>();
const generations = new Map<string, number>();

function keyOf(threadId: string, pageIdentity: string): string {
  return `${threadId}\u0000${pageIdentity}`;
}

function visiblePages(threadId: string): DraftBrowserNotePage[] {
  const draft = useComposerDraftStore.getState().drafts[threadId];
  return draft ? visibleBrowserNotePages(draft) : [];
}

function pageLabel(page: Pick<DraftBrowserNotePage, "title" | "url">): string {
  return page.title ?? page.url;
}

function noteSignature(page: Pick<DraftBrowserNotePage, "notes"> | undefined): string {
  return (page?.notes ?? []).map((note) => `${note.id}:${note.revision}:${note.displayNumber}`).join(",");
}

async function redrawPage(threadId: string, pageIdentity: string): Promise<void> {
  const key = keyOf(threadId, pageIdentity);
  const generation = generations.get(key) ?? 0;
  const page = visiblePages(threadId).find((candidate) => candidate.pageIdentity === pageIdentity);
  if (!page || page.snapshot) return;
  if (!page.cleanCapture) throw new Error(`Add a note on ${pageLabel(page)} to refresh its snapshot`);
  const bytes = await readStagedDraftImage(threadId, page.cleanCapture);
  if (!bytes) throw new Error(`The screenshot of ${pageLabel(page)} is gone. Add a note on it to retake it`);
  const marked = await renderPageSnapshot(
    { bytes, capture: page.capture, scroll: page.scroll },
    page.notes.map((note) => ({ displayNumber: note.displayNumber, bounds: note.targetContext.bounds })),
  );
  const snapshot = await stageDraftImage(threadId, marked, previewAnnotationPageSnapshotName(page));
  if (generations.get(key) !== generation) return;
  // Clearing the tile edits notes without scheduling a redraw, so the notes drawn here may be gone.
  const current = visiblePages(threadId).find((candidate) => candidate.pageIdentity === pageIdentity);
  if (noteSignature(current) !== noteSignature(page)) return;
  setDraftBrowserPageSnapshot(threadId, pageIdentity, snapshot);
}

function startRedraw(threadId: string, pageIdentity: string): Promise<void> {
  const key = keyOf(threadId, pageIdentity);
  const running = redrawPage(threadId, pageIdentity).finally(() => {
    if (inflight.get(key) === running) inflight.delete(key);
  });
  inflight.set(key, running);
  return running;
}

/** Redraws a page's marked image after the debounce. A later call restarts the wait and voids any redraw in flight. */
export function schedulePageSnapshot(threadId: string, pageIdentity: string): void {
  const key = keyOf(threadId, pageIdentity);
  generations.set(key, (generations.get(key) ?? 0) + 1);
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    startRedraw(threadId, pageIdentity).catch(() => {});
  }, PAGE_SNAPSHOT_DEBOUNCE_MS));
}

function pendingRedraw(threadId: string, page: DraftBrowserNotePage): Promise<void> | undefined {
  const key = keyOf(threadId, page.pageIdentity);
  if (timers.has(key)) {
    clearTimeout(timers.get(key));
    timers.delete(key);
    return startRedraw(threadId, page.pageIdentity);
  }
  const running = inflight.get(key);
  if (running) return running;
  return page.snapshot ? undefined : startRedraw(threadId, page.pageIdentity);
}

/**
 * Settles every page of a thread so each has a marked image that matches its notes. Rejects
 * with the first page that cannot be redrawn, so Send never carries a stale number. A redraw
 * that an edit supersedes mid-save leaves its replacement pending, and an edit to one page can land
 * while another saves, so the whole set is rechecked until nothing is pending.
 */
export async function flushPageSnapshots(threadId: string): Promise<void> {
  for (;;) {
    const pending = visiblePages(threadId).flatMap((page) => pendingRedraw(threadId, page) ?? []);
    if (pending.length === 0) return;
    await Promise.all(pending);
  }
}

/**
 * A settled Send renumbers the notes it left behind, which voids their page's image. Redraw it
 * here so the tile does not wait for the next Send to show the right numbers.
 */
useComposerDraftStore.subscribe((state, previous) => {
  for (const [threadId, draft] of Object.entries(state.drafts)) {
    const before = previous.drafts[threadId]?.browserNotePages;
    if (draft.browserNotePages === before) continue;
    const touched = new Set(
      (draft.browserNotePages ?? []).filter((page) => !before?.includes(page)).map((page) => page.pageIdentity),
    );
    for (const page of visiblePages(threadId)) {
      if (touched.has(page.pageIdentity) && !page.snapshot && page.cleanCapture) {
        schedulePageSnapshot(threadId, page.pageIdentity);
      }
    }
  }
});
