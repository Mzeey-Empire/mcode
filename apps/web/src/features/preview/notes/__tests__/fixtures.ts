import { normalizePreviewPageIdentity } from "@mcode/shared/browser-page-identity";
import { vi } from "vitest";
import {
  usePreviewAnnotationStore,
  type PreviewDraftAnnotation,
} from "../../state/previewAnnotationStore";

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

export function seedPage(threadId: string, pageIdentity = PRODUCT_PAGE, title = "Product") {
  const store = usePreviewAnnotationStore.getState();
  store.setPageCapture(threadId, {
    pageIdentity,
    url: pageIdentity,
    title,
    faviconUrl: null,
    clean: { bytes: new Uint8Array([1]), capture, scroll: { x: 0, y: 0 } },
  });
  store.setPageSnapshot(threadId, pageIdentity, {
    id: crypto.randomUUID(),
    name: "page.png",
    mimeType: "image/png",
    sizeBytes: 10,
    sourcePath: "C:/tmp/page.png",
    capture,
    scroll: { x: 0, y: 0 },
  }, new Uint8Array([2]));
}

/** Makes every Date.now() read unique so notes saved in one test tick never tie on createdAt. */
export function tickClockPerRead() {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now++);
}
