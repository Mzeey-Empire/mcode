import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

/** Whether the capsule lays out as one row, or as the draft on top with the controls below. */
export type CapsuleRows = "one" | "two";

/** Below this one-row draft width the capsule is too tight to type in, so it becomes two rows. */
export const MIN_DRAFT_COLUMN_PX = 120;
/** Going back to one row needs this much spare width, so a draft edited near the wrap point does not flip back and forth. */
export const ONE_ROW_RETURN_SLACK_PX = 48;

/** What the capsule measures; plain values so the decision stays a pure function. */
export interface CapsuleMeasure {
  /** Draft text width available in the one-row layout. */
  readonly oneRowColumnPx: number;
  readonly hasText: boolean;
  readonly hasLineBreak: boolean;
  /** One-row layout only: the draft overflows its single line. */
  readonly overflowsOneRow: boolean;
  /** Canvas-measured width of the draft as one line, in the draft's font. */
  readonly singleLineTextPx: number;
}

/**
 * Picks one or two rows. Order matters: a too-tight column always gives two rows (modes beside `+` can force this
 * with an empty draft), an empty draft gives one, one row grows once the draft overflows, and two rows return only
 * when the single-line text fits the one-row column with {@link ONE_ROW_RETURN_SLACK_PX} to spare.
 */
export function decideCapsuleRows(measure: CapsuleMeasure, previous: CapsuleRows): CapsuleRows {
  if (measure.oneRowColumnPx < MIN_DRAFT_COLUMN_PX) return "two";
  if (!measure.hasText) return "one";
  if (previous === "one") return measure.overflowsOneRow ? "two" : "one";
  if (measure.hasLineBreak) return "two";
  return measure.singleLineTextPx <= measure.oneRowColumnPx - ONE_ROW_RETURN_SLACK_PX ? "one" : "two";
}

/** Elements {@link useCapsuleRows} reads. */
export interface CapsuleLayoutRefs {
  readonly capsule: RefObject<HTMLElement | null>;
  readonly left: RefObject<HTMLElement | null>;
  readonly right: RefObject<HTMLElement | null>;
  /** The draft's cell: one line high and clipped in the one-row layout. */
  readonly draft: RefObject<HTMLElement | null>;
}

/** Column gaps on both sides of the draft plus its own horizontal padding, as laid out in the one-row grid. */
const ONE_ROW_DRAFT_CHROME_PX = 4 * 2 + 8 * 2;

let measureContext: CanvasRenderingContext2D | null | undefined;

function singleLineWidth(text: string, font: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  // Without a canvas the width is unknown, so the capsule keeps two rows rather than guess it fits.
  if (!measureContext) return Number.POSITIVE_INFINITY;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/** The side groups keep their widths in either layout, so the one-row column is computable from two rows too. */
function oneRowColumnWidth(capsule: HTMLElement, left: HTMLElement | null, right: HTMLElement | null): number {
  const style = getComputedStyle(capsule);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const sides = (left?.offsetWidth ?? 0) + (right?.offsetWidth ?? 0);
  return capsule.clientWidth - padding - sides - ONE_ROW_DRAFT_CHROME_PX;
}

function draftText(editable: HTMLElement): string {
  return (editable.innerText ?? editable.textContent ?? "").replace(/\n$/, "");
}

function readMeasure(refs: CapsuleLayoutRefs, rows: CapsuleRows): CapsuleMeasure | null {
  const capsule = refs.capsule.current;
  const draft = refs.draft.current;
  if (!capsule || !draft) return null;
  const oneRowColumnPx = oneRowColumnWidth(capsule, refs.left.current, refs.right.current);
  const editable = draft.querySelector<HTMLElement>("[contenteditable]") ?? draft;
  const text = draftText(editable);
  const hasText = text.trim() !== "";
  return {
    oneRowColumnPx,
    hasText,
    hasLineBreak: text.includes("\n"),
    overflowsOneRow: rows === "one" && draft.scrollHeight > draft.clientHeight + 1,
    singleLineTextPx: rows === "two" && hasText ? singleLineWidth(text, getComputedStyle(editable).font) : 0,
  };
}

/**
 * Owns the capsule's row count. Measures once per draft change (call the returned `remeasure` from the editor's
 * change handler) and once per width change of the capsule or either side group; there is no measuring loop, and
 * React bails out when the rows are unchanged, so typing within a row costs one layout pass and no re-render.
 * While `hidden`, the groups are unmounted and nothing is watched.
 */
export function useCapsuleRows(
  refs: CapsuleLayoutRefs,
  { hidden }: { readonly hidden: boolean },
): { readonly rows: CapsuleRows; readonly remeasure: () => void } {
  const [rows, setRows] = useState<CapsuleRows>("one");
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const { capsule, left, right, draft } = refs;

  const remeasure = useCallback(() => {
    const measure = readMeasure({ capsule, left, right, draft }, rowsRef.current);
    if (!measure) return;
    const next = decideCapsuleRows(measure, rowsRef.current);
    rowsRef.current = next;
    setRows(next);
  }, [capsule, draft, left, right]);

  useLayoutEffect(() => {
    if (hidden || typeof ResizeObserver === "undefined") return;
    const elements = [capsule.current, left.current, right.current].filter((element) => element !== null);
    const widths = new Map<Element, number>();
    // Height changes come from the flip itself, so only a width change re-measures. The rows render before this
    // frame paints, so a mode, label or context that widens a group never shows a frame in the old layout.
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const { target } of entries) {
        const width = target instanceof HTMLElement ? target.offsetWidth : 0;
        if (widths.get(target) === width) continue;
        widths.set(target, width);
        changed = true;
      }
      if (changed) flushSync(remeasure);
    });
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [capsule, hidden, left, remeasure, right]);

  return { rows, remeasure };
}
