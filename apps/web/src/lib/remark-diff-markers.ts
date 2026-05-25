import type { Root, RootContent } from "mdast";

/**
 * Block-level mdast node types we tag when their source range overlaps the
 * added-lines set. We deliberately skip the outer containers (`list`,
 * `table`) and tag the inner units (`listItem`, `tableRow`) so a single new
 * bullet or table row gets highlighted rather than the whole construct.
 */
const BLOCK_TYPES = new Set([
  "heading",
  "paragraph",
  "code",
  "blockquote",
  "listItem",
  "thematicBreak",
  "tableRow",
  "html",
]);

/** True when any source line covered by `node` is in the added set. */
function intersects(
  node: { position?: { start: { line: number }; end: { line: number } } },
  addedLines: ReadonlySet<number>,
): boolean {
  if (!node.position) return false;
  for (let i = node.position.start.line; i <= node.position.end.line; i++) {
    if (addedLines.has(i)) return true;
  }
  return false;
}

/**
 * Attach `data-diff-added="true"` to qualifying nodes' hast properties so
 * the rendered HTML carries the attribute and our CSS can tint the block.
 * Recurses through children to reach nested blocks (list items, blockquote
 * paragraphs, etc.).
 */
function markIfMatched(
  node: { type: string; children?: RootContent[] } & Record<string, unknown>,
  addedLines: ReadonlySet<number>,
): void {
  if (BLOCK_TYPES.has(node.type) && intersects(node as Parameters<typeof intersects>[0], addedLines)) {
    const withData = node as {
      data?: { hProperties?: Record<string, unknown> };
    };
    withData.data = withData.data ?? {};
    withData.data.hProperties = withData.data.hProperties ?? {};
    withData.data.hProperties["data-diff-added"] = "true";
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      markIfMatched(child as Parameters<typeof markIfMatched>[0], addedLines);
    }
  }
}

/**
 * Build a remark transformer that flags mdast block nodes whose source
 * range intersects the given line set. Use this in tandem with
 * {@link import("./diff-preview-content").reconstructWithChangeMap} to render
 * a whole-file Markdown preview with GitHub-style "added block" highlighting.
 *
 * Each match gets a `data-diff-added="true"` hast property; rendered HTML
 * exposes it as `data-diff-added="true"` for CSS targeting.
 */
export function makeRemarkDiffMarkers(addedLines: ReadonlySet<number>) {
  return () =>
    (tree: Root): void => {
      markIfMatched(tree as Parameters<typeof markIfMatched>[0], addedLines);
    };
}
