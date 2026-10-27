import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewAnnotationBundleSchema } from "@mcode/contracts/models/browser-preview";
import { browserPagesToBundle, readVisibleBrowserNotePages } from "@/features/conversation/composer/draft/draft-browser-notes";
import { usePreviewAnnotationStore } from "../../state/previewAnnotationStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { savePreviewNote } from "../previewNotes";
import { stageDraftImage } from "../stagedDraftImages";
import { capture, draft, PRODUCT_PAGE, stagedImage } from "./fixtures";

vi.mock("../previewNoteSnapshots", () => ({ schedulePageSnapshot: vi.fn() }));
vi.mock("../stagedDraftImages", () => ({ stageDraftImage: vi.fn() }));

const THREAD = "thread-save";

describe("savePreviewNote", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {} });
    vi.mocked(stageDraftImage).mockReset().mockImplementation(async () => stagedImage("page-capture.png"));
  });

  it("keeps a long page title and URL within the limits a bundle accepts", async () => {
    const longCapture = {
      ...capture,
      pageUrl: `http://localhost:5173/${"a".repeat(5000)}`,
      pageTitle: "t".repeat(500),
    };

    await savePreviewNote(THREAD, draft(THREAD), {
      bytes: new Uint8Array([1]),
      capture: longCapture,
      scroll: { x: 0, y: 0 },
    });

    const [page] = readVisibleBrowserNotePages(THREAD);
    const bundle = browserPagesToBundle([{ ...page!, snapshot: stagedImage() }]);
    expect(PreviewAnnotationBundleSchema().safeParse({ schemaVersion: 2, ...bundle }).success).toBe(true);
    expect(page?.pageIdentity).toBe(PRODUCT_PAGE);
  });

  it.each(["", "   "])("rejects a blank note %j and keeps its bubble open", async (note) => {
    const pending = draft(THREAD, { note });
    usePreviewAnnotationStore.getState().setDraft(THREAD, pending);

    await expect(savePreviewNote(THREAD, pending, {
      bytes: new Uint8Array([1]),
      capture,
      scroll: { x: 0, y: 0 },
    })).rejects.toThrow("note is required");

    expect(stageDraftImage).not.toHaveBeenCalled();
    expect(readVisibleBrowserNotePages(THREAD)).toEqual([]);
    expect(usePreviewAnnotationStore.getState().drafts[THREAD]).toEqual(pending);
  });

  it("saves nothing when the clean capture cannot be staged", async () => {
    vi.mocked(stageDraftImage).mockRejectedValue(new Error("disk full"));

    await expect(savePreviewNote(THREAD, draft(THREAD), {
      bytes: new Uint8Array([1]),
      capture,
      scroll: { x: 0, y: 0 },
    })).rejects.toThrow("disk full");

    expect(readVisibleBrowserNotePages(THREAD)).toEqual([]);
  });
});
