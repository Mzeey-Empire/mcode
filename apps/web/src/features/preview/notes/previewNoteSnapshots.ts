import { previewAnnotationPageSnapshotName } from "@mcode/contracts";
import { usePreviewAnnotationStore } from "../state/previewAnnotationStore";
import { renderPageSnapshot } from "./renderPageSnapshot";

/** How long note edits settle before a page's marked image is redrawn. */
export const PAGE_SNAPSHOT_DEBOUNCE_MS = 300;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Map<string, Promise<void>>();
const generations = new Map<string, number>();

function keyOf(threadId: string, pageIdentity: string): string {
  return `${threadId}\u0000${pageIdentity}`;
}

async function saveMarkedPng(bytes: Uint8Array, name: string) {
  const bridge = window.desktopBridge;
  if (!bridge) throw new Error("Saving page snapshots needs the desktop app");
  const meta = await bridge.saveClipboardFile(bytes, "image/png", name);
  if (!meta) throw new Error("Could not save the page snapshot");
  return meta;
}

async function redrawPage(threadId: string, pageIdentity: string): Promise<void> {
  const key = keyOf(threadId, pageIdentity);
  const generation = generations.get(key) ?? 0;
  const store = usePreviewAnnotationStore.getState();
  const page = store.pages[threadId]?.[pageIdentity];
  const notes = store.getPageAnnotations(threadId, pageIdentity);
  if (!page || notes.length === 0) return;
  if (!page.clean) throw new Error(`Add a note on ${page.title ?? page.url} to refresh its snapshot`);
  const bytes = await renderPageSnapshot(
    page.clean,
    notes.map((note) => ({ displayNumber: note.displayNumber, bounds: note.targetContext.bounds })),
  );
  const meta = await saveMarkedPng(bytes, previewAnnotationPageSnapshotName(page));
  if (generations.get(key) !== generation) return;
  usePreviewAnnotationStore.getState().setPageSnapshot(threadId, pageIdentity, {
    id: meta.id,
    name: meta.name,
    mimeType: "image/png",
    sizeBytes: meta.sizeBytes,
    sourcePath: meta.sourcePath ?? "",
    capture: page.clean.capture,
    scroll: page.clean.scroll,
  }, bytes);
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

/**
 * Settles every page of a thread so each has a marked image that matches its notes. Rejects
 * with the first page that cannot be redrawn, so Send never carries a stale number.
 */
export async function flushPageSnapshots(threadId: string): Promise<void> {
  const pages = Object.values(usePreviewAnnotationStore.getState().pages[threadId] ?? {});
  await Promise.all(pages.map(async ({ pageIdentity }) => {
    const key = keyOf(threadId, pageIdentity);
    if (timers.has(key)) {
      clearTimeout(timers.get(key));
      timers.delete(key);
      await startRedraw(threadId, pageIdentity);
      return;
    }
    const running = inflight.get(key);
    if (running) await running.catch(() => {});
    const page = usePreviewAnnotationStore.getState().pages[threadId]?.[pageIdentity];
    if (page && !page.marked) await startRedraw(threadId, pageIdentity);
  }));
}
