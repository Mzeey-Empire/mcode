import { describe, expect, it } from "vitest";
import { createPlanCommentAnchor, headingBefore, headingLineEnd, resolveAnchorRange } from "./plan-comment-anchor";

const DOC = "# Plan\n\nIntro line.\n\n## Steps\n\n1. Add the table\n2. Add the index\n";

describe("createPlanCommentAnchor", () => {
  it("quotes the selection with its section and surrounding words", () => {
    const from = DOC.indexOf("Add the index");
    const anchor = createPlanCommentAnchor(DOC, from, from + "Add the index".length);

    expect(anchor).toMatchObject({
      kind: "text",
      start: from,
      end: from + 13,
      quote: "Add the index",
      section: "Steps",
      prefix: "\n\n## Steps\n\n1. Add the table\n2. ",
      suffix: "\n",
    });
  });

  it("refuses a blank selection and one the contract would reject as too long", () => {
    expect(createPlanCommentAnchor(DOC, 6, 8)).toBeNull();
    expect(createPlanCommentAnchor("x".repeat(2001), 0, 2001)).toBeNull();
  });
});

describe("headingBefore and headingLineEnd", () => {
  it("find the nearest heading above an offset, and a heading's line end", () => {
    expect(headingBefore(DOC, DOC.indexOf("Intro"))).toBe("Plan");
    expect(headingBefore(DOC, DOC.indexOf("Add the table"))).toBe("Steps");
    expect(headingBefore("no heading here", 5)).toBeNull();
    expect(headingLineEnd(DOC, "Steps")).toBe(DOC.indexOf("## Steps") + "## Steps".length);
    expect(headingLineEnd(DOC, "Missing")).toBeNull();
  });
});

describe("resolveAnchorRange", () => {
  const anchor = createPlanCommentAnchor(DOC, DOC.indexOf("Add the index"), DOC.indexOf("Add the index") + 13)!;

  it("keeps the saved range while it still quotes the same words", () => {
    expect(resolveAnchorRange(DOC, anchor)).toEqual({ from: anchor.kind === "text" ? anchor.start : -1, to: DOC.indexOf("Add the index") + 13 });
  });

  it("follows the quote when text above it moved, choosing the occurrence nearest the old start", () => {
    const moved = `Preface.\n${DOC}\nAdd the index again\n`;
    const first = moved.indexOf("Add the index");

    expect(resolveAnchorRange(moved, anchor)).toEqual({ from: first, to: first + 13 });
  });

  it("returns null once the words are gone, and for a section anchor", () => {
    expect(resolveAnchorRange(DOC.replace("Add the index", "Create an index"), anchor)).toBeNull();
    expect(resolveAnchorRange(DOC, { kind: "section", section: "Steps", quote: "" })).toBeNull();
  });
});
