import { vi } from "vitest";

/** Twenty distinct lines, long enough to select inside and short enough to read in a failure. */
export const LINES = Array.from(
  { length: 20 },
  (_, index) => `row ${index} ${"abcdefghij".repeat(2)}`,
);
export const TEXT = LINES.join("\n");

/** What `ShadowRoot.getSelection()` reports when the selection lies outside that root. */
const EMPTY_SELECTION = { rangeCount: 0 } as unknown as Selection;

/**
 * Chromium keeps a selection whose ends are in a shadow root; jsdom drops it (rangeCount stays 0),
 * so tests stand in a selection that holds a live Range. This base reports it as an engine without
 * composed ranges does: through `rangeCount` and `getRangeAt`, and through `within` for a shadow root.
 */
export class BrowserSelection {
  #range: Range | undefined;
  #backward = false;

  get direction() {
    return this.#range && !this.#range.collapsed ? (this.#backward ? "backward" : "forward") : "none";
  }

  get rangeCount() {
    return this.#range ? 1 : 0;
  }

  getRangeAt(index: number) {
    if (!this.#range || index !== 0) throw new DOMException("no such range", "IndexSizeError");
    return this.#range.cloneRange();
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

  /** The selection's range as a snapshot, which is what `getComposedRanges` reports. */
  snapshot() {
    const range = this.#range;
    if (!range) return undefined;
    return new StaticRange({
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
    });
  }

  /** `ShadowRoot.getSelection()`: the selection while it lies in `root`, else nothing. */
  within(root: ShadowRoot): Selection {
    const range = this.#range;
    const inside = range && root.contains(range.startContainer) && root.contains(range.endContainer);
    return inside ? (this as unknown as Selection) : EMPTY_SELECTION;
  }

  /** The text the browser would highlight and copy. */
  toString() {
    return this.#range?.toString() ?? "";
  }
}

class ComposedBrowserSelection extends BrowserSelection {
  getComposedRanges() {
    const range = this.snapshot();
    return range ? [range] : [];
  }
}

/** Which API an engine reports a selection across a shadow root with. */
export type SelectionEngine = "composed-ranges" | "shadow-root-selection";

function define(target: object, name: string, value: unknown) {
  Object.defineProperty(target, name, { value, configurable: true, writable: true });
}

/**
 * Replaces the document's selection with the double. Pair with {@link restoreBrowserSelection}.
 * `"shadow-root-selection"` is Chromium before 137: no `getComposedRanges`, but `ShadowRoot.getSelection`.
 */
export function installBrowserSelection(engine: SelectionEngine = "composed-ranges") {
  const browser =
    engine === "composed-ranges" ? new ComposedBrowserSelection() : new BrowserSelection();
  vi.spyOn(document, "getSelection").mockReturnValue(browser as unknown as Selection);
  // The code under test feature-detects these on the prototypes.
  if (engine === "composed-ranges") {
    define(Selection.prototype, "getComposedRanges", () => []);
  } else {
    define(ShadowRoot.prototype, "getSelection", function (this: ShadowRoot) {
      return browser.within(this);
    });
  }
  return browser;
}

export function restoreBrowserSelection() {
  vi.restoreAllMocks();
  Reflect.deleteProperty(Selection.prototype, "getComposedRanges");
  Reflect.deleteProperty(ShadowRoot.prototype, "getSelection");
}

function rowElement(index: number, lines: readonly string[]) {
  const row = document.createElement("div");
  row.dataset.line = String(index + 1);
  row.dataset.lineIndex = `${index},${index}`;
  row.dataset.lineType = "context";
  const line = lines[index]!;
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
  const selected = browser.snapshot();
  const rowOf = (node: Node | undefined) =>
    Number(node?.parentElement?.closest<HTMLElement>("[data-line-index]")?.dataset.lineIndex?.split(",")[0]);
  return [rowOf(selected?.startContainer), rowOf(selected?.endContainer)];
}
