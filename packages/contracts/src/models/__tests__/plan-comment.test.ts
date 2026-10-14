import { describe, expect, it } from "vitest";
import { PlanCommentCreateSchema, PlanCommentEditorDraftSchema, PlanCommentIdsSchema } from "../plan.js";

const versionId = "00000000-0000-4000-8000-000000000001";
const anchor = { kind: "text", start: 3, end: 5, quote: "😀", prefix: "# ", suffix: "", section: "Plan" };

describe("plan comment boundaries", () => {
  it("round trips an empty unsaved editor and rejects malformed stored anchors or oversized notes", () => {
    const editor = { planVersionId: versionId, commentId: null, anchor, body: "" };
    expect(PlanCommentEditorDraftSchema().parse(JSON.parse(JSON.stringify(editor)))).toEqual(editor);
    for (const invalid of [
      { ...editor, anchor: { ...anchor, end: 4 } },
      { ...editor, anchor: { ...anchor, start: -1 } },
      { ...editor, anchor: { ...anchor, prefix: "x".repeat(65) } },
      { ...editor, anchor: { ...anchor, section: "x".repeat(201) } },
      { ...editor, body: "x".repeat(4001) },
      { ...editor, planVersionId: "not-a-uuid" },
    ]) expect(PlanCommentEditorDraftSchema().safeParse(invalid).success).toBe(false);
  });

  it("normalizes saved notes, refuses empty notes, and bounds a frozen send selection", () => {
    const input = { commentId: versionId, versionId, anchor, body: "  Keep the emoji  " };
    expect(PlanCommentCreateSchema().parse(input).body).toBe("Keep the emoji");
    expect(PlanCommentCreateSchema().safeParse({ ...input, body: "   " }).success).toBe(false);
    expect(PlanCommentCreateSchema().safeParse({ ...input, body: "x".repeat(4001) }).success).toBe(false);
    expect(PlanCommentIdsSchema().safeParse(Array.from({ length: 129 }, () => versionId)).success).toBe(false);
    expect(PlanCommentIdsSchema().safeParse(["not-a-uuid"]).success).toBe(false);
  });
});
