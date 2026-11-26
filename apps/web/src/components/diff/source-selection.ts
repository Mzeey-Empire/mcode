/*
 * Adapted from T3 Code's sourceSelection.ts (apps/web/src/components/files).
 * Changed: the caller names the rows that belong to a selection (`rowsOf`) and maps each to a line
 * (`lineOf`), so a split diff's two columns can share line numbers; a point whose line has no mounted row
 * (a collapsed gap between hunks) lands on the edge of the mounted row beside it; the engine's selection
 * is also read through `ShadowRoot.getSelection`; and copy always returns the text, minus unknown lines.
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

interface Point {
  readonly node: Node;
  readonly offset: number;
}

interface Ends {
  readonly anchor: number;
  readonly focus: number;
}

interface End {
  /** False for a point between rows, which is where an unmounted row leaves one. */
  readonly inRow: boolean;
  readonly offset: number;
}

interface MountedRow {
  readonly element: HTMLElement;
  readonly line: number;
}

/** The rows the virtualizer has mounted, as offsets into the file's text. Their lines may skip. */
interface Mounted {
  readonly rows: readonly MountedRow[];
  readonly byLine: ReadonlyMap<number, MountedRow>;
  readonly start: number;
  readonly end: number;
}

/** Lines break where the renderer breaks them: at `\n`, `\r\n`, and a lone `\r`. */
function lineStarts(text: string) {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  return starts;
}

function sameRange(a: StaticRange | undefined, b: StaticRange | undefined) {
  if (!a || !b) return a === b;
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}

/** Select All spans the shadow tree, so it holds every mounted row from outside them. */
function holdsEveryRow(start: End, end: End, mounted: Mounted) {
  return !start.inRow && !end.inRow && start.offset === mounted.start && end.offset === mounted.end;
}

/**
 * Whether an end keeps the offset it had: one resting on the edge of the mounted rows keeps an offset
 * past that edge, and after a render an end between rows keeps its offset.
 */
function keepsEnd(now: End, was: number | undefined, mounted: Mounted, afterRender: boolean) {
  if (was === undefined) return false;
  if (!now.inRow) return afterRender;
  return (
    (now.offset === mounted.start && was < mounted.start) ||
    (now.offset === mounted.end && was > mounted.end)
  );
}

function samePoint(a: Point, b: Point) {
  return a.node === b.node && a.offset === b.offset;
}

/** Chromium before 137 has `ShadowRoot.getSelection` but not `getComposedRanges`. */
type ShadowRootWithSelection = ShadowRoot & { getSelection?: () => Selection | null };

function snapshotOf(selection: Selection | null | undefined) {
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  return new StaticRange({
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
  });
}

/**
 * The browser's selection as one range with its nodes inside `root` when it lies there, read through
 * `getComposedRanges`, else through `ShadowRoot.getSelection`. `undefined` when the engine has neither,
 * which leaves it to keep its own selection and copy.
 */
export function selectionRangeIn(
  root: ShadowRoot,
): { readonly range: StaticRange | undefined } | undefined {
  if (typeof Selection !== "undefined" && "getComposedRanges" in Selection.prototype) {
    return { range: document.getSelection()?.getComposedRanges({ shadowRoots: [root] })[0] };
  }
  const { getSelection } = root as ShadowRootWithSelection;
  if (typeof getSelection !== "function") return undefined;
  return { range: snapshotOf(getSelection.call(root)) };
}

function rangeIn(root: ShadowRoot) {
  return selectionRangeIn(root)?.range;
}

function isInside(root: ShadowRoot, range: StaticRange) {
  return root.contains(range.startContainer) && root.contains(range.endContainer);
}

/** The browser's selection when both its ends are inside `root`. */
export function rangeHeldBy(root: ShadowRoot) {
  const range = rangeIn(root);
  return range && isInside(root, range) ? range : undefined;
}

function isCaret(anchor: End, focus: End) {
  return anchor.offset === focus.offset && anchor.inRow && focus.inRow;
}

function isDrawn(
  selection: Selection | null,
  range: StaticRange | undefined,
  anchor: Point,
  focus: Point,
) {
  const [start, end] = selection?.direction === "backward" ? [focus, anchor] : [anchor, focus];
  return (
    range?.startContainer === start.node &&
    range.startOffset === start.offset &&
    range.endContainer === end.node &&
    range.endOffset === end.offset
  );
}

function isClipped({ anchor, focus }: Ends, mounted: Mounted) {
  return Math.min(anchor, focus) < mounted.start || Math.max(anchor, focus) > mounted.end;
}

function lastWhere<T>(items: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    if (test(items[index]!)) return items[index];
  }
  return undefined;
}

function rowOf(node: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>("[data-line]") ?? null;
}

/** Which rows of a file's shadow root a selection covers, and the line of the text each one shows. */
export interface SourceRows {
  /** The mounted rows that belong to the selection, in document order. */
  readonly rowsOf: (root: ShadowRoot) => Iterable<HTMLElement>;
  /** The zero-based line of the text that a mounted row shows, or NaN for a row that shows none. */
  readonly lineOf: (row: HTMLElement) => number;
}

/**
 * A text selection in a virtualized file, kept as offsets into the file's text.
 * The browser's own selection can only reach mounted rows: an end whose row unmounts
 * collapses onto whatever is still there, so the offsets outlive it and are drawn back
 * onto the rows after every render.
 */
export class SourceSelection {
  readonly #rowsOf: SourceRows["rowsOf"];
  readonly #lineOf: SourceRows["lineOf"];
  #text = "";
  #lineStarts: number[] | undefined;
  #ends: Ends | undefined;
  #pressed = false;
  /** A press that places a caret, where a collapsed selection is the click's and never a kept one. */
  #clicking = false;
  /**
   * The browser's selection as last left: by a render during a press when nothing was drawn over it,
   * or (`clippedByRender`) as drawn clipped to the mounted rows, which must not be read back as the ends.
   */
  #parked:
    | { readonly range: StaticRange | undefined; readonly clippedByRender: boolean }
    | undefined;

  constructor({ rowsOf, lineOf }: SourceRows) {
    this.#rowsOf = rowsOf;
    this.#lineOf = lineOf;
  }

  #use(text: string) {
    if (text === this.#text) return;
    this.#text = text;
    this.#lineStarts = undefined;
    this.#ends = undefined;
    this.#parked = undefined;
  }

  get #starts() {
    return (this.#lineStarts ??= lineStarts(this.#text));
  }

  #lineEnd(line: number) {
    const next = this.#starts[line + 1];
    if (next === undefined) return this.#text.length;
    return this.#text.startsWith("\r\n", next - 2) ? next - 2 : next - 1;
  }

  #lineAt(offset: number) {
    let low = 0;
    let high = this.#starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.#starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  #mounted(root: ShadowRoot): Mounted | undefined {
    const rows: MountedRow[] = [];
    for (const element of this.#rowsOf(root)) {
      const line = this.#lineOf(element);
      if (Number.isInteger(line)) rows.push({ element, line });
    }
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (!first || !last) return undefined;
    const start = this.#starts[first.line];
    if (start === undefined) return undefined;
    return {
      rows,
      byLine: new Map(rows.map((row) => [row.line, row])),
      start,
      end: this.#lineEnd(last.line),
    };
  }

  #offsetOf(point: Point, side: "start" | "end", mounted: Mounted): End {
    const row = rowOf(point.node);
    const range = document.createRange();
    if (row) {
      const line = this.#lineOf(row);
      range.setStart(row, 0);
      range.setEnd(point.node, point.offset);
      const start = this.#starts[line] ?? this.#text.length;
      return {
        inRow: true,
        offset: Math.min(start + range.toString().length, this.#lineEnd(line)),
      };
    }
    range.setStart(point.node, point.offset);
    const near =
      side === "start"
        ? mounted.rows.find((candidate) => range.comparePoint(candidate.element, 0) >= 0)
        : lastWhere(
            mounted.rows,
            (candidate) =>
              range.comparePoint(candidate.element, candidate.element.childNodes.length) <= 0,
          );
    const offset = near
      ? side === "start"
        ? this.#starts[near.line]!
        : this.#lineEnd(near.line)
      : side === "start"
        ? mounted.end
        : mounted.start;
    return { inRow: false, offset };
  }

  /**
   * Where the selection's `side` end sits on the mounted rows. A line the diff has collapsed has no row,
   * so a start moves to the next row's start and an end to the previous row's end.
   */
  #pointAt(offset: number, side: "start" | "end", mounted: Mounted): Point {
    const clamped = Math.max(mounted.start, Math.min(offset, mounted.end));
    const line = this.#lineAt(clamped);
    const exact = mounted.byLine.get(line);
    const row =
      exact ??
      (side === "start"
        ? mounted.rows.find((candidate) => candidate.line > line)
        : lastWhere(mounted.rows, (candidate) => candidate.line < line));
    if (!row) return { node: mounted.rows[0]!.element, offset: 0 };
    let column = exact
      ? clamped - this.#starts[line]!
      : side === "start"
        ? 0
        : this.#lineEnd(row.line) - this.#starts[row.line]!;
    const walker = document.createTreeWalker(row.element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.nodeValue?.length ?? 0;
      if (column <= length) return { node, offset: column };
      column -= length;
    }
    return { node: row.element, offset: row.element.childNodes.length };
  }

  /** Whether the browser still holds what a render drew clipped to the mounted rows, which is not the ends. */
  #holdsClippedDraw(range: StaticRange | undefined, afterRender: boolean) {
    const parked = this.#parked;
    if (!parked?.clippedByRender) return false;
    if (sameRange(range, parked.range) || (afterRender && !this.#pressed)) return true;
    this.#parked = undefined;
    return false;
  }

  /**
   * Reads the browser's selection into the offsets. An end resting on the edge of the
   * mounted rows keeps its offset when that offset lies past the edge, and a render
   * (`afterRender`) keeps every end its unmounted row left between rows.
   */
  #read(root: ShadowRoot, afterRender: boolean) {
    const read = selectionRangeIn(root);
    if (!read) {
      this.#ends = undefined;
      return undefined;
    }
    const { range } = read;
    if (this.#holdsClippedDraw(range, afterRender)) return this.#mounted(root);
    if (range && !isInside(root, range)) {
      this.#ends = undefined;
      return undefined;
    }
    const mounted = this.#mounted(root);
    if (!mounted) return undefined;
    if (!afterRender && this.#parked && sameRange(range, this.#parked.range)) return mounted;
    this.#adoptOrClear(range, mounted, afterRender);
    return mounted;
  }

  #adoptOrClear(range: StaticRange | undefined, mounted: Mounted, afterRender: boolean) {
    const selection = document.getSelection();
    if (selection && range) this.#adopt(selection, range, mounted, afterRender);
    else if (!afterRender) this.#ends = undefined;
  }

  #adopt(selection: Selection, range: StaticRange, mounted: Mounted, afterRender: boolean) {
    const start = this.#offsetOf(
      { node: range.startContainer, offset: range.startOffset },
      "start",
      mounted,
    );
    const end = this.#offsetOf(
      { node: range.endContainer, offset: range.endOffset },
      "end",
      mounted,
    );
    if (!afterRender && holdsEveryRow(start, end, mounted)) {
      this.#ends = { anchor: 0, focus: this.#text.length };
      return;
    }
    const backward = selection.direction === "backward";
    this.#follow(backward ? end : start, backward ? start : end, mounted, afterRender);
  }

  /** Moves each end to where the browser has it, except an end the mounted rows cannot reach. */
  #follow(anchor: End, focus: End, mounted: Mounted, afterRender: boolean) {
    const previous = this.#ends;
    const keepsAnchor = keepsEnd(anchor, previous?.anchor, mounted, afterRender);
    const keepsFocus = keepsEnd(focus, previous?.focus, mounted, afterRender);
    // A click collapses the selection, and it is a new one unless both ends were already there.
    if (isCaret(anchor, focus) && (this.#clicking || !(keepsAnchor && keepsFocus))) {
      this.#ends = { anchor: anchor.offset, focus: anchor.offset };
      return;
    }
    this.#ends = {
      anchor: keepsAnchor ? previous!.anchor : anchor.offset,
      focus: keepsFocus ? previous!.focus : focus.offset,
    };
  }

  /** Call when the browser's selection changes. */
  sync(root: ShadowRoot, text: string) {
    this.#use(text);
    this.#read(root, false);
  }

  #pointsOf({ anchor, focus }: Ends, mounted: Mounted) {
    // A caret has one point, so both its ends take the start side.
    return {
      anchor: this.#pointAt(anchor, anchor > focus ? "end" : "start", mounted),
      focus: this.#pointAt(focus, anchor < focus ? "end" : "start", mounted),
    };
  }

  #draw(root: ShadowRoot, mounted: Mounted | undefined) {
    this.#parked = undefined;
    const ends = this.#ends;
    if (!mounted || !ends) return;
    const { anchor, focus } = this.#pointsOf(ends, mounted);
    const selection = document.getSelection();
    const range = rangeIn(root);
    if (this.#pressed && samePoint(anchor, focus)) {
      // Chromium stops extending a drag once a script collapses its selection, so a drag whose
      // ends are both unmounted keeps what the browser has left of it.
      this.#parked = { range, clippedByRender: false };
      return;
    }
    const drawn = isDrawn(selection, range, anchor, focus);
    if (!drawn) selection?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    if (!isClipped(ends, mounted)) return;
    // A projected endpoint can become an interior point when its DOM row survives the next render.
    this.#parked = {
      range: drawn ? range : rangeIn(root),
      clippedByRender: true,
    };
  }

  /** Call after rows mount or unmount, to draw the selection onto the rows now there. */
  render(root: ShadowRoot, text: string) {
    this.#use(text);
    if (this.#ends) this.#draw(root, this.#read(root, true));
  }

  press(extending: boolean) {
    this.#pressed = true;
    this.#clicking = !extending;
    if (!extending) this.#parked = undefined;
  }

  release(root: ShadowRoot, text: string) {
    if (!this.#pressed) return;
    this.#use(text);
    const mounted = this.#read(root, false);
    this.#pressed = false;
    this.#clicking = false;
    this.#draw(root, mounted);
  }

  /**
   * The text to copy for the kept selection, else `undefined` when the browser's selection is not one this
   * tracks. It is rebuilt from the text whether or not the selection's ends are mounted, so a selection
   * copies the same wherever the scroll is; rows in `unknown` have no text to copy and leave no line.
   */
  copy(root: ShadowRoot, text: string, unknown: ReadonlySet<number>) {
    this.#use(text);
    const mounted = this.#read(root, false);
    if (!mounted || !this.#ends) return undefined;
    const start = Math.min(this.#ends.anchor, this.#ends.focus);
    const end = Math.max(this.#ends.anchor, this.#ends.focus);
    if (start === end) return undefined;
    return this.#slice(start, end, unknown);
  }

  #slice(start: number, end: number, unknown: ReadonlySet<number>) {
    const kept: string[] = [];
    for (let line = this.#lineAt(start); line <= this.#lineAt(end); line++) {
      if (unknown.has(line)) continue;
      const from = Math.max(start, this.#starts[line]!);
      kept.push(this.#text.slice(from, Math.min(end, this.#lineEnd(line))));
    }
    return kept.join("\n");
  }
}
