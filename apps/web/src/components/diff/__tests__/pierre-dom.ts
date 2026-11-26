import { vi } from "vitest";

/** Twenty distinct lines, long enough to select inside and short enough to read in a failure. */
export const LINES = Array.from(
  { length: 20 },
  (_, index) => `row ${index} ${"abcdefghij".repeat(2)}`,
);
export const TEXT = LINES.join("\n");

/**
 * Chromium keeps a selection whose ends are in a shadow root; jsdom drops it (rangeCount stays 0),
 * so tests stand in a selection that holds a live Range and reports snapshots as `getComposedRanges` does.
 */
export class BrowserSelection {
  #range: Range | undefined;
  #backward = false;

  get direction() {
    return this.#range && !this.#range.collapsed ? (this.#backward ? "backward" : "forward") : "none";
  }

  setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
    const anchor = document.createRange();
    anchor.setStart(anchorNode, anchorOffset);
    this.#backward = anchor.comparePoint(focusNode, focusOffset) < 0;
    const range = document.createRange();
    if (this.#backward) {
      range.setStart(focusNode, focusOffset);
      range.setEnd(anchorNode, anchorOffset);
    } else {
      range.setStart(anchorNode, anchorOffset);
      range.setEnd(focusNode, focusOffset);
    }
    this.#range = range;
  }

  getComposedRanges() {
    const range = this.#range;
    if (!range) return [];
    return [
      new StaticRange({
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset,
      }),
    ];
  }

  /** The text the browser would highlight and copy. */
  toString() {
    return this.#range?.toString() ?? "";
  }
}

/** Replaces the document's selection with the double. Pair with {@link restoreBrowserSelection}. */
export function installBrowserSelection() {
  const browser = new BrowserSelection();
  // The double implements only the members the selection code reads.
  vi.spyOn(document, "getSelection").mockReturnValue(browser as unknown as Selection);
  // jsdom has no composed ranges, and the code under test feature-detects them on the prototype.
  Object.defineProperty(Selection.prototype, "getComposedRanges", {
    value: () => [],
    configurable: true,
    writable: true,
  });
  return browser;
}

export function restoreBrowserSelection() {
  vi.restoreAllMocks();
  Reflect.deleteProperty(Selection.prototype, "getComposedRanges");
}

function rowElement(index: number, lines: readonly string[]) {
  const row = document.createElement("div");
  row.dataset.line = String(index + 1);
  row.dataset.lineIndex = `${index},${index}`;
  row.dataset.lineType = "context";
  const line = lines[index]!;
  // Pierre wraps tokens in spans, so a row holds several text nodes.
  for (const part of [line.slice(0, 10), line.slice(10)]) {
    const token = document.createElement("span");
    token.textContent = part;
    row.append(token);
  }
  return row;
}

/** A diff host with an open shadow root and Pierre's `[data-content]` column. */
export function mountDiffHost() {
  const host = document.createElement("diffs-container");
  document.body.append(host);
  // Pierre's element builds its own shadow root once the package is loaded; a bare tag needs one.
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const content = document.createElement("div");
  content.dataset.content = "";
  root.append(content);
  return { host, root, content };
}

/** Pierre rewrites the whole code column when the virtualizer moves its window. */
export function showRows(content: HTMLElement, indices: readonly number[], lines: readonly string[] = LINES) {
  content.replaceChildren(...indices.map((index) => rowElement(index, lines)));
}

export function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/** The text node and offset at `column` of the mounted row for unified row `index`. */
export function pointIn(content: HTMLElement, index: number, column: number): [Node, number] {
  const row = content.querySelector(`[data-line-index^="${index},"]`);
  if (!row) throw new Error(`row ${index} is not mounted`);
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let remaining = column;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (remaining <= length) return [node, remaining];
    remaining -= length;
  }
  throw new Error(`column ${column} is past the end of row ${index}`);
}

/** Selects from one row's column to another's, as a drag does. */
export function select(
  browser: BrowserSelection,
  content: HTMLElement,
  from: readonly [row: number, column: number],
  to: readonly [row: number, column: number],
) {
  const [anchorNode, anchorOffset] = pointIn(content, ...from);
  const [focusNode, focusOffset] = pointIn(content, ...to);
  browser.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
}

/**
 * What the browser highlights between two points of mounted rows: their text with no newlines, since
 * rows are blocks. Rows that are not mounted in between contribute nothing.
 */
export function highlightedText(
  mounted: readonly number[],
  from: readonly [row: number, column: number],
  to: readonly [row: number, column: number],
) {
  return mounted
    .filter((index) => index >= from[0] && index <= to[0])
    .map((index) => LINES[index]!.slice(index === from[0] ? from[1] : 0, index === to[0] ? to[1] : undefined))
    .join("");
}

/** The unified rows that the selection's two ends sit in. */
export function endpointRows(browser: BrowserSelection) {
  const [selected] = browser.getComposedRanges();
  const rowOf = (node: Node | undefined) =>
    Number(node?.parentElement?.closest<HTMLElement>("[data-line-index]")?.dataset.lineIndex?.split(",")[0]);
  return [rowOf(selected?.startContainer), rowOf(selected?.endContainer)];
}
