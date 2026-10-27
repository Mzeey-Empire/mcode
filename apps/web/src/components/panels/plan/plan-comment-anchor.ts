import type { PlanCommentAnchor } from "@mcode/contracts/models/plan";

/** The contract rejects a quote longer than this, so a longer selection cannot be commented. */
export const PLAN_COMMENT_MAX_QUOTE_CHARS = 2000;

/** Characters of context kept on each side of a quote so the server can find it again. */
const CONTEXT_CHARS = 32;

const HEADING_LINE = /^#{1,6}\s+(.*?)\s*#*\s*$/;

/** Text of the nearest heading at or before a document offset, or null above the first heading. */
export function headingBefore(doc: string, offset: number): string | null {
  const lines = doc.slice(0, offset).split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = HEADING_LINE.exec(lines[i]!);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * The anchor for a selected range, in the UTF-16 offsets CodeMirror and the
 * server both use. Null when the selection is empty, blank or too long to quote.
 */
export function createPlanCommentAnchor(doc: string, from: number, to: number): PlanCommentAnchor | null {
  const quote = doc.slice(from, to);
  if (quote.trim() === "" || quote.length > PLAN_COMMENT_MAX_QUOTE_CHARS) return null;
  return {
    kind: "text",
    start: from,
    end: to,
    quote,
    prefix: doc.slice(Math.max(0, from - CONTEXT_CHARS), from),
    suffix: doc.slice(to, to + CONTEXT_CHARS),
    section: headingBefore(doc, from),
  };
}

/** Document offset of the end of the line holding the named heading, or null when no heading matches. */
export function headingLineEnd(doc: string, section: string): number | null {
  let offset = 0;
  for (const line of doc.split("\n")) {
    const end = offset + line.length;
    if (HEADING_LINE.exec(line)?.[1] === section) return end;
    offset = end + 1;
  }
  return null;
}

/**
 * Where an anchor's quote sits in the shown text. The saved range wins while it
 * still quotes the same words; otherwise the occurrence nearest the old start.
 * Null when the words are gone, so the comment falls back to its section.
 */
export function resolveAnchorRange(doc: string, anchor: PlanCommentAnchor): { from: number; to: number } | null {
  if (anchor.kind !== "text") return null;
  if (doc.slice(anchor.start, anchor.end) === anchor.quote) return { from: anchor.start, to: anchor.end };
  let best: number | null = null;
  for (let at = doc.indexOf(anchor.quote); at !== -1; at = doc.indexOf(anchor.quote, at + 1)) {
    if (best === null || Math.abs(at - anchor.start) < Math.abs(best - anchor.start)) best = at;
  }
  return best === null ? null : { from: best, to: best + anchor.quote.length };
}
