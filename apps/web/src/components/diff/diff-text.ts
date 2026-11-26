import type { FileDiffMetadata } from "@pierre/diffs";

/** Pierre keeps each line's own ending; a row's text does not include it. */
function withoutLineEnding(line: string | undefined): string {
  return (line ?? "").replace(/\r?\n$/, "");
}

/**
 * The text of a file's unified diff rows, one line per row joined with `\n`, so line `i` is the row
 * whose `data-line-index` starts with `i`. Rows that Pierre collapses between hunks show context lines
 * of the new file; a patch-only diff does not carry them, so those lines are empty.
 */
export function unifiedDiffText(diff: FileDiffMetadata): string {
  const rows = Array.from({ length: diff.unifiedLineCount }, () => "");
  const { additionLines, deletionLines } = diff;
  const put = (index: number, line: string | undefined) => {
    if (index >= 0 && index < rows.length) rows[index] = withoutLineEnding(line);
  };
  // Index into `additionLines` of the first new-file line that no earlier row has used.
  let additionCursor = 0;
  let unifiedCursor = 0;
  const fillCollapsed = (until: number) => {
    if (diff.isPartial) return;
    for (let offset = 0; unifiedCursor + offset < until; offset++) {
      put(unifiedCursor + offset, additionLines[additionCursor + offset]);
    }
  };

  for (const hunk of diff.hunks) {
    fillCollapsed(hunk.unifiedLineStart);
    let row = hunk.unifiedLineStart;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let offset = 0; offset < block.lines; offset++) {
          put(row++, additionLines[block.additionLineIndex + offset]);
        }
        continue;
      }
      for (let offset = 0; offset < block.deletions; offset++) {
        put(row++, deletionLines[block.deletionLineIndex + offset]);
      }
      for (let offset = 0; offset < block.additions; offset++) {
        put(row++, additionLines[block.additionLineIndex + offset]);
      }
    }
    unifiedCursor = hunk.unifiedLineStart + hunk.unifiedLineCount;
    // A hunk with no new-file lines is positioned after the line its header names, not on it.
    const startsAt = hunk.additionStart - (hunk.additionCount === 0 ? 0 : 1);
    additionCursor = startsAt + hunk.additionCount;
  }
  fillCollapsed(rows.length);
  return rows.join("\n");
}
