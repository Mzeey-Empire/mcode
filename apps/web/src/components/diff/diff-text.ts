import type { FileDiffMetadata } from "@pierre/diffs";

/** One column of a diff as text, one line per row joined with `\n`. */
export interface DiffText {
  readonly text: string;
  /** Rows whose text the diff does not carry. Their lines in `text` are empty. */
  readonly unknown: ReadonlySet<number>;
}

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

/**
 * The text of a file's unified diff rows, so line `i` is the row whose `data-line-index` starts with `i`.
 * Rows that Pierre collapses between hunks show context lines of the new file; a patch-only diff does not
 * carry them, so those rows are unknown.
 */
export function unifiedDiffText(diff: FileDiffMetadata): DiffText {
  const rows = rowBuffer(diff.unifiedLineCount);
  const { additionLines, deletionLines } = diff;
  let nextAdditionLineIndex = 0;
  let unifiedCursor = 0;
  const fillCollapsed = (until: number) => {
    if (diff.isPartial) return;
    for (let offset = 0; unifiedCursor + offset < until; offset++) {
      rows.put(unifiedCursor + offset, additionLines[nextAdditionLineIndex + offset]);
    }
  };

  for (const hunk of diff.hunks) {
    fillCollapsed(hunk.unifiedLineStart);
    let row = hunk.unifiedLineStart;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let offset = 0; offset < block.lines; offset++) {
          rows.put(row++, additionLines[block.additionLineIndex + offset]);
        }
        continue;
      }
      for (let offset = 0; offset < block.deletions; offset++) {
        rows.put(row++, deletionLines[block.deletionLineIndex + offset]);
      }
      for (let offset = 0; offset < block.additions; offset++) {
        rows.put(row++, additionLines[block.additionLineIndex + offset]);
      }
    }
    unifiedCursor = hunk.unifiedLineStart + hunk.unifiedLineCount;
    // A hunk with no new-file lines is positioned after the line its header names, not on it.
    const startsAt = hunk.additionStart - (hunk.additionCount === 0 ? 0 : 1);
    nextAdditionLineIndex = startsAt + hunk.additionCount;
  }
  fillCollapsed(diff.unifiedLineCount);
  return rows.finish();
}
