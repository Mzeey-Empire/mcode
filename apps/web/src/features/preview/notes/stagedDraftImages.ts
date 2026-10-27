import type { PreviewAnnotationBundle } from "@mcode/contracts/models/browser-preview";
import type { StagedDraftImage } from "@mcode/contracts/models/next-message-draft";
import { getTransport } from "@/transport";

/** Staged images never change under their id, so bytes read once serve every later thumbnail and redraw. */
const bytesByStagingId = new Map<string, Promise<Uint8Array | null>>();
const MAX_CACHED_IMAGES = 12;

function remember(stagingId: string, bytes: Promise<Uint8Array | null>): void {
  bytesByStagingId.set(stagingId, bytes);
  const oldest = bytesByStagingId.keys().next().value;
  if (bytesByStagingId.size > MAX_CACHED_IMAGES && oldest !== undefined) bytesByStagingId.delete(oldest);
}

function desktopBridge() {
  const bridge = window.desktopBridge;
  if (!bridge) throw new Error("Saving Browser notes needs the desktop app");
  return bridge;
}

/**
 * Saves PNG bytes to a temp file through the desktop app, then moves them into
 * the thread's durable draft storage. The draft keeps only the returned reference.
 */
export async function stageDraftImage(threadId: string, bytes: Uint8Array, name: string): Promise<StagedDraftImage> {
  const saved = await desktopBridge().saveClipboardFile(bytes, "image/png", name);
  if (!saved) throw new Error("Could not save the page image");
  const staged = await getTransport().stageDraftImage(threadId, saved);
  remember(staged.stagingId, Promise.resolve(bytes));
  return staged;
}

/** Reads a staged image's bytes, or null when retention or thread deletion removed it. */
export function readStagedDraftImage(threadId: string, image: StagedDraftImage): Promise<Uint8Array | null> {
  const cached = bytesByStagingId.get(image.stagingId);
  if (cached) return cached;
  const read = desktopBridge().readStagedDraftImage(threadId, image.stagingId);
  remember(image.stagingId, read);
  // A missing image may be restaged later under another id; do not remember the miss.
  void read.then((bytes) => {
    if (!bytes) bytesByStagingId.delete(image.stagingId);
  }, () => bytesByStagingId.delete(image.stagingId));
  return read;
}

/**
 * Turns staged page snapshots into ordinary temp-file attachments. A Send that creates a thread
 * cannot lease images staged under another id, so it carries the bytes the way a pasted image does.
 */
export async function materializeStagedSnapshots(
  threadId: string,
  bundle: PreviewAnnotationBundle | undefined,
): Promise<PreviewAnnotationBundle | undefined> {
  if (bundle?.schemaVersion !== 2) return bundle;
  const pages = await Promise.all(bundle.pages.map(async (page) => {
    const { snapshot } = page;
    if (snapshot.sourcePath !== "") return page;
    const bytes = await readStagedDraftImage(threadId, {
      stagingId: snapshot.id,
      name: snapshot.name,
      mimeType: snapshot.mimeType,
      sizeBytes: snapshot.sizeBytes,
    });
    if (!bytes) throw new Error(`The snapshot of ${page.title ?? page.url} is gone. Add a note on it to retake it`);
    const saved = await desktopBridge().saveClipboardFile(bytes, "image/png", snapshot.name);
    if (!saved) throw new Error("Could not save the page image");
    return { ...page, snapshot: { ...snapshot, id: saved.id, sizeBytes: saved.sizeBytes, sourcePath: saved.sourcePath ?? "" } };
  }));
  return { ...bundle, pages };
}
