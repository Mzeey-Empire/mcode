// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceSelection } from "../source-selection";
import {
  type BrowserSelection,
  LINES,
  type SelectionEngine,
  TEXT,
  endpointRows,
  highlightedText,
  installBrowserSelection,
  mountDiffHost,
  range,
  restoreBrowserSelection,
  select,
  showRows,
} from "./pierre-dom";

const unifiedIndexOf = (row: HTMLElement) => Number(row.dataset.lineIndex?.split(",")[0]);

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
    selection = new SourceSelection(unifiedIndexOf);
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

    expect(selection.copy(root, TEXT)).toBe(TEXT.slice(offsetOf(2, 4), offsetOf(7, 3)));
  });

  it("leaves the copy to the browser while the mounted rows hold the whole selection", () => {
    showRows(content, range(0, 9));
    select(browser, content, [2, 4], [7, 3]);
    selection.sync(root, TEXT);

    expect(selection.copy(root, TEXT)).toBeUndefined();
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
