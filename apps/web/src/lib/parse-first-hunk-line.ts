/**
 * Parse the new-start line (the `+A` value in `@@ -X,Y +A,B @@`) from the
 * first hunk of a unified diff blob. Used to ask the user's editor to jump
 * directly to the changed region instead of opening the file at line 1.
 *
 * Returns `undefined` for diffs that have no parseable hunk header (e.g. an
 * empty diff or a header-only stub before any hunk).
 */
export function parseFirstHunkLine(diff: string): number | undefined {
  // Multi-line flag so ^ matches the start of any line. The length part is
  // optional because some unified diffs omit it for single-line hunks.
  const match = diff.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
