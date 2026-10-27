import { describe, expect, it } from "vitest";
import type { PlanCommentAnchor } from "@mcode/contracts/models/plan";
import { reanchorPlanComment } from "./reanchor-plan-comment.js";

const anchor: PlanCommentAnchor = { kind: "text", start: 7, end: 12, quote: "words", prefix: "# Step\n", suffix: " here", section: "Step" };

describe("reanchorPlanComment", () => {
  it("preserves an unchanged range before considering duplicate matches", () => {
    expect(reanchorPlanComment(anchor, "# Step\nwords changed\n# Step\nwords here")).toEqual(anchor);
  });
  it("moves the range when text is inserted before the quote", () => {
    expect(reanchorPlanComment(anchor, "Intro\n# Step\nwords here")).toEqual({ ...anchor, start: 13, end: 18 });
  });
  it("drops edited words to their surviving section", () => {
    expect(reanchorPlanComment(anchor, "# Step\nrewritten here")).toEqual({ kind: "section", section: "Step", quote: "words" });
  });
  it("drops a missing quote and heading to the plan level", () => {
    expect(reanchorPlanComment(anchor, "# Another\nrewritten here")).toEqual({ kind: "section", section: null, quote: "words" });
  });
  it("uses surrounding context before distance to disambiguate duplicate quotes", () => {
    expect(reanchorPlanComment(anchor, "words wrong\n# Step\nwords here")).toEqual({ ...anchor, start: 19, end: 24 });
  });
  it("breaks equal-context ties by distance from the previous start", () => {
    expect(reanchorPlanComment({ ...anchor, start: 8, end: 13, prefix: "", suffix: "" }, "words....words"))
      .toEqual({ ...anchor, start: 9, end: 14, prefix: "", suffix: "" });
  });
  it("counts astral characters as two UTF-16 code units", () => {
    const emoji: PlanCommentAnchor = { kind: "text", start: 0, end: 2, quote: "😀", prefix: "", suffix: "", section: null };
    expect(reanchorPlanComment(emoji, "🧠 😀")).toEqual({ ...emoji, start: 3, end: 5 });
  });
  it("keeps section anchors even when the quote reappears and drops missing headings", () => {
    const section: PlanCommentAnchor = { kind: "section", section: "Step", quote: "words" };
    expect(reanchorPlanComment(section, "# Step\nwords here")).toEqual(section);
    expect(reanchorPlanComment(section, "words here")).toEqual({ ...section, section: null });
    expect(reanchorPlanComment(section, "```md\n# Step\n```\nwords")).toEqual({ ...section, section: null });
  });
});
