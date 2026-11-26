// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceSelection } from "../source-selection";
import {
  type BrowserSelection,
  LINES,
  OLD_LINES,
  type SelectionEngine,
  TEXT,
  endpointRows,
  highlightedText,
  installBrowserSelection,
  mountDiffHost,
  mountSplitHost,
  range,
  restoreBrowserSelection,
  select,
  showRows,
  showRowsWithSeparators,
} from "./pierre-dom";

const NO_UNKNOWN: ReadonlySet<number> = new Set();

/** The rows of one `[data-code]` column, numbered by one comma-separated part of `data-line-index`. */
const columnRows = (column: string, part: number) => ({
  rowsOf: (root: ShadowRoot) =>
    root.querySelectorAll<HTMLElement>(`[data-code][data-${column}] [data-line]`),
  lineOf: (row: HTMLElement) => Number(row.dataset.lineIndex?.split(",")[part]),
});

function offsetOf(index: number, column: number) {
  return LINES.slice(0, index).reduce((total, line) => total + line.length + 1, 0) + column;
}

const ENGINES: readonly SelectionEngine[] = ["composed-ranges", "shadow-root-selection"];

// Electron 35's Chromium (134) predates `getComposedRanges`, so the desktop app runs the second engine.
describe.each(ENGINES)("SourceSelection with %s", (engine) => {
  let browser: BrowserSelection;
  let selection: SourceSelection;
  let root: ShadowRoot;
  let content: HTMLElement;

  beforeEach(() => {
    browser = installBrowserSelection(engine);
    selection = new SourceSelection(columnRows("unified", 0));
    ({ root, content } = mountDiffHost());
  });

  afterEach(() => {
    restoreBrowserSelection();
    document.body.replaceChildren();
  });

  it("draws the selection back when the rows holding both ends return", () => {
    const from = [2, 4] as const;
    const to = [7, 3] as const;
    const held = range(0, 9);
    showRows(content, held);
    select(browser, content, from, to);
    selection.sync(root, TEXT);

    showRows(content, range(10, 19));
    expect(browser.toString()).toBe("");
    selection.render(root, TEXT);
    showRows(content, held);
    selection.render(root, TEXT);

    expect(browser.toString()).toBe(highlightedText(held, from, to));
  });

  it("draws only the part of the selection that the mounted rows hold", () => {
    showRows(content, range(0, 9));
    select(browser, content, [2, 4], [7, 3]);
    selection.sync(root, TEXT);

    const window = range(4, 13);
    showRows(content, window);
    selection.render(root, TEXT);

    expect(browser.toString()).toBe(highlightedText(window, [4, 0], [7, 3]));
  });

  it("copies the whole selection when the mounted rows hold only part of it", () => {
    showRows(content, range(0, 9));
    select(browser, content, [2, 4], [7, 3]);
    selection.sync(root, TEXT);
    showRows(content, range(4, 13));
    selection.render(root, TEXT);

    expect(selection.copy(root, TEXT, NO_UNKNOWN)).toBe(TEXT.slice(offsetOf(2, 4), offsetOf(7, 3)));
  });

  it("copies the rebuilt text while the mounted rows hold the whole selection", () => {
    showRows(content, range(0, 9));
    select(browser, content, [2, 4], [7, 3]);
    selection.sync(root, TEXT);

    expect(selection.copy(root, TEXT, NO_UNKNOWN)).toBe(TEXT.slice(offsetOf(2, 4), offsetOf(7, 3)));
  });

  it("leaves the copy to the browser when its selection is not one the class tracks", () => {
    showRows(content, range(0, 9));
    select(browser, content, [2, 4], [2, 4]);
    selection.sync(root, TEXT);

    expect(selection.copy(root, TEXT, NO_UNKNOWN)).toBeUndefined();
  });

  describe("across a gap of collapsed rows", () => {
    const from = [3, 2] as const;
    const to = [9, 5] as const;
    const gap = [2, 3, 4, 8, 9, 10];

    /** The copy with both ends mounted, then with the start's row scrolled out. */
    function copies(unknown: ReadonlySet<number>) {
      showRowsWithSeparators(content, gap);
      select(browser, content, from, to);
      selection.sync(root, TEXT);
      const bothMounted = selection.copy(root, TEXT, unknown);
      showRowsWithSeparators(content, [4, 8, 9, 10]);
      selection.render(root, TEXT);
      return [bothMounted, selection.copy(root, TEXT, unknown)];
    }

    it("copies the collapsed rows' text wherever the scroll is, and never a separator label", () => {
      const expected = TEXT.slice(offsetOf(3, 2), offsetOf(9, 5));

      const [bothMounted, startScrolledOut] = copies(NO_UNKNOWN);

      expect(bothMounted).toBe(expected);
      expect(startScrolledOut).toBe(expected);
      expect(expected).toContain(LINES[6]);
    });

    it("leaves out the rows whose text is unknown, without a blank line for them", () => {
      const expected = [
        LINES[3]!.slice(2),
        LINES[4],
        LINES[8],
        LINES[9]!.slice(0, 5),
      ].join("\n");

      const [bothMounted, startScrolledOut] = copies(new Set([5, 6, 7]));

      expect(bothMounted).toBe(expected);
      expect(startScrolledOut).toBe(expected);
      expect(expected).not.toContain("unmodified");
    });
  });

  it("keeps a selection to its own column when both columns share row indices", () => {
    const split = mountSplitHost();
    const newSide = new SourceSelection(columnRows("additions", 1));
    const show = (indices: readonly number[]) => {
      showRows(split.deletions, indices, OLD_LINES);
      showRows(split.additions, indices);
      newSide.render(split.root, TEXT);
    };
    const held = range(0, 9);
    show(held);
    select(browser, split.additions, [2, 4], [7, 3]);
    newSide.sync(split.root, TEXT);

    show(range(10, 19));
    show(held);

    expect(browser.toString()).toBe(highlightedText(held, [2, 4], [7, 3]));
  });

  it("keeps both ends on their rows across a gap of collapsed rows", () => {
    const mounted = [2, 3, 4, 8, 9, 10];
    showRows(content, mounted);
    select(browser, content, [3, 2], [9, 5]);
    selection.sync(root, TEXT);

    showRows(content, mounted);
    selection.render(root, TEXT);

    expect(browser.toString()).toBe(highlightedText(mounted, [3, 2], [9, 5]));
  });

  it("ends a selection at the previous row when its end row collapsed", () => {
    showRows(content, range(0, 9));
    select(browser, content, [2, 1], [6, 3]);
    selection.sync(root, TEXT);

    const mounted = [0, 1, 2, 3, 4, 8, 9];
    showRows(content, mounted);
    selection.render(root, TEXT);

    expect(browser.toString()).toBe(highlightedText(mounted, [2, 1], [4, LINES[4]!.length]));
    expect(endpointRows(browser)).toEqual([2, 4]);
  });

  it("starts a selection at the next row when its start row collapsed", () => {
    showRows(content, range(0, 9));
    select(browser, content, [6, 3], [9, 4]);
    selection.sync(root, TEXT);

    const mounted = [0, 1, 2, 3, 4, 8, 9];
    showRows(content, mounted);
    selection.render(root, TEXT);

    expect(browser.toString()).toBe(highlightedText(mounted, [8, 0], [9, 4]));
    expect(endpointRows(browser)).toEqual([8, 9]);
  });
});
