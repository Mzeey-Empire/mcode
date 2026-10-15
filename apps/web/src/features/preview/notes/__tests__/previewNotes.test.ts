import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewAnnotationBundleSchema } from "@mcode/contracts";
import { usePreviewAnnotationStore } from "../../state/previewAnnotationStore";
import { savePreviewNote } from "../previewNotes";
import { capture, draft, PRODUCT_PAGE } from "./fixtures";

vi.mock("../previewNoteSnapshots", () => ({ schedulePageSnapshot: vi.fn() }));

const THREAD = "thread-save";

describe("savePreviewNote", () => {
  beforeEach(() => {
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
  });

  it("keeps a long page title and URL within the limits a bundle accepts", () => {
    const longCapture = {
      ...capture,
      pageUrl: `http://localhost:5173/${"a".repeat(5000)}`,
      pageTitle: "t".repeat(500),
    };

    savePreviewNote(THREAD, draft(THREAD), {
      bytes: new Uint8Array([1]),
      capture: longCapture,
      scroll: { x: 0, y: 0 },
    });
    usePreviewAnnotationStore.getState().setPageSnapshot(THREAD, PRODUCT_PAGE, {
      id: "snapshot-1",
      name: "page.png",
      mimeType: "image/png",
      sizeBytes: 1,
      sourcePath: "C:/tmp/page.png",
      capture: longCapture,
      scroll: { x: 0, y: 0 },
    }, new Uint8Array([2]));

    const bundle = usePreviewAnnotationStore.getState().buildBundle(THREAD);
    expect(PreviewAnnotationBundleSchema().safeParse(bundle).success).toBe(true);
  });
});
