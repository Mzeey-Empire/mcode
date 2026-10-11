import { describe, expect, it } from "vitest";
import { planEditorDecorations } from "./plan-editor-decorations";

describe("planEditorDecorations", () => {
  it("styles the title, summary, label, and ordered list and hides syntax marks", () => {
    const markdown = "# Title\n\nSummary **bold** and `code`.\n\n## Steps\n\n1. First\n2. Second\n";

    expect(planEditorDecorations(markdown)).toEqual([
      { kind: "line", from: 0, className: "cm-plan-title" },
      { kind: "hide", from: 0, to: 2 },
      { kind: "line", from: 9, className: "cm-plan-summary" },
      { kind: "hide", from: 17, to: 19 },
      { kind: "hide", from: 23, to: 25 },
      { kind: "hide", from: 30, to: 31 },
      { kind: "mark", from: 30, to: 36, className: "cm-plan-code" },
      { kind: "hide", from: 35, to: 36 },
      { kind: "line", from: 39, className: "cm-plan-label" },
      { kind: "hide", from: 39, to: 42 },
      { kind: "mark", from: 49, to: 51, className: "cm-plan-list-marker" },
      { kind: "hide", from: 51, to: 52 },
      { kind: "mark", from: 58, to: 60, className: "cm-plan-list-marker" },
      { kind: "hide", from: 60, to: 61 },
    ]);
  });

  it("treats only the first H1 as the title and only the next paragraph as the summary", () => {
    const markdown = "Intro\n\n# Title\n\nSummary one\nwraps here\n\nBody\n\n# Again\n";

    const lines = planEditorDecorations(markdown).filter((range) => range.kind === "line");

    expect(lines).toEqual([
      { kind: "line", from: 7, className: "cm-plan-title" },
      { kind: "line", from: 16, className: "cm-plan-summary" },
      { kind: "line", from: 28, className: "cm-plan-summary" },
    ]);
  });

  it("puts bullet markers in the marker column", () => {
    expect(planEditorDecorations("- item\n")).toEqual([
      { kind: "mark", from: 0, to: 1, className: "cm-plan-list-marker" },
      { kind: "hide", from: 1, to: 2 },
    ]);
  });

  it("leaves fenced code fences visible", () => {
    const markdown = "```ts\nconst a = 1;\n```\n";

    expect(planEditorDecorations(markdown)).toEqual([]);
  });
});
