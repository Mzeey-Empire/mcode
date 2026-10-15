import { normalizePreviewPageIdentity } from "@mcode/shared/browser-page-identity";
import { vi } from "vitest";
import { saveBrowserNote } from "@/features/conversation/composer/draft/draft-submission";
import { setDraftBrowserPageSnapshot } from "@/features/conversation/composer/draft/draft-browser-notes";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { toBrowserNoteContent, type PreviewDraftAnnotation } from "../../state/previewAnnotationStore";

export const capture = {
  schemaVersion: 2 as const,
  pageUrl: "http://localhost:5173/products/1",
  pageTitle: "Product",
  capturedAt: "2026-07-01T00:00:00.000Z",
  captureKind: "element" as const,
  selectorHint: "button.buy",
  bounds: { x: 10, y: 20, width: 100, height: 40 },
  layoutViewport: { width: 800, height: 600 },
};

export const PRODUCT_PAGE = normalizePreviewPageIdentity(capture.pageUrl);
export const BILLING_PAGE = "http://localhost:5173/billing";

export function draft(threadId: string, overrides: Partial<PreviewDraftAnnotation> = {}): PreviewDraftAnnotation {
  return {
    threadId,
    pageIdentity: PRODUCT_PAGE,
    bounds: capture.bounds,
    selectorHint: "button.buy",
    label: "button.buy",
    pageContext: capture,
    note: "Change this",
    ...overrides,
  };
}

export function stagedImage(name = "page.png") {
  return { stagingId: crypto.randomUUID(), name, mimeType: "image/png", sizeBytes: 10 };
}

/**
 * Puts a page into the thread's composer draft with one note. The page has a
 * drawn snapshot unless `snapshot` is false, which is the state after an edit.
 */
export function seedPage(
  threadId: string,
  pageIdentity = PRODUCT_PAGE,
  title = "Product",
  { snapshot = true, note = "Change this" }: { snapshot?: boolean; note?: string } = {},
) {
  const content = toBrowserNoteContent(draft(threadId, { pageIdentity, note }));
  useComposerDraftStore.getState().updateNextMessage(threadId, (current) => saveBrowserNote(
    current,
    {
      pageIdentity,
      url: pageIdentity,
      title,
      faviconUrl: null,
      capture,
      scroll: { x: 0, y: 0 },
      cleanCapture: stagedImage("page-capture.png"),
    },
    content,
  ));
  if (snapshot) setDraftBrowserPageSnapshot(threadId, pageIdentity, stagedImage());
}

/** Makes every Date.now() read unique so notes saved in one test tick never tie on createdAt. */
export function tickClockPerRead() {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now++);
}
