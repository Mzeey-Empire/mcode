/**
 * Text selection in the virtualized Files code view.
 *
 * The view mounts only rows near the viewport. When the row holding one end of
 * a selection unmounts, the browser moves that end to the nearest mounted row,
 * so the highlight shrinks and never comes back. Keeping the rows that hold the
 * selection's two ends mounted preserves it; rows between them can still be
 * unmounted, so copy rebuilds the text from the file's lines instead of the DOM.
 */

/** Set on every rendered row: its index in the virtualizer's row list. */
const ROW_INDEX_ATTRIBUTE = "data-index";
/** Set on the element holding one code line's text, without its gutter. */
const LINE_TEXT_ATTRIBUTE = "data-line-text";

/** A selection end inside a code line: zero-based line index and character offset. */
export interface LinePoint {
  readonly line: number;
  readonly offset: number;
}

/** Adds the pinned row indexes to the virtualizer's range, keeping ascending order. */
export function withPinnedRows(indexes: readonly number[], pinned: readonly number[], count: number): number[] {
  const extra = pinned.filter((index) => index >= 0 && index < count && !indexes.includes(index));
  if (extra.length === 0) return [...indexes];
  return [...indexes, ...extra].sort((a, b) => a - b);
}

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** Row indexes holding the ends of the current selection, when it lies inside `viewport`. */
export function selectionRowIndexes(selection: Selection | null, viewport: HTMLElement): number[] {
  if (!selection || selection.isCollapsed) return [];
  const indexes: number[] = [];
  for (const node of [selection.anchorNode, selection.focusNode]) {
    if (!node || !viewport.contains(node)) continue;
    const row = elementOf(node)?.closest(`[${ROW_INDEX_ATTRIBUTE}]`);
    const index = Number(row?.getAttribute(ROW_INDEX_ATTRIBUTE));
    if (row && Number.isInteger(index)) indexes.push(index);
  }
  return indexes;
}

/** Characters of `text` before a DOM point; a point in the gutter counts as 0, one in the end padding as the whole line. */
function offsetWithin(text: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(text);
  const position = range.comparePoint(node, offset);
  if (position < 0) return 0;
  if (position > 0) return text.textContent?.length ?? 0;
  range.setEnd(node, offset);
  return range.toString().length;
}

function linePoint(node: Node, offset: number): LinePoint | null {
  const row = elementOf(node)?.closest("[data-line]");
  const text = row?.querySelector<HTMLElement>(`[${LINE_TEXT_ATTRIBUTE}]`);
  if (!row || !text) return null;
  return { line: Number(row.getAttribute("data-line")) - 1, offset: offsetWithin(text, node, offset) };
}

/** The file text between two selection ends, including lines whose rows are not mounted. */
export function textBetween(lines: readonly string[], start: LinePoint, end: LinePoint): string {
  if (start.line === end.line) return (lines[start.line] ?? "").slice(start.offset, end.offset);
  return [
    (lines[start.line] ?? "").slice(start.offset),
    ...lines.slice(start.line + 1, end.line),
    (lines[end.line] ?? "").slice(0, end.offset),
  ].join("\n");
}

/**
 * The text a copy of `selection` should put on the clipboard, or null when an
 * end lies outside a code line (a comment card, say) and the browser's own copy
 * should run.
 */
export function selectedCodeText(selection: Selection | null, viewport: HTMLElement, lines: readonly string[]): string | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!viewport.contains(range.startContainer) || !viewport.contains(range.endContainer)) return null;
  const start = linePoint(range.startContainer, range.startOffset);
  const end = linePoint(range.endContainer, range.endOffset);
  if (!start || !end) return null;
  return textBetween(lines, start, end);
}
