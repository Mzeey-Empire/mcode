import type { ParsedDiffLine } from "./diff-parser";

/** Result of reconstructing the new-file content while tracking which output
 *  lines were additions. */
export interface ReconstructedContent {
  /** The reconstructed file text (context + added lines, in order). */
  readonly content: string;
  /**
   * 1-based line numbers within {@link content} that came from `add` lines.
   * These are the lines to highlight in the rendered preview.
   */
  readonly addedLines: ReadonlySet<number>;
}

/**
 * Reconstruct the post-change content from parsed diff lines and record
 * which output lines were additions.
 *
 * Returns 1-based line numbers (matching mdast `position.start.line` /
 * `position.end.line`) so a remark plugin can intersect them with each
 * AST node's source range to decide whether the block contains additions.
 *
 * Headers, removed lines, and the `\ No newline at end of file` sentinel
 * are excluded from {@link ReconstructedContent.content}.
 */
export function reconstructWithChangeMap(
  lines: ReadonlyArray<ParsedDiffLine>,
): ReconstructedContent {
  const out: string[] = [];
  const addedLines = new Set<number>();
  for (const line of lines) {
    if (line.type === "header" || line.type === "remove") continue;
    if (line.content === "\\ No newline at end of file") continue;
    out.push(line.content);
    if (line.type === "add") addedLines.add(out.length); // 1-based
  }
  return { content: out.join("\n"), addedLines };
}
