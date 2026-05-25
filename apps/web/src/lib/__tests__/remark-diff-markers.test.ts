import { describe, it, expect } from "vitest";
import type { Root, Heading, Paragraph, List, ListItem, Code, Text } from "mdast";
import { makeRemarkDiffMarkers } from "../remark-diff-markers";

/**
 * Synthesise a position object spanning a closed line range. Lets tests
 * stay focused on the marker logic rather than full markdown parsing.
 */
function pos(startLine: number, endLine: number) {
  return {
    start: { line: startLine, column: 1, offset: 0 },
    end: { line: endLine, column: 1, offset: 0 },
  };
}

/** True when a node carries the diff-added data attribute. */
function hasMarker(node: unknown): boolean {
  const data = (node as { data?: { hProperties?: Record<string, unknown> } })
    ?.data;
  return data?.hProperties?.["data-diff-added"] === "true";
}

/** Apply the plugin's transformer to a tree and return it. */
function applyPlugin(addedLines: ReadonlySet<number>, tree: Root): Root {
  // The factory returns a unified-shaped plugin () => (tree) => void.
  const transformer = makeRemarkDiffMarkers(addedLines)();
  transformer(tree);
  return tree;
}

describe("makeRemarkDiffMarkers", () => {
  it("does not mark blocks when addedLines is empty", () => {
    const heading: Heading = {
      type: "heading",
      depth: 1,
      children: [{ type: "text", value: "h" } as Text],
      position: pos(1, 1),
    };
    const tree: Root = { type: "root", children: [heading] };
    applyPlugin(new Set(), tree);
    expect(hasMarker(heading)).toBe(false);
  });

  it("marks a heading whose source line is in addedLines", () => {
    const heading: Heading = {
      type: "heading",
      depth: 1,
      children: [{ type: "text", value: "h" } as Text],
      position: pos(1, 1),
    };
    const paragraph: Paragraph = {
      type: "paragraph",
      children: [{ type: "text", value: "p" } as Text],
      position: pos(3, 3),
    };
    const tree: Root = { type: "root", children: [heading, paragraph] };
    applyPlugin(new Set([1]), tree);
    expect(hasMarker(heading)).toBe(true);
    expect(hasMarker(paragraph)).toBe(false);
  });

  it("marks a paragraph that spans multiple lines if any line is added", () => {
    const paragraph: Paragraph = {
      type: "paragraph",
      children: [{ type: "text", value: "lines" } as Text],
      position: pos(3, 5),
    };
    const tree: Root = { type: "root", children: [paragraph] };
    applyPlugin(new Set([4]), tree); // middle line
    expect(hasMarker(paragraph)).toBe(true);
  });

  it("marks list items (not the surrounding list) for fine granularity", () => {
    const items: ListItem[] = [
      {
        type: "listItem",
        spread: false,
        children: [],
        position: pos(1, 1),
      },
      {
        type: "listItem",
        spread: false,
        children: [],
        position: pos(2, 2),
      },
      {
        type: "listItem",
        spread: false,
        children: [],
        position: pos(3, 3),
      },
    ];
    const list: List = {
      type: "list",
      ordered: false,
      spread: false,
      children: items,
      position: pos(1, 3),
    };
    const tree: Root = { type: "root", children: [list] };
    applyPlugin(new Set([2]), tree);

    // Outer list is NOT tagged — we want item-level precision.
    expect(hasMarker(list)).toBe(false);
    expect(hasMarker(items[0])).toBe(false);
    expect(hasMarker(items[1])).toBe(true);
    expect(hasMarker(items[2])).toBe(false);
  });

  it("marks a code block when its source range overlaps an added line", () => {
    const code: Code = {
      type: "code",
      lang: "sh",
      value: "mcode update",
      position: pos(3, 5),
    };
    const tree: Root = { type: "root", children: [code] };
    applyPlugin(new Set([4]), tree);
    expect(hasMarker(code)).toBe(true);
  });

  it("recurses into nested children", () => {
    const innerPara: Paragraph = {
      type: "paragraph",
      children: [{ type: "text", value: "inner" } as Text],
      position: pos(5, 5),
    };
    const blockquote = {
      type: "blockquote" as const,
      children: [innerPara],
      position: pos(4, 6),
    };
    const tree: Root = { type: "root", children: [blockquote] };
    applyPlugin(new Set([5]), tree);
    // Both the outer blockquote and the inner paragraph land on the added line.
    expect(hasMarker(blockquote)).toBe(true);
    expect(hasMarker(innerPara)).toBe(true);
  });

  it("does not throw on nodes without a position field", () => {
    const heading: Heading = {
      type: "heading",
      depth: 1,
      children: [],
      // position deliberately omitted
    };
    const tree: Root = { type: "root", children: [heading] };
    expect(() => applyPlugin(new Set([1]), tree)).not.toThrow();
    expect(hasMarker(heading)).toBe(false);
  });
});
