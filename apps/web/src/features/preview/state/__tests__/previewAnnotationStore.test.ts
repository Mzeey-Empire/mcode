import { beforeEach, describe, expect, it } from "vitest";
import { isPreviewAnnotationPayload } from "@mcode/contracts";
import { normalizePreviewPageIdentity } from "@mcode/shared/browser-page-identity";
import {
  usePreviewAnnotationStore,
  type PreviewDraftAnnotation,
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

function draft(overrides: Partial<PreviewDraftAnnotation> = {}): PreviewDraftAnnotation {
  return {
    threadId: "thread-1",
    pageIdentity: normalizePreviewPageIdentity(capture.pageUrl),
    bounds: capture.bounds,
    selectorHint: "button.buy",
    label: "button.buy",
    pageContext: capture,
    snapshot: {
      id: crypto.randomUUID(),
      name: "preview.png",
      mimeType: "image/png",
      sizeBytes: 10,
      sourcePath: "C:/tmp/preview.png",
      capture,
    },
    note: "Change this",
    ...overrides,
  };
}

describe("previewAnnotationStore", () => {
  beforeEach(() => {
    usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("normalizes fragments, query order, and tracking parameters", () => {
    expect(
      normalizePreviewPageIdentity("http://localhost:5173/products/1?b=2&utm_source=x&a=1#details"),
    ).toBe("http://localhost:5173/products/1?a=1&b=2");
  });

  it("renumbers display numbers without changing stable ids", () => {
    const store = usePreviewAnnotationStore.getState();
    const first = store.saveAnnotation("thread-1", draft({ note: "First" }));
    const second = usePreviewAnnotationStore.getState().saveAnnotation("thread-1", draft({ note: "Second" }));

    usePreviewAnnotationStore.getState().deleteAnnotation("thread-1", first.id);
    const remaining = usePreviewAnnotationStore.getState().getThreadAnnotations("thread-1");

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(second.id);
    expect(remaining[0]?.displayNumber).toBe(1);
  });

  it("builds a visual-only bundle with a change summary", () => {
    usePreviewAnnotationStore.getState().saveAnnotation(
      "thread-1",
      draft({ note: "", proposedChanges: { background: "#fff", fontWeight: "700" } }),
    );

    const bundle = usePreviewAnnotationStore.getState().buildBundle("thread-1");

    const annotation = bundle?.annotations[0];
    expect(annotation && isPreviewAnnotationPayload(annotation)).toBe(true);
    if (!annotation || !isPreviewAnnotationPayload(annotation)) return;
    expect(annotation.note).toBeUndefined();
    expect(annotation.changeSummary).toContain("background");
    expect(annotation.proposedChanges).toEqual({
      background: "#fff",
      fontWeight: "700",
    });
  });

  it("numbers Review comments after Browser annotations in the outbound bundle", () => {
    saveDraftDiffComment("thread-1", {
      filePath: "apps/web/src/App.tsx",
      side: "right",
      line: 42,
      lineContent: "return <App />;",
    }, { note: "Handle the loading state", mentions: [] });
    const preview = usePreviewAnnotationStore
      .getState()
      .saveAnnotation("thread-1", draft({ note: "Align the button" }));

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
    usePreviewAnnotationStore.getState().saveAnnotation("thread-1", draft({ note: "Align the button" }));

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
    const preview = usePreviewAnnotationStore.getState().saveAnnotation("thread-1", draft({ note: "Align the button" }));
    const bundle = usePreviewAnnotationStore.getState().buildBundle("thread-1")!;
    usePreviewAnnotationStore.setState({ byThread: {}, drafts: {} });

    const restored = usePreviewAnnotationStore.getState().restoreBundle("thread-1", {
      schemaVersion: 1,
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
    expect(usePreviewAnnotationStore.getState().getThreadAnnotations("thread-1").map((row) => row.id)).toEqual([preview.id]);
  });
});
