import { describe, expect, it } from "vitest";
import type { ComposerAnnotationPayload, PreviewAnnotationBundle } from "@mcode/contracts";
import { composerFeedbackAccessibleLabel, composerFeedbackLabel } from "../composer-feedback";

const capture = {
  schemaVersion: 2 as const,
  pageUrl: "http://localhost:5173/",
  pageTitle: "Home",
  capturedAt: "2026-07-01T00:00:00.000Z",
  captureKind: "element" as const,
  bounds: { x: 0, y: 0, width: 10, height: 10 },
};

const preview: ComposerAnnotationPayload = {
  id: "00000000-0000-4000-8000-000000000001",
  displayNumber: 1,
  pageIdentity: "http://localhost:5173/",
  pageContext: capture,
  targetContext: { label: "button", bounds: capture.bounds },
  note: "Align",
  snapshot: {
    id: "snap-1",
    name: "preview.png",
    mimeType: "image/png",
    sizeBytes: 1,
    sourcePath: "C:/tmp/preview.png",
    capture,
  },
};

const diff: ComposerAnnotationPayload = {
  kind: "diff",
  id: "00000000-0000-4000-8000-000000000002",
  displayNumber: 2,
  filePath: "src/App.tsx",
  side: "right",
  line: 4,
  lineContent: "x",
  note: "Rename",
};

const file: ComposerAnnotationPayload = {
  kind: "file",
  id: "00000000-0000-4000-8000-000000000003",
  displayNumber: 3,
  filePath: "src/main.tsx",
  line: 7,
  lineContent: "y",
  note: "Wrap",
};

function bundle(...annotations: ComposerAnnotationPayload[]): PreviewAnnotationBundle {
  return { schemaVersion: 1, annotations };
}

describe("composerFeedbackLabel", () => {
  it("counts Files comments as comments, not annotations", () => {
    expect(composerFeedbackLabel(bundle(file))).toBe("1 comment");
    expect(composerFeedbackAccessibleLabel(bundle(file))).toBe("1 comment");
  });

  it("counts Review and Files comments together beside Preview annotations", () => {
    expect(composerFeedbackLabel(bundle(preview, diff, file))).toBe("1 annotation · 2 comments");
    expect(composerFeedbackAccessibleLabel(bundle(preview, diff, file))).toBe("1 annotation and 2 comments");
  });
});
