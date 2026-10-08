import { describe, it, expect } from "vitest";
import { extractCursorCreatePlanMarkdown } from "../cursor-create-plan.js";

describe("extractCursorCreatePlanMarkdown", () => {
  it("reads the S07-00 captured top-level plan field", () => {
    expect(extractCursorCreatePlanMarkdown({ plan: "# Plan\n\nBody", markdown: "Wrong field" })).toBe("# Plan\n\nBody");
  });

  it.each([{}, { plan: "" }, { plan: "  " }, { plan: 42 }, { markdown: "# Wrong field" }, { plan: { markdown: "# Wrong shape" } }])("rejects missing or invalid native plan text: %j", (params) => {
    expect(extractCursorCreatePlanMarkdown(params)).toBeNull();
  });
});
