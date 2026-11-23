import { describe, expect, it } from "vitest";
import {
  buildHtmlVisualDocument,
  HTML_VISUAL_DEFAULT_THEMES,
  htmlVisualFrameHeight,
  toHtmlVisualPageLocation,
} from "../html-visual-document.js";

describe("HTML visual frame document", () => {
  it("maps diagnostics to their original page positions and excludes the bootstrap", () => {
    const page = "<!doctype html><p>FIRST_MARKER</p>\n<p>Second</p>\n  <p>THIRD_MARKER</p>";
    const document = buildHtmlVisualDocument(page, HTML_VISUAL_DEFAULT_THEMES.dark);
    const locate = (marker: string) => {
      const prefix = document.slice(0, document.indexOf(marker)).split("\n");
      return toHtmlVisualPageLocation(document, page, prefix.length - 1, prefix.at(-1)!.length);
    };
    expect(locate("FIRST_MARKER")).toEqual({ line: 1, column: 19 });
    expect(locate("THIRD_MARKER")).toEqual({ line: 3, column: 6 });
    expect(locate("Content-Security-Policy")).toBeUndefined();
  });

  it.each([
    [131.1, 500, 132],
    [22, 500, 80],
    [641, 500, 500],
  ])("sizes %d pixels of content with a %d pixel maximum to %d", (content, max, expected) => {
    expect(htmlVisualFrameHeight(content, max)).toBe(expected);
  });
});
