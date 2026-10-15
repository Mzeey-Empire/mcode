import { beforeEach, describe, expect, it } from "vitest";
import { normalizePreviewPageIdentity } from "@mcode/shared/browser-page-identity";
import {
  toBrowserNoteContent,
  usePreviewAnnotationStore,
  type PreviewDraftAnnotation,
} from "../previewAnnotationStore";
import { buildComposerAnnotationBundle } from "@/features/conversation/composer/submission/composer-annotations";
import {
  browserPagesToBundle,
  clearVisibleBrowserNotes,
  deleteDraftBrowserNote,
  readVisibleBrowserNotePages,
  restoreQueuedBrowserNotes,
} from "@/features/conversation/composer/draft/draft-browser-notes";
import { saveDraftDiffComment } from "@/features/conversation/composer/draft/draft-diff-comments";
import { saveDraftFileComment } from "@/features/conversation/composer/draft/draft-file-comments";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { seedPage } from "../../notes/__tests__/fixtures";

const capture = {
  schemaVersion: 2 as const,
  pageUrl: "http://localhost:5173/products/1?utm_source=x&b=2&a=1#top",
  pageTitle: "Product",
  capturedAt: "2026-07-01T00:00:00.000Z",
  captureKind: "element" as const,
  selectorHint: "button.buy",
  bounds: { x: 10, y: 20, width: 100, height: 40 },
};

const THREAD = "thread-1";
const PAGE = normalizePreviewPageIdentity(capture.pageUrl);
const OTHER_PAGE = "http://localhost:5173/billing";

const store = () => usePreviewAnnotationStore.getState();
const notesOf = (pageIdentity: string) => store().getPageAnnotations(THREAD, pageIdentity);

function sentBundle() {
  const bundle = buildComposerAnnotationBundle(THREAD);
  if (bundle?.schemaVersion !== 2) throw new Error("expected a v2 bundle");
  return bundle;
}

function annotation(overrides: Partial<PreviewDraftAnnotation> = {}): PreviewDraftAnnotation {
  return {
    threadId: THREAD,
    pageIdentity: PAGE,
    bounds: capture.bounds,
    selectorHint: "button.buy",
    label: "button.buy",
    pageContext: capture,
    note: "Change this",
    ...overrides,
  };
}

describe("previewAnnotationStore", () => {
  beforeEach(() => {
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("normalizes fragments, query order, and tracking parameters", () => {
    expect(
      normalizePreviewPageIdentity("http://localhost:5173/products/1?b=2&utm_source=x&a=1#details"),
    ).toBe("http://localhost:5173/products/1?a=1&b=2");
  });

  it("follows the composer draft: notes appear when saved and vanish when the draft loses them", () => {
    seedPage(THREAD, PAGE, "Product", { note: "First" });

    expect(store().getThreadAnnotations(THREAD).map((note) => note.note)).toEqual(["First"]);
    expect(store().pages[THREAD]?.[PAGE]?.snapshot).not.toBeNull();

    useComposerDraftStore.setState({ drafts: {} });
    useComposerDraftStore.getState().updateNextMessage(THREAD, (draft) => draft);

    expect(store().getThreadAnnotations(THREAD)).toEqual([]);
    expect(store().pages[THREAD]).toBeUndefined();
  });

  it("renumbers display numbers without changing stable ids", () => {
    seedPage(THREAD, PAGE, "Product", { note: "First" });
    seedPage(THREAD, PAGE, "Product", { note: "Second" });
    const [first, second] = notesOf(PAGE);

    deleteDraftBrowserNote(THREAD, first!.id);

    const remaining = notesOf(PAGE);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(second!.id);
    expect(remaining[0]?.displayNumber).toBe(1);
  });

  it("numbers each page from 1 and leaves other pages alone when a note is removed", () => {
    seedPage(THREAD, PAGE, "Product", { note: "A1" });
    seedPage(THREAD, PAGE, "Product", { note: "A2" });
    seedPage(THREAD, OTHER_PAGE, "Billing", { note: "B1" });
    const [a1] = notesOf(PAGE);
    const [b1] = notesOf(OTHER_PAGE);

    deleteDraftBrowserNote(THREAD, a1!.id);

    expect(notesOf(PAGE).map((note) => [note.note, note.displayNumber])).toEqual([["A2", 1]]);
    expect(notesOf(OTHER_PAGE).map((note) => [note.id, note.displayNumber])).toEqual([[b1!.id, 1]]);
  });

  it("voids a page's snapshot when one of its notes is removed, and no other page's", () => {
    seedPage(THREAD, PAGE, "Product", { note: "A1" });
    seedPage(THREAD, PAGE, "Product", { note: "A2" });
    seedPage(THREAD, OTHER_PAGE, "Billing", { note: "B1" });
    seedPage(THREAD, PAGE, "Product", { note: "A3", snapshot: true });
    const [a1] = notesOf(PAGE);

    deleteDraftBrowserNote(THREAD, a1!.id);

    const pages = store().pages[THREAD]!;
    expect(pages[PAGE]?.snapshot).toBeNull();
    expect(pages[OTHER_PAGE]?.snapshot).not.toBeNull();
  });

  it("drops a page record when its last note is removed", () => {
    seedPage(THREAD, PAGE);
    deleteDraftBrowserNote(THREAD, notesOf(PAGE)[0]!.id);

    expect(store().pages[THREAD]).toBeUndefined();
    expect(readVisibleBrowserNotePages(THREAD)).toEqual([]);
  });

  it("stores note bounds in document pixels", () => {
    const content = toBrowserNoteContent(annotation({
      pageContext: { ...capture, viewportScroll: { scrollX: 0, scrollY: 300 } },
    }));

    expect(content.targetContext.bounds).toEqual({ x: 10, y: 320, width: 100, height: 40 });
  });

  it("trims the note text it stores", () => {
    expect(toBrowserNoteContent(annotation({ note: "  Make the button clearer.  " })).note)
      .toBe("Make the button clearer.");
  });

  it("keeps Review comments when Browser notes are cleared", () => {
    saveDraftDiffComment(THREAD, {
      filePath: "apps/web/src/App.tsx",
      side: "right",
      line: 42,
      lineContent: "return <App />;",
    }, { note: "Handle the loading state", mentions: [] });
    seedPage(THREAD, PAGE);

    clearVisibleBrowserNotes(THREAD);

    expect(store().getThreadAnnotations(THREAD)).toEqual([]);
    expect(buildComposerAnnotationBundle(THREAD)?.annotations).toEqual([
      expect.objectContaining({ kind: "diff", note: "Handle the loading state" }),
    ]);
  });

  it("leaves out notes whose page has no redrawn image yet", () => {
    seedPage(THREAD, PAGE, "Product", { note: "Ready" });
    seedPage(THREAD, OTHER_PAGE, "Billing", { note: "Stale", snapshot: false });

    const bundle = browserPagesToBundle(readVisibleBrowserNotePages(THREAD));

    expect(bundle.pages.map((page) => page.pageIdentity)).toEqual([PAGE]);
    expect(bundle.annotations.map((note) => note.note)).toEqual(["Ready"]);
  });

  it("round-trips a bundle through restore with the same pages and numbering", () => {
    seedPage(THREAD, PAGE, "Product", { note: "A1" });
    seedPage(THREAD, OTHER_PAGE, "Billing", { note: "B1" });
    const bundle = sentBundle();
    useComposerDraftStore.setState({ drafts: {} });

    expect(restoreQueuedBrowserNotes(THREAD, bundle)).toBe(true);

    const restored = store().pages[THREAD]!;
    expect(Object.keys(restored).sort()).toEqual([OTHER_PAGE, PAGE].sort());
    expect(restored[PAGE]?.clean).toBeNull();
    expect(restored[PAGE]?.snapshot?.stagingId).toBe(bundle.pages.find((p) => p.pageIdentity === PAGE)?.snapshot.id);
    expect(store().getThreadAnnotations(THREAD).map((n) => [n.note, n.displayNumber])).toEqual([
      ["A1", 1],
      ["B1", 1],
    ]);
  });

  it("restores a snapshot with a legacy non-uuid id as a page without a snapshot", () => {
    seedPage(THREAD, PAGE, "Product", { note: "A1" });
    const bundle = sentBundle();
    useComposerDraftStore.setState({ drafts: {} });
    const [page] = bundle.pages;

    restoreQueuedBrowserNotes(THREAD, {
      ...bundle,
      pages: [{ ...page!, snapshot: { ...page!.snapshot, id: "snap-legacy", sourcePath: "C:/tmp/legacy.png" } }],
    });

    expect(store().pages[THREAD]?.[PAGE]?.snapshot).toBeNull();
    expect(store().getThreadAnnotations(THREAD)).toHaveLength(1);
  });

  it("reports a malformed queued bundle as not restored and leaves the draft empty", () => {
    seedPage(THREAD, PAGE, "Product", { note: "A1" });
    const bundle = sentBundle();
    useComposerDraftStore.setState({ drafts: {} });

    const restored = restoreQueuedBrowserNotes(THREAD, { ...bundle, schemaVersion: 3 } as never);

    expect(restored).toBe(false);
    expect(store().getThreadAnnotations(THREAD)).toEqual([]);
  });

  it("numbers Review comments after Browser annotations in the outbound bundle", () => {
    saveDraftDiffComment(THREAD, {
      filePath: "apps/web/src/App.tsx",
      side: "right",
      line: 42,
      lineContent: "return <App />;",
    }, { note: "Handle the loading state", mentions: [] });
    seedPage(THREAD, PAGE, "Product", { note: "Align the button" });

    const bundle = buildComposerAnnotationBundle(THREAD);

    expect(bundle?.annotations).toEqual([
      expect.objectContaining({ id: notesOf(PAGE)[0]!.id, displayNumber: 1 }),
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
    saveDraftFileComment(THREAD, {
      filePath: "apps/web/src/main.tsx",
      line: 7,
      lineContent: "render(<App />);",
    }, { note: "Wrap in StrictMode", mentions: [] });
    saveDraftDiffComment(THREAD, {
      filePath: "apps/web/src/App.tsx",
      side: "right",
      line: 42,
      lineContent: "return <App />;",
    }, { note: "Handle the loading state", mentions: [] });
    seedPage(THREAD, PAGE, "Product", { note: "Align the button" });

    const bundle = buildComposerAnnotationBundle(THREAD);

    expect(bundle?.annotations.map((row) => row.displayNumber)).toEqual([1, 2, 3]);
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
    seedPage(THREAD, PAGE, "Product", { note: "Align the button" });
    const bundle = sentBundle();
    const preview = notesOf(PAGE)[0]!;
    useComposerDraftStore.setState({ drafts: {} });

    const restored = restoreQueuedBrowserNotes(THREAD, {
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
    expect(store().getThreadAnnotations(THREAD).map((row) => row.id)).toEqual([preview.id]);
  });

  it("restores a scrolled v1 note at document coordinates, keeping its sent number", () => {
    const scrolledCapture = { ...capture, viewportScroll: { scrollX: 15, scrollY: 300 } };

    restoreQueuedBrowserNotes(THREAD, {
      schemaVersion: 1,
      annotations: [{
        id: "00000000-0000-4000-8000-000000000009",
        displayNumber: 4,
        pageIdentity: PAGE,
        pageContext: scrolledCapture,
        targetContext: { label: "button.buy", selectorHint: "button.buy", bounds: capture.bounds },
        note: "Legacy note",
        snapshot: {
          id: "snap-legacy",
          name: "legacy.png",
          mimeType: "image/png",
          sizeBytes: 10,
          sourcePath: "C:/tmp/legacy.png",
          capture: scrolledCapture,
        },
      }],
    });

    const [restored] = store().getThreadAnnotations(THREAD);
    expect(restored?.targetContext.bounds).toEqual({ x: 25, y: 320, width: 100, height: 40 });
    expect(store().pages[THREAD]?.[PAGE]?.snapshot).toBeNull();
  });
});
