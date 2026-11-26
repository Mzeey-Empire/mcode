import type { FileDiffMetadata } from "@pierre/diffs";

/** One column of a diff as text, one line per row joined with `\n`. */
export interface DiffText {
  readonly text: string;
  /** Rows whose text the diff does not carry. Their lines in `text` are empty. */
  readonly unknown: ReadonlySet<number>;
}

/** A code column Pierre renders: the one column of a unified diff, or one side of a split diff. */
export type DiffColumn = "unified" | "deletions" | "additions";

type Hunk = FileDiffMetadata["hunks"][number];
type Block = Hunk["hunkContent"][number];

/** Pierre keeps each line's own ending; a row's text does not include it. */
function withoutLineEnding(line: string): string {
  return line.replace(/\r?\n$/, "");
}

/** Rows start unknown and become known when a line is put there. */
function rowBuffer(count: number) {
  const rows = Array.from<string | undefined>({ length: count });
  return {
    put(index: number, line: string | undefined) {
      if (line !== undefined && index >= 0 && index < count) rows[index] = withoutLineEnding(line);
    },
    finish(): DiffText {
      const unknown = new Set<number>();
      rows.forEach((row, index) => {
        if (row === undefined) unknown.add(index);
      });
      return { text: rows.map((row) => row ?? "").join("\n"), unknown };
    },
  };
}

type Rows = ReturnType<typeof rowBuffer>;

/** Context and collapsed rows show the new file's lines, except on the old side of a split diff. */
function linesOf(diff: FileDiffMetadata, column: DiffColumn) {
  return column === "deletions" ? diff.deletionLines : diff.additionLines;
}

function putLines(rows: Rows, lines: readonly string[], first: number, count: number, at: number) {
  for (let offset = 0; offset < count; offset++) rows.put(at + offset, lines[first + offset]);
}

/** Returns the row after the block. A split side leaves buffer rows where the other side has more. */
function putChange(
  rows: Rows,
  diff: FileDiffMetadata,
  block: Extract<Block, { type: "change" }>,
  column: DiffColumn,
  row: number,
): number {
  const { deletions, additions } = block;
  const putDeletions = (at: number) =>
    putLines(rows, diff.deletionLines, block.deletionLineIndex, deletions, at);
  const putAdditions = (at: number) =>
    putLines(rows, diff.additionLines, block.additionLineIndex, additions, at);
  if (column === "unified") {
    putDeletions(row);
    putAdditions(row + deletions);
    return row + deletions + additions;
  }
  if (column === "deletions") putDeletions(row);
  else putAdditions(row);
  return row + Math.max(deletions, additions);
}

function putHunk(rows: Rows, diff: FileDiffMetadata, hunk: Hunk, column: DiffColumn, start: number) {
  let row = start;
  for (const block of hunk.hunkContent) {
    if (block.type === "change") {
      row = putChange(rows, diff, block, column, row);
      continue;
    }
    const first = column === "deletions" ? block.deletionLineIndex : block.additionLineIndex;
    putLines(rows, linesOf(diff, column), first, block.lines, row);
    row += block.lines;
  }
}

/** Where the lines after a hunk begin in the file's line array. */
function lineIndexAfter(hunk: Hunk, column: DiffColumn) {
  const [start, count] =
    column === "deletions"
      ? [hunk.deletionStart, hunk.deletionCount]
      : [hunk.additionStart, hunk.additionCount];
  // A hunk with no lines on this side is positioned after the line its header names, not on it.
  return start - (count === 0 ? 0 : 1) + count;
}

function columnText(diff: FileDiffMetadata, column: DiffColumn): DiffText {
  const split = column !== "unified";
  const total = split ? diff.splitLineCount : diff.unifiedLineCount;
  const rows = rowBuffer(total);
  const lines = linesOf(diff, column);
  let nextLineIndex = 0;
  let cursor = 0;
  const fillCollapsed = (until: number) => {
    if (!diff.isPartial) putLines(rows, lines, nextLineIndex, until - cursor, cursor);
  };

  for (const hunk of diff.hunks) {
    const start = split ? hunk.splitLineStart : hunk.unifiedLineStart;
    fillCollapsed(start);
    putHunk(rows, diff, hunk, column, start);
    cursor = start + (split ? hunk.splitLineCount : hunk.unifiedLineCount);
    nextLineIndex = lineIndexAfter(hunk, column);
  }
  fillCollapsed(total);
  return rows.finish();
}

/**
 * The text of a file's unified diff rows, so line `i` is the row whose `data-line-index` starts with `i`.
 * Rows that Pierre collapses between hunks show context lines of the new file; a patch-only diff does not
 * carry them, so those rows are unknown.
 */
export function unifiedDiffText(diff: FileDiffMetadata): DiffText {
  return columnText(diff, "unified");
}

/**
 * The text of one side of a file's split diff, so line `i` is the row at split index `i`, the number after
 * the comma in `data-line-index`. Both sides share their indices. A side with fewer lines in a change
 * holds buffer rows for the rest, and a patch-only diff does not carry its collapsed rows; those rows are
 * unknown.
 */
export function splitColumnText(diff: FileDiffMetadata, side: "deletions" | "additions"): DiffText {
  return columnText(diff, side);
}
