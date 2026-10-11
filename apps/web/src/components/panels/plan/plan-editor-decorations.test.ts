import { describe, expect, it } from "vitest";
import { planEditorDecorations, visibleDecorations } from "./plan-editor-decorations";

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

  it("shows a coded file path item as its name, then its folder", () => {
    expect(planEditorDecorations("- `apps/web/src/x/File.tsx`\n")).toEqual([
      { kind: "line", from: 0, className: "cm-plan-path-item text-fade" },
      { kind: "mark", from: 0, to: 1, className: "cm-plan-list-marker" },
      { kind: "hide", from: 1, to: 2 },
      { kind: "hide", from: 2, to: 3 },
      { kind: "mark", from: 2, to: 27, className: "cm-plan-code" },
      { kind: "hide", from: 3, to: 18 },
      { kind: "mark", from: 18, to: 26, className: "cm-plan-path-name" },
      { kind: "widget", from: 26, text: "apps/web/src/x", className: "cm-plan-path-folder" },
      { kind: "hide", from: 26, to: 27 },
    ]);
  });

  it("shows a bare path item as its name, then its folder", () => {
    expect(planEditorDecorations("1. apps/x/File.tsx\n")).toEqual([
      { kind: "line", from: 0, className: "cm-plan-path-item text-fade" },
      { kind: "mark", from: 0, to: 2, className: "cm-plan-list-marker" },
      { kind: "hide", from: 2, to: 3 },
      { kind: "hide", from: 3, to: 10 },
      { kind: "mark", from: 10, to: 18, className: "cm-plan-path-name" },
      { kind: "widget", from: 18, text: "apps/x", className: "cm-plan-path-folder" },
    ]);
  });

  it("styles a coded file name with no folder as a name only", () => {
    const ranges = planEditorDecorations("- `README.md`\n");

    expect(ranges.filter((range) => range.kind !== "hide")).toEqual([
      { kind: "line", from: 0, className: "cm-plan-path-item text-fade" },
      { kind: "mark", from: 0, to: 1, className: "cm-plan-list-marker" },
      { kind: "mark", from: 2, to: 13, className: "cm-plan-code" },
      { kind: "mark", from: 3, to: 12, className: "cm-plan-path-name" },
    ]);
  });

  it("does not treat prose, code expressions, or mixed items as paths", () => {
    for (const markdown of ["- Update the store\n", "- `useStore()`\n", "- Edit `a/b.ts` first\n", "- word\n"]) {
      const classes = planEditorDecorations(markdown).flatMap((range) => ("className" in range ? [range.className] : []));
      expect(classes.filter((name) => name.startsWith("cm-plan-path"))).toEqual([]);
    }
  });
});

describe("visibleDecorations", () => {
  const markdown = "# Title\n\n1. `a/b.ts` and **bold**\n2. Next\n";
  const ranges = planEditorDecorations(markdown);

  it("keeps every decoration when no line is focused", () => {
    expect(visibleDecorations(ranges, [])).toBe(ranges);
  });

  it("shows the focused line as raw markdown while keeping type styles", () => {
    const focused = { from: 9, to: 33 };

    expect(visibleDecorations(ranges, [focused])).toEqual([
      { kind: "line", from: 0, className: "cm-plan-title" },
      { kind: "hide", from: 0, to: 2 },
      { kind: "mark", from: 12, to: 20, className: "cm-plan-code" },
      { kind: "mark", from: 34, to: 36, className: "cm-plan-list-marker" },
      { kind: "hide", from: 36, to: 37 },
    ]);
  });

  it("restores the title's preview when focus moves to it", () => {
    const visible = visibleDecorations(ranges, [{ from: 0, to: 7 }]);

    expect(visible.filter((range) => range.from < 8)).toEqual([{ kind: "line", from: 0, className: "cm-plan-title" }]);
  });
});
