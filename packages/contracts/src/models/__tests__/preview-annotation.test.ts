import { describe, expect, it } from "vitest";
import { ComposerAnnotationPayloadSchema, FileAnnotationPayloadSchema, isPreviewAnnotationPayload, PreviewAnnotationBundleSchema, PreviewAnnotationPageSchema, PreviewAnnotationPayloadV2Schema, readPreviewAnnotationBundle, toPreviewAnnotationBundleV2, previewAnnotationPageSnapshotName, clampPreviewPageLabel, clampPreviewPageUrl } from "@mcode/contracts/models/browser-preview";
import { MAX_ATTACHMENTS } from "@mcode/contracts/models/file-types";
import { MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS } from "@mcode/contracts/models/selected-text-comment";
import { SendMessageSchema } from "@mcode/contracts/ws/methods";

const capture = {
  schemaVersion: 2 as const,
  pageUrl: "http://localhost:5173/products/1",
  pageTitle: "Product",
  capturedAt: "2026-07-01T00:00:00.000Z",
  captureKind: "element" as const,
  selectorHint: "button.buy",
  bounds: { x: 10, y: 20, width: 100, height: 40 },
  visibleTextExcerpt: "Buy now",
  layoutViewport: { width: 1200, height: 800 },
};

const annotation = {
  id: "00000000-0000-4000-8000-000000000001",
  displayNumber: 1,
  pageIdentity: "http://localhost:5173/products/1",
  pageContext: capture,
  targetContext: {
    label: "button.buy",
    selectorHint: "button.buy",
    bounds: { x: 10, y: 20, width: 100, height: 40 },
  },
  note: "Make the button clearer.",
  snapshot: {
    id: "snap-1",
    name: "preview.png",
    mimeType: "image/png" as const,
    sizeBytes: 123,
    sourcePath: "C:/tmp/preview.png",
    capture,
  },
};

const diffAnnotation = {
  kind: "diff" as const,
  id: "00000000-0000-4000-8000-000000000002",
  displayNumber: 2,
  filePath: "apps/web/src/App.tsx",
  side: "right" as const,
  line: 42,
  lineContent: "return <App />;",
  note: "Handle the loading branch here.",
};

describe("PreviewAnnotationBundleSchema", () => {
  it("accepts a bounded annotation payload", () => {
    expect(
      PreviewAnnotationBundleSchema().safeParse({
        schemaVersion: 1,
        annotations: [annotation],
      }).success,
    ).toBe(true);
  });

  it("reads a stored v1 style-only annotation without note text", () => {
    const { note: _note, ...storedAnnotation } = annotation;
    const storedBundle = {
      schemaVersion: 1,
      annotations: [{
        ...storedAnnotation,
        changeSummary: "Change background, font weight.",
        proposedChanges: { background: "#fff", fontWeight: "700" },
      }],
    };

    expect(PreviewAnnotationBundleSchema().parse(storedBundle)).toEqual(storedBundle);
  });

  it("accepts local code comments without creating screenshot attachments", () => {
    const bundle = {
      schemaVersion: 1 as const,
      annotations: [annotation, diffAnnotation],
    };

    expect(PreviewAnnotationBundleSchema().safeParse(bundle).success).toBe(true);
    expect(readPreviewAnnotationBundle(bundle).diffAnnotations).toEqual([diffAnnotation]);
    expect(readPreviewAnnotationBundle(bundle).pages.map((page) => page.snapshotIds)).toEqual([["snap-1"]]);
  });

  it("rejects annotations without note or proposed changes", () => {
    const result = PreviewAnnotationBundleSchema().safeParse({
      schemaVersion: 1,
      annotations: [{ ...annotation, note: undefined, changeSummary: undefined }],
    });
    expect(result.success).toBe(false);
  });

  it("does not count annotation snapshots against normal attachment limits", () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS }, (_, index) => ({
      id: `att-${index}`,
      name: `file-${index}.txt`,
      mimeType: "text/plain",
      sizeBytes: 1,
      sourcePath: `C:/tmp/file-${index}.txt`,
    }));

    const result = SendMessageSchema().safeParse({
      threadId: "thread-1",
      content: "fix this",
      attachments,
      previewAnnotations: { schemaVersion: 1, annotations: [annotation] },
    });

    expect(result.success).toBe(true);
  });


});

const fileAnnotation = {
  kind: "file" as const,
  id: "00000000-0000-4000-8000-000000000003",
  displayNumber: 3,
  filePath: "apps/web/src/main.tsx",
  line: 7,
  lineContent: "render(<App />);",
  note: "Wrap this in StrictMode.",
};

describe("FileAnnotationPayloadSchema", () => {
  it("accepts a file line comment", () => {
    expect(FileAnnotationPayloadSchema().safeParse(fileAnnotation).success).toBe(true);
  });

  it("rejects a blank note", () => {
    expect(FileAnnotationPayloadSchema().safeParse({ ...fileAnnotation, note: "   " }).success).toBe(false);
  });

  it("rejects a note whose mentions push it over the message budget", () => {
    const note = "x".repeat(MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS - 10);
    const mentions = [{ id: "m1", label: "main.tsx", range: { start: 0, end: 1 }, kind: "file" as const, path: "apps/web/src/main.tsx" }];
    expect(FileAnnotationPayloadSchema().safeParse({ ...fileAnnotation, note }).success).toBe(true);
    expect(FileAnnotationPayloadSchema().safeParse({ ...fileAnnotation, note, mentions }).success).toBe(false);
  });

  it("rejects a comment without a line", () => {
    const { line: _line, ...withoutLine } = fileAnnotation;
    expect(FileAnnotationPayloadSchema().safeParse(withoutLine).success).toBe(false);
  });

  it("parses through the composer union as a file comment, not a Preview annotation", () => {
    const parsed = ComposerAnnotationPayloadSchema().parse(fileAnnotation);
    expect(parsed).toEqual(fileAnnotation);
    expect(isPreviewAnnotationPayload(parsed)).toBe(false);
    expect(readPreviewAnnotationBundle({ schemaVersion: 1, annotations: [annotation, fileAnnotation] }).fileAnnotations).toEqual([fileAnnotation]);
  });
});

const page = {
  pageIdentity: annotation.pageIdentity, url: capture.pageUrl, title: "Product", faviconUrl: null,
  snapshot: { ...annotation.snapshot, scroll: { x: 0, y: 80 } },
};
const noteV2 = {
  id: annotation.id, pageIdentity: annotation.pageIdentity, displayNumber: 1,
  pageContext: capture, targetContext: annotation.targetContext, note: annotation.note,
};

describe("v2 annotation bundles", () => {
  it("clamps legacy page metadata on code point boundaries before storing v2", () => {
    const title = "a".repeat(239) + "😀tail";
    const url = "u".repeat(4095) + "😀tail";
    const upgraded = toPreviewAnnotationBundleV2({ schemaVersion: 1, annotations: [
      { ...annotation, pageContext: { ...capture, pageTitle: title, pageUrl: url } },
    ] });
    expect(upgraded.pages[0]?.title).toBe("a".repeat(239));
    expect(upgraded.pages[0]?.url).toBe("u".repeat(4095));
    expect(clampPreviewPageLabel("😀".repeat(121))).toBe("😀".repeat(120));
    expect(clampPreviewPageUrl("😀".repeat(2049))).toBe("😀".repeat(2048));
    expect(PreviewAnnotationBundleSchema().parse(upgraded)).toEqual(upgraded);
  });

  it("rejects ambiguous pages, reused snapshot IDs, orphan pages and orphan browser notes", () => {
    const otherPage = { ...page, pageIdentity: "other" };
    const otherNote = { ...noteV2, pageIdentity: "other" };
    const invalid = [
      { pages: [page, { ...page, snapshot: { ...page.snapshot, id: "second" } }], annotations: [noteV2] },
      { pages: [page, otherPage], annotations: [noteV2, otherNote] },
      { pages: [page], annotations: [diffAnnotation, fileAnnotation] },
      { pages: [], annotations: [noteV2] },
      { pages: [page], annotations: [noteV2, otherNote] },
    ];
    for (const bundle of invalid) {
      expect(PreviewAnnotationBundleSchema().safeParse({ schemaVersion: 2, ...bundle }).success).toBe(false);
    }
    expect(PreviewAnnotationBundleSchema().parse({ schemaVersion: 2, pages: [], annotations: [diffAnnotation, fileAnnotation] }))
      .toEqual({ schemaVersion: 2, pages: [], annotations: [diffAnnotation, fileAnnotation] });
  });

  it("groups legacy notes sharing an image and disambiguates that image across pages", () => {
    const upgraded = toPreviewAnnotationBundleV2({ schemaVersion: 1, annotations: [annotation,
      { ...annotation, id: fileAnnotation.id, displayNumber: 2 },
      { ...annotation, id: diffAnnotation.id, pageIdentity: "other" },
    ] });
    expect(upgraded.pages.map((entry) => [entry.pageIdentity, entry.snapshot.id])).toEqual([
      [annotation.pageIdentity, "snap-1"], ["other", "snap-1-1"],
    ]);
    expect(upgraded.annotations.map((entry) => entry.id)).toEqual([annotation.id, fileAnnotation.id, diffAnnotation.id]);
    expect(PreviewAnnotationBundleSchema().parse(upgraded)).toEqual(upgraded);
  });

  it("rejects legacy notes without a snapshot or nonblank text before upgrade", () => {
    for (const invalid of [
      { ...annotation, snapshot: undefined },
      { ...annotation, note: "  ", changeSummary: "  ", proposedChanges: { textColor: "red" } },
    ]) {
      expect(PreviewAnnotationBundleSchema().safeParse({ schemaVersion: 1, annotations: [invalid] }).success).toBe(false);
    }
    expect(() => toPreviewAnnotationBundleV2({ schemaVersion: 1, annotations: [
      { ...annotation, note: "  ", changeSummary: "  ", proposedChanges: { textColor: "red" } },
    ] })).toThrow();
  });

  it("converts each legacy note using its own capture scroll even when the final page image differs", () => {
    const upgraded = toPreviewAnnotationBundleV2({ schemaVersion: 1, annotations: [
      { ...annotation, snapshot: { ...annotation.snapshot, capture: { ...capture, viewportScroll: { scrollX: 12, scrollY: 340 } } } },
      { ...annotation, id: fileAnnotation.id, snapshot: { ...annotation.snapshot, id: "last", capture: { ...capture, viewportScroll: { scrollX: 2, scrollY: 80 } } } },
    ] });
    expect(upgraded.annotations.map((entry) => "targetContext" in entry ? entry.targetContext.bounds : null)).toEqual([
      { x: 22, y: 360, width: 100, height: 40 }, { x: 12, y: 100, width: 100, height: 40 },
    ]);
    expect(upgraded.pages[0]?.snapshot.scroll).toEqual({ x: 2, y: 80 });
  });

  it("uses the same trimmed fallback in the legacy reader and upgrade", () => {
    const legacy = { schemaVersion: 1 as const, annotations: [
      { ...annotation, note: "  ", changeSummary: "  Make it red  ", proposedChanges: { textColor: "red" } },
    ] };
    expect(readPreviewAnnotationBundle(legacy).pages[0]?.notes[0]?.note).toBe("Make it red");
    expect(toPreviewAnnotationBundleV2(legacy).annotations[0]?.note).toBe("Make it red");
  });

  it("parses pages, browser notes and both code comment kinds", () => {
    const bundle = { schemaVersion: 2, pages: [page], annotations: [noteV2, diffAnnotation, fileAnnotation] };
    expect(PreviewAnnotationBundleSchema().parse(bundle)).toEqual(bundle);
    expect(PreviewAnnotationPayloadV2Schema().parse({ ...noteV2, note: "  Keep this  " }).note).toBe("Keep this");
  });

  it("rejects missing snapshots, blank notes and extra v2 fields", () => {
    const valid = { schemaVersion: 2, pages: [page], annotations: [noteV2] };
    const malformed = [
      { ...valid, pages: [{ ...page, snapshot: undefined }] },
      { ...valid, annotations: [{ ...noteV2, note: "   " }] },
      { ...valid, annotations: [{ ...noteV2, note: undefined }] },
      { ...valid, annotations: [{ ...noteV2, changeSummary: "old" }] },
      { ...valid, annotations: [{ ...noteV2, proposedChanges: { textColor: "red" } }] },
      { ...valid, annotations: [{ ...noteV2, targetContext: { ...noteV2.targetContext, extra: true } }] },
      { ...valid, pages: [{ ...page, extra: true }] },
      { ...valid, pages: [{ ...page, snapshot: { ...page.snapshot, extra: true } }] },
      { ...valid, extra: true },
    ];
    for (const bundle of malformed) expect(PreviewAnnotationBundleSchema().safeParse(bundle).success).toBe(false);
    expect(PreviewAnnotationPageSchema().safeParse({ ...page, snapshot: null }).success).toBe(false);
  });

  it("groups legacy notes by first appearance and retains every burned-in number and snapshot id", () => {
    const secondPage = { ...annotation, id: "00000000-0000-4000-8000-000000000004",
      pageIdentity: "other", displayNumber: 7, pageContext: { ...capture, pageUrl: "https://other.test", pageTitle: "Other" },
      snapshot: { ...annotation.snapshot, id: "snap-other" } };
    const lastNote = { ...annotation, id: "00000000-0000-4000-8000-000000000005",
      displayNumber: 9, note: undefined, changeSummary: "Make it red", proposedChanges: { textColor: "red" },
      snapshot: { ...annotation.snapshot, id: "snap-last", capture: { ...capture, viewportScroll: { scrollX: 12, scrollY: 340 } } } };
    const bundle = PreviewAnnotationBundleSchema().parse({
      schemaVersion: 1, annotations: [annotation, secondPage, lastNote, diffAnnotation, fileAnnotation],
    });
    expect(readPreviewAnnotationBundle(bundle)).toEqual({
      pages: [
        { pageIdentity: annotation.pageIdentity, url: capture.pageUrl, title: "Product", faviconUrl: null,
          snapshot: { ...lastNote.snapshot, scroll: { x: 12, y: 340 } }, snapshotIds: ["snap-1", "snap-last"],
          notes: [{ id: annotation.id, displayNumber: 1, note: annotation.note,
            targetContext: annotation.targetContext, pageContext: capture },
            { id: lastNote.id, displayNumber: 9, note: "Make it red",
              targetContext: annotation.targetContext, pageContext: capture }],
        },
        { pageIdentity: "other", url: "https://other.test", title: "Other", faviconUrl: null,
          snapshot: { ...secondPage.snapshot, scroll: { x: 0, y: 0 } }, snapshotIds: ["snap-other"],
          notes: [{ id: secondPage.id, displayNumber: 7, note: annotation.note,
            targetContext: annotation.targetContext, pageContext: secondPage.pageContext }] },
      ],
      diffAnnotations: [diffAnnotation], fileAnnotations: [fileAnnotation],
    });
  });

  it("reads v2 page order, snapshot scroll and independent page numbers", () => {
    const otherPage = { ...page, pageIdentity: "other", title: "Other", snapshot: { ...page.snapshot, id: "other-shot" } };
    const otherNote = { ...noteV2, id: "00000000-0000-4000-8000-000000000006", pageIdentity: "other" };
    const view = readPreviewAnnotationBundle({
      schemaVersion: 2, pages: [page, otherPage], annotations: [otherNote, noteV2, diffAnnotation, fileAnnotation],
    });
    expect(view).toEqual({
      pages: [
        { ...page, snapshotIds: ["snap-1"], notes: [{ id: noteV2.id, displayNumber: 1, note: annotation.note,
          targetContext: annotation.targetContext, pageContext: capture }] },
        { ...otherPage, snapshotIds: ["other-shot"], notes: [{ id: otherNote.id, displayNumber: 1, note: annotation.note,
          targetContext: annotation.targetContext, pageContext: capture }] },
      ], diffAnnotations: [diffAnnotation], fileAnnotations: [fileAnnotation],
    });
  });

  it.each([undefined, "   "])("upgrades legacy writers without leaking per-note snapshots or visual proposal fields", (note) => {
    const upgraded = toPreviewAnnotationBundleV2({ schemaVersion: 1, annotations: [
      { ...annotation, note, changeSummary: "Make it red", proposedChanges: { textColor: "red" } },
      diffAnnotation, fileAnnotation,
    ] });
    expect(upgraded).toEqual({ schemaVersion: 2,
      pages: [{ ...page, snapshot: { ...annotation.snapshot, scroll: { x: 0, y: 0 } } }],
      annotations: [{ ...noteV2, note: "Make it red" }, diffAnnotation, fileAnnotation] });
    expect(PreviewAnnotationBundleSchema().parse(upgraded)).toEqual(upgraded);
  });
});

describe("page snapshot filenames", () => {
  it.each([
    ["Billing", "https://example.test", "Notes on Billing.png"],
    ["  ", "https://example.test:8080/path", "Notes on example.test_8080.png"],
    [null, "not a url", "Notes on page.png"],
    [null, "about:blank", "Notes on page.png"],
    [" . ", "https://example.test", "Notes on page.png"],
    ['A/B\\C:D*E?F"G<H>I|J', "https://example.test", "Notes on A_B_C_D_E_F_G_H_I_J.png"],
    ["CON", "https://example.test", "Notes on CON.png"],
    ["Odd\t title\n", "https://example.test", "Notes on Odd_ title.png"],
    ["x".repeat(200), "https://example.test", `Notes on ${"x".repeat(107)}.png`],
    ["x".repeat(106) + "😀tail", "https://example.test", `Notes on ${"x".repeat(106)}.png`],
    ["\u202a\u202b\u202c\u202d\u202eBilling\u2066\u2067\u2068\u2069\u200e\u200f", "https://example.test", "Notes on Billing.png"],
  ])("sanitizes %j deterministically", (title, url, expected) => {
    expect(previewAnnotationPageSnapshotName({ title, url })).toBe(expected);
  });
});
