const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_EOF_NEWLINE = "\\ No newline at end of file";

/**
 * Truncate a unified diff to at most `maxLines` lines without splitting a
 * hunk. A raw line slice can leave a hunk body shorter than its header
 * declares; `@pierre/diffs` treats that as malformed and repairs the hunk
 * with shifted boundaries, so the rendered line mapping drifts. Only
 * complete hunks are kept, and a file header block is emitted only when at
 * least one of its hunks survives.
 */
export function truncateUnifiedDiff(diff: string, maxLines: number | undefined): string {
  if (!maxLines || maxLines <= 0) return diff;
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  let end = 0;
  let i = 0;
  while (i < maxLines) {
    if (!lines[i]!.startsWith("@@ ")) {
      i++;
      continue;
    }
    const body = hunkBodyLength(lines, i);
    if (body === undefined || i + 1 + body > maxLines) break;
    i += 1 + body;
    end = i;
  }
  return lines.slice(0, end).join("\n");
}

/** Body line count of the hunk at `headerIndex`, including `\ No newline` markers. */
function hunkBodyLength(lines: readonly string[], headerIndex: number): number | undefined {
  const match = HUNK_HEADER.exec(lines[headerIndex]!);
  if (!match) return undefined;
  const remaining = { old: Number(match[2] ?? 1), new: Number(match[4] ?? 1) };
  let i = headerIndex + 1;
  while (remaining.old + remaining.new > 0) {
    if (!consumeHunkLine(lines[i], remaining)) return undefined;
    i++;
    if (lines[i] === NO_EOF_NEWLINE) i++;
  }
  return i - headerIndex - 1;
}

/** Debit the declared hunk counts for one body line; false when the line cannot belong to the hunk. */
function consumeHunkLine(line: string | undefined, remaining: { old: number; new: number }): boolean {
  // `diff.suppressBlankEmpty` and external diff drivers emit a truly empty
  // line for blank context; `git apply` counts it as context too.
  const prefix = line === "" ? " " : line?.[0];
  if (prefix === " ") {
    remaining.old--;
    remaining.new--;
  } else if (prefix === "-") {
    remaining.old--;
  } else if (prefix === "+") {
    remaining.new--;
  } else {
    return false;
  }
  return remaining.old >= 0 && remaining.new >= 0;
}
