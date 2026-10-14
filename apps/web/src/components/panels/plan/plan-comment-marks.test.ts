import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { mapPlanCommentMarks, planCommentRowOffset, type PlanCommentMark } from "./plan-comment-marks";

const DOC = "# Plan\n\n## Steps\n\n1. Add the table\n2. Add the index\n";
const START = DOC.indexOf("Add the index");
const mark: PlanCommentMark = { id: "a", range: { from: START, to: START + 13 }, section: "Steps" };

function edit(from: number, to: number, insert: string) {
  return ChangeSet.of({ from, to, insert }, DOC.length);
}

describe("mapPlanCommentMarks", () => {
  it("moves the highlight with text inserted above it", () => {
    const [mapped] = mapPlanCommentMarks([mark], edit(0, 0, "Preface\n"));

    expect(mapped.range).toEqual({ from: START + 8, to: START + 21 });
  });

  it("keeps the highlight when text is typed right after the words", () => {
    const [mapped] = mapPlanCommentMarks([mark], edit(START + 13, START + 13, "es"));

    expect(mapped.range).toEqual({ from: START, to: START + 13 });
  });

  it("drops the range, not the comment, when the highlighted words are edited", () => {
    const [mapped] = mapPlanCommentMarks([mark], edit(START + 4, START + 7, "a"));

    expect(mapped).toEqual({ id: "a", range: null, section: "Steps" });
  });
});

describe("planCommentRowOffset", () => {
  it("puts a row at the end of its highlighted line", () => {
    expect(planCommentRowOffset(DOC, mark)).toBe(DOC.length - 1);
  });

  it("falls back to the section heading, then the first line", () => {
    expect(planCommentRowOffset(DOC, { ...mark, range: null })).toBe(DOC.indexOf("## Steps") + "## Steps".length);
    expect(planCommentRowOffset(DOC, { ...mark, range: null, section: null })).toBe("# Plan".length);
  });
});
