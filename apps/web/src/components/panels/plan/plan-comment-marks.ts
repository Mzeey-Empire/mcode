import type { ChangeDesc } from "@codemirror/state";
import { headingLineEnd } from "./plan-comment-anchor";

/** A comment as the editor places it: a highlighted range, or only a section once its words are edited away. */
export interface PlanCommentMark {
  readonly id: string;
  readonly range: { readonly from: number; readonly to: number } | null;
  readonly section: string | null;
}

/**
 * Carries marks through an edit so highlights follow the text before the
 * server re-anchors on save. An edit inside the highlighted words drops the
 * range, leaving the comment on its section.
 */
export function mapPlanCommentMarks(marks: readonly PlanCommentMark[], changes: ChangeDesc): PlanCommentMark[] {
  return marks.map((mark) => {
    if (!mark.range) return mark;
    let touched = false;
    changes.iterChangedRanges((fromA, toA) => {
      if (fromA < mark.range!.to && toA > mark.range!.from) touched = true;
    });
    if (touched) return { ...mark, range: null };
    return { ...mark, range: { from: changes.mapPos(mark.range.from, 1), to: changes.mapPos(mark.range.to, -1) } };
  });
}

/** Document offset a mark's row sits at: the end of its line, else its section heading, else the top. */
export function planCommentRowOffset(doc: string, mark: PlanCommentMark): number {
  if (mark.range) {
    const lineEnd = doc.indexOf("\n", mark.range.to);
    return lineEnd === -1 ? doc.length : lineEnd;
  }
  const heading = mark.section === null ? null : headingLineEnd(doc, mark.section);
  if (heading !== null) return heading;
  const firstLineEnd = doc.indexOf("\n");
  return firstLineEnd === -1 ? doc.length : firstLineEnd;
}
