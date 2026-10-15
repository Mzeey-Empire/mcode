import { beforeEach, describe, expect, it } from "vitest";
import { normalizePreviewPageIdentity } from "@mcode/shared/browser-page-identity";
import {
  usePreviewAnnotationStore,
  type PreviewDraftAnnotation,
  type PreviewPageRecord,
} from "../previewAnnotationStore";
import { buildComposerAnnotationBundle } from "@/features/conversation/composer/submission/composer-annotations";
import { saveDraftDiffComment } from "@/features/conversation/composer/draft/draft-diff-comments";
import { saveDraftFileComment } from "@/features/conversation/composer/draft/draft-file-comments";
import { useComposerDraftStore } from "@/stores/composerDraftStore";

const capture = {
  schemaVersion: 2 as const,
  pageUrl: "http://localhost:5173/products/1?utm_source=x&b=2&a=1#top",
  pageTitle: "Product",
  capturedAt: "2026-07-01T00:00:00.000Z",
  captureKind: "element" as const,
  selectorHint: "button.buy",
  bounds: { x: 10, y: 20, width: 100, height: 40 },
};

const PAGE = normalizePreviewPageIdentity(capture.pageUrl);
const OTHER_PAGE = "http://localhost:5173/billing";

function draft(overrides: Partial<PreviewDraftAnnotation> = {}): PreviewDraftAnnotation {
  return {
    threadId: "thread-1",
    pageIdentity: PAGE,
    bounds: capture.bounds,
    selectorHint: "button.buy",
    label: "button.buy",
    pageContext: capture,
    note: "Change this",
    ...overrides,
  };
}

function markedSnapshot() {
  return {
    id: crypto.randomUUID(),
    name: "page.png",
    mimeType: "image/png" as const,
    sizeBytes: 10,
    sourcePath: "C:/tmp/page.png",
    capture,
    scroll: { x: 0, y: 0 },
  };
}

function seedPage(pageIdentity = PAGE, marked = true) {
  const store = usePreviewAnnotationStore.getState();
  store.setPageCapture("thread-1", {
    pageIdentity,
    url: pageIdentity,
    title: "Product",
    faviconUrl: null,
    clean: { bytes: new Uint8Array([1]), capture, scroll: { x: 0, y: 0 } },
  });
  if (marked) store.setPageSnapshot("thread-1", pageIdentity, markedSnapshot(), new Uint8Array([2]));
}

const store = () => usePreviewAnnotationStore.getState();

describe("previewAnnotationStore", () => {
  beforeEach(() => {
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
    useComposerDraftStore.setState({ drafts: {} });
    seedPage();
  });

  it("normalizes fragments, query order, and tracking parameters", () => {
    expect(
      normalizePreviewPageIdentity("http://localhost:5173/products/1?b=2&utm_source=x&a=1#details"),
    ).toBe("http://localhost:5173/products/1?a=1&b=2");
  });

  it("renumbers display numbers without changing stable ids", () => {
    const first = store().saveAnnotation("thread-1", draft({ note: "First" }));
    const second = store().saveAnnotation("thread-1", draft({ note: "Second" }));

    store().deleteAnnotation("thread-1", first.id);
    const remaining = store().getThreadAnnotations("thread-1");

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(second.id);
    expect(remaining[0]?.displayNumber).toBe(1);
  });

  it("numbers each page from 1 and leaves other pages alone when a note is removed", () => {
    seedPage(OTHER_PAGE);
    const a1 = store().saveAnnotation("thread-1", draft({ note: "A1" }));
    store().saveAnnotation("thread-1", draft({ note: "A2" }));
    const b1 = store().saveAnnotation("thread-1", draft({ pageIdentity: OTHER_PAGE, note: "B1" }));

    store().deleteAnnotation("thread-1", a1.id);

    expect(store().getPageAnnotations("thread-1", PAGE).map((n) => [n.note, n.displayNumber])).toEqual([["A2", 1]]);
    expect(store().getPageAnnotations("thread-1", OTHER_PAGE).map((n) => [n.id, n.displayNumber])).toEqual([[b1.id, 1]]);
  });

  it("stales a page's marked image when one of its notes is removed, and no other page's", () => {
    seedPage(OTHER_PAGE);
    const a1 = store().saveAnnotation("thread-1", draft({ note: "A1" }));
    store().saveAnnotation("thread-1", draft({ note: "A2" }));
    store().saveAnnotation("thread-1", draft({ pageIdentity: OTHER_PAGE, note: "B1" }));

    store().deleteAnnotation("thread-1", a1.id);

    const pages = store().pages["thread-1"]!;
    expect(pages[PAGE]?.marked).toBeNull();
    expect(pages[OTHER_PAGE]?.marked).not.toBeNull();
  });

  it("drops a page record when its last note is removed", () => {
    const note = store().saveAnnotation("thread-1", draft());
    store().deleteAnnotation("thread-1", note.id);

    expect(store().pages["thread-1"]).toEqual({});
  });

  it("refuses to save a note on a page that was never captured", () => {
    expect(() => store().saveAnnotation("thread-1", draft({ pageIdentity: OTHER_PAGE }))).toThrow(
      "page capture is required",
    );
  });

  it("stores note bounds in document pixels", () => {
    const note = store().saveAnnotation("thread-1", draft({
      pageContext: { ...capture, viewportScroll: { scrollX: 0, scrollY: 300 } },
    }));

    expect(note.targetContext.bounds).toEqual({ x: 10, y: 320, width: 100, height: 40 });
  });

  it("keeps Review comments when Browser notes are cleared", () => {
    saveDraftDiffComment("thread-1", {
      filePath: "apps/web/src/App.tsx",
      side: "right",
      line: 42,
      lineContent: "return <App />;",
    }, { note: "Handle the loading state", mentions: [] });
    store().saveAnnotation("thread-1", draft());

    store().clearPreviewNotes("thread-1");

    expect(store().getThreadAnnotations("thread-1")).toEqual([]);
    expect(buildComposerAnnotationBundle("thread-1")?.annotations).toEqual([
      expect.objectContaining({ kind: "diff", note: "Handle the loading state" }),
    ]);
  });

  it("trims the note text it stores", () => {
    const note = store().saveAnnotation("thread-1", draft({ note: "  Make the button clearer.  " }));

    expect(note.note).toBe("Make the button clearer.");
  });

  it("leaves out notes whose page has no redrawn image yet", () => {
    seedPage(OTHER_PAGE, false);
    store().saveAnnotation("thread-1", draft({ note: "Ready" }));
    store().saveAnnotation("thread-1", draft({ pageIdentity: OTHER_PAGE, note: "Stale" }));

    const bundle = store().buildBundle("thread-1");

    expect(bundle?.pages.map((page) => page.pageIdentity)).toEqual([PAGE]);
    expect(bundle?.annotations.map((annotation) => "note" in annotation && annotation.note)).toEqual(["Ready"]);
  });

  it("round-trips a bundle through restore with the same pages and numbering", () => {
    seedPage(OTHER_PAGE);
    store().saveAnnotation("thread-1", draft({ note: "A1" }));
    store().saveAnnotation("thread-1", draft({ pageIdentity: OTHER_PAGE, note: "B1" }));
    const bundle = store().buildBundle("thread-1")!;
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });

    expect(store().restoreBundle("thread-1", bundle)).toBe(true);

    const restored: Record<string, PreviewPageRecord> = store().pages["thread-1"]!;
    expect(Object.keys(restored).sort()).toEqual([OTHER_PAGE, PAGE].sort());
    expect(restored[PAGE]?.clean).toBeNull();
    expect(restored[PAGE]?.marked?.id).toBe(bundle.pages.find((p) => p.pageIdentity === PAGE)?.snapshot.id);
    expect(store().getThreadAnnotations("thread-1").map((n) => [n.note, n.displayNumber])).toEqual([
      ["A1", 1],
      ["B1", 1],
    ]);
  });

  it.each(["", "   "])("rejects a blank note %j without discarding its draft", (note) => {
    const pending = draft({ note });
    usePreviewAnnotationStore.getState().setDraft("thread-1", pending);

    expect(() => usePreviewAnnotationStore.getState().saveAnnotation("thread-1", pending)).toThrow();
    expect(usePreviewAnnotationStore.getState().buildBundle("thread-1")).toBeUndefined();
    expect(usePreviewAnnotationStore.getState().drafts["thread-1"]).toEqual(pending);
  });

  it("preserves a saved note when an edit tries to clear its text", () => {
    const saved = usePreviewAnnotationStore.getState().saveAnnotation("thread-1", draft());

    expect(() => usePreviewAnnotationStore.getState().saveAnnotation(
      "thread-1",
      draft({ note: "   " }),
      saved.id,
    )).toThrow();
    expect(usePreviewAnnotationStore.getState().getThreadAnnotations("thread-1")).toEqual([saved]);
  });

  it("numbers Review comments after Browser annotations in the outbound bundle", () => {
    saveDraftDiffComment("thread-1", {
      filePath: "apps/web/src/App.tsx",
      side: "right",
      line: 42,
      lineContent: "return <App />;",
    }, { note: "Handle the loading state", mentions: [] });
    const preview = store().saveAnnotation("thread-1", draft({ note: "Align the button" }));

    const bundle = buildComposerAnnotationBundle("thread-1");

    expect(preview.displayNumber).toBe(1);
    expect(bundle?.annotations).toEqual([
      expect.objectContaining({ id: preview.id, displayNumber: 1 }),
      {
        kind: "diff",
        id: expect.any(String),
        displayNumber: 2,
        filePath: "apps/web/src/App.tsx",
        side: "right",
        line: 42,
        lineContent: "return <App />;",
        note: "Handle the loading state",
        mentions: [],
      },
    ]);
  });

  it("numbers Files comments after Browser annotations and Review comments", () => {
    saveDraftFileComment("thread-1", {
      filePath: "apps/web/src/main.tsx",
      line: 7,
      lineContent: "render(<App />);",
    }, { note: "Wrap in StrictMode", mentions: [] });
    saveDraftDiffComment("thread-1", {
      filePath: "apps/web/src/App.tsx",
      side: "right",
      line: 42,
      lineContent: "return <App />;",
    }, { note: "Handle the loading state", mentions: [] });
    store().saveAnnotation("thread-1", draft({ note: "Align the button" }));

    const bundle = buildComposerAnnotationBundle("thread-1");

    expect(bundle?.annotations.map((annotation) => annotation.displayNumber)).toEqual([1, 2, 3]);
    expect(bundle?.annotations[2]).toEqual({
      kind: "file",
      id: expect.any(String),
      displayNumber: 3,
      filePath: "apps/web/src/main.tsx",
      line: 7,
      lineContent: "render(<App />);",
      note: "Wrap in StrictMode",
      mentions: [],
    });
  });

  it("does not restore Files comments as Browser annotations", () => {
    const preview = store().saveAnnotation("thread-1", draft({ note: "Align the button" }));
    const bundle = store().buildBundle("thread-1")!;
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });

    const restored = store().restoreBundle("thread-1", {
      ...bundle,
      annotations: [...bundle.annotations, {
        kind: "file",
        id: "00000000-0000-4000-8000-000000000003",
        displayNumber: 2,
        filePath: "apps/web/src/main.tsx",
        line: 7,
        lineContent: "render(<App />);",
        note: "Wrap in StrictMode",
      }],
    });

    expect(restored).toBe(true);
    expect(store().getThreadAnnotations("thread-1").map((row) => row.id)).toEqual([preview.id]);
  });
});
