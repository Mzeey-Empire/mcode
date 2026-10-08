import { describe, expect, it } from "vitest";
import {
  DiffAnnotationPayloadSchema, DraftDiffCommentSchema, DraftElementFieldSchema,
  DraftElementMetaSchema, DraftImageMissingErrorSchema, DraftSubmissionSchema,
  MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS, PlanCommentSelectionSchema, StagedDraftImageSchema,
  SendMessageSchema, WS_METHODS,
} from "../../index.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const mentions = [{ kind: "file", id: "file", path: "src/main.ts", label: "main.ts", range: { start: 0, end: 8 } }];
const annotation = {
  kind: "diff", id, displayNumber: 1, filePath: "src/main.ts", side: "right",
  line: 3, lineContent: "return true;", note: "@main.ts " + "x".repeat(4991), mentions,
};

describe("next-message draft contracts", () => {
  it("accepts a 5,000-character diff note with typed mentions", () => {
    expect(DiffAnnotationPayloadSchema().parse(annotation)).toEqual(annotation);
    const spaced = { ...annotation, note: "  @main.ts explain", mentions: [{ ...mentions[0], range: { start: 2, end: 10 } }] };
    expect(DiffAnnotationPayloadSchema().parse(spaced)).toEqual(spaced);
  });

  it("rejects an oversized note and an oversized combined note and mention payload", () => {
    expect(DiffAnnotationPayloadSchema().safeParse({ ...annotation, note: "x".repeat(MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS + 1) }).success).toBe(false);
    const oversized = { ...annotation, note: "x".repeat(MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS - 10) };
    expect(DiffAnnotationPayloadSchema().safeParse(oversized).success).toBe(false);
    expect(DraftDiffCommentSchema().safeParse({ ...oversized, revision: 1 }).success).toBe(false);
  });

  it("round-trips every draft schema through JSON", () => {
    const image = { stagingId: id, name: "capture.png", mimeType: "image/png", sizeBytes: 4 };
    const meta = { id, revision: 2 };
    const selection = { planVersionId: "plan-1", includedIds: ["a"], excludedIds: ["b"], revision: 3 };
    const submission = { messageId: id, elements: [{ ...meta, field: "diffComments" }], planComments: { ridingIds: ["a"], excludedIds: ["b"] }, stagingIds: [id] };
    const draft = { ...annotation, revision: 2 };
    const missing = { code: "draft_image_missing", message: "Missing image", data: { stagingId: id } };
    expect(StagedDraftImageSchema().parse(JSON.parse(JSON.stringify(image)))).toEqual(image);
    expect(DraftElementMetaSchema().parse(JSON.parse(JSON.stringify(meta)))).toEqual(meta);
    expect(DraftElementFieldSchema().parse(JSON.parse('"diffComments"'))).toBe("diffComments");
    expect(DraftElementFieldSchema().parse(JSON.parse('"planCommentSelection"'))).toBe("planCommentSelection");
    expect(PlanCommentSelectionSchema().parse(JSON.parse(JSON.stringify(selection)))).toEqual(selection);
    expect(DraftSubmissionSchema().parse(JSON.parse(JSON.stringify(submission)))).toEqual(submission);
    expect(DraftDiffCommentSchema().parse(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    expect(DraftImageMissingErrorSchema().parse(JSON.parse(JSON.stringify(missing)))).toEqual(missing);
  });

  it("rejects invalid identities, revisions, fields and staged send IDs", () => {
    expect(DraftElementMetaSchema().safeParse({ id: "", revision: 1 }).success).toBe(false);
    expect(DraftDiffCommentSchema().safeParse({ ...annotation, revision: 0 }).success).toBe(false);
    expect(DraftDiffCommentSchema().safeParse({ ...annotation, revision: 1.5 }).success).toBe(false);
    expect(DraftElementFieldSchema().safeParse("browserNotePages").success).toBe(false);
    expect(SendMessageSchema().safeParse({ threadId: "thread", content: "", stagedDraftImageIds: ["../bad"] }).success).toBe(false);
    const send = { threadId: "thread", content: "", stagedDraftImageIds: [id] };
    expect(SendMessageSchema().parse(send)).toEqual(send);
    expect(WS_METHODS()["attachments.stageDraft"].result.parse({ stagingId: id, name: "a.png", mimeType: "image/png", sizeBytes: 4 })).toEqual({ stagingId: id, name: "a.png", mimeType: "image/png", sizeBytes: 4 });
  });
});
