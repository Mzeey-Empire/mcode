import type { PlanCommentAnchor } from "@mcode/contracts/models/plan";

/** Preserve a quote's source range or fall back to its surviving heading. */
export function reanchorPlanComment(anchor: PlanCommentAnchor, newContent: string): PlanCommentAnchor {
  if (anchor.kind === "text") {
    if (newContent.slice(anchor.start, anchor.end) === anchor.quote) return anchor;
    const start = bestOccurrence(anchor, newContent);
    if (start !== null) return { ...anchor, start, end: start + anchor.quote.length };
  }
  return { kind: "section", section: headingExists(newContent, anchor.section) ? anchor.section : null, quote: anchor.quote };
}

function bestOccurrence(anchor: Extract<PlanCommentAnchor, { kind: "text" }>, content: string): number | null {
  let best: number | null = null;
  let bestScore = -1;
  let position = content.indexOf(anchor.quote);
  while (position !== -1) {
    const score = contextScore(anchor, content, position);
    if (score > bestScore || (score === bestScore && best !== null && Math.abs(position - anchor.start) < Math.abs(best - anchor.start))) {
      best = position;
      bestScore = score;
    }
    position = content.indexOf(anchor.quote, position + 1);
  }
  return best;
}

function contextScore(anchor: Extract<PlanCommentAnchor, { kind: "text" }>, content: string, position: number): number {
  let prefix = 0;
  while (prefix < anchor.prefix.length && prefix < position
    && content[position - prefix - 1] === anchor.prefix[anchor.prefix.length - prefix - 1]) prefix++;
  let suffix = 0;
  const end = position + anchor.quote.length;
  while (suffix < anchor.suffix.length && content[end + suffix] === anchor.suffix[suffix]) suffix++;
  return prefix + suffix;
}

function headingExists(content: string, section: string | null): boolean {
  if (section === null) return false;
  const lines = outsideFences(content);
  return lines.some((line, index) => {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading === section) return true;
    return line.trim() === section && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1] ?? "");
  });
}

function outsideFences(content: string): string[] {
  let fence: string | undefined;
  return content.split(/\r?\n/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return "";
    }
    return fence ? "" : line;
  });
}
