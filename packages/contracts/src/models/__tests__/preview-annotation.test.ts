import { describe, expect, it } from "vitest";
import {
  ComposerAnnotationPayloadSchema,
  FileAnnotationPayloadSchema,
  MAX_ATTACHMENTS,
  MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS,
  isPreviewAnnotationPayload,
  PreviewAnnotationBundleSchema,
  SendMessageSchema,
  previewAnnotationSnapshotAttachmentMeta,
  previewAnnotationSnapshotAttachments,
  previewAnnotationSnapshotStoredAttachment,
} from "../../index.js";

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
    expect(previewAnnotationSnapshotAttachments(bundle)).toHaveLength(1);
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

  it("derives image attachment metadata from the annotation snapshot", () => {
    expect(previewAnnotationSnapshotAttachmentMeta(annotation)).toEqual({
      id: "snap-1",
      name: "Annotation 1 screenshot.png",
      mimeType: "image/png",
      sizeBytes: 123,
      sourcePath: "C:/tmp/preview.png",
    });
    expect(previewAnnotationSnapshotStoredAttachment(annotation)).toEqual({
      id: "snap-1",
      name: "Annotation 1 screenshot.png",
      mimeType: "image/png",
      sizeBytes: 123,
    });
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
    expect(previewAnnotationSnapshotAttachments({ schemaVersion: 1, annotations: [annotation, fileAnnotation] })).toHaveLength(1);
  });
});
