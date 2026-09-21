import type { ReviewFileChange } from "@mcode/contracts";

/** Human label for a file change classification. */
export const CHANGE_TYPE_LABELS: Record<ReviewFileChange["changeType"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
};

/** Single-letter glyph shown beside a changed file path. */
export const CHANGE_TYPE_GLYPHS: Record<ReviewFileChange["changeType"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

/** Text color for a change glyph, reusing the shared diff tokens. */
export function changeTypeTone(changeType: ReviewFileChange["changeType"]): string {
  if (changeType === "added") return "text-[var(--diff-add-strong)]";
  if (changeType === "deleted") return "text-[var(--diff-remove-strong)]";
  return "text-muted-foreground/70";
}


