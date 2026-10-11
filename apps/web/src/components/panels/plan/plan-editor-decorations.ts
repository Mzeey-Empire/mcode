import { parser } from "@lezer/markdown";

type PlanSyntaxNode = ReturnType<typeof parser.parse>["topNode"];

/** CSS classes the Plan editor theme styles. */
export const PLAN_EDITOR_CLASS = {
  title: "cm-plan-title",
  summary: "cm-plan-summary",
  label: "cm-plan-label",
  listMarker: "cm-plan-list-marker",
  code: "cm-plan-code",
} as const;

/** One decoration the Plan editor applies, in document offsets. */
export type PlanDecorationRange =
  | { readonly kind: "line"; readonly from: number; readonly className: string }
  | { readonly kind: "mark"; readonly from: number; readonly to: number; readonly className: string }
  | { readonly kind: "hide"; readonly from: number; readonly to: number };

/**
 * Computes the read-view decorations for a plan's markdown: the first H1 is the
 * title, the paragraph right after it is the summary, H2s are labels, ordered
 * list markers sit in a mono column, and markdown syntax marks are hidden.
 * Sorted by position so the result is stable and easy to compare.
 */
export function planEditorDecorations(markdown: string): PlanDecorationRange[] {
  const doc = parser.parse(markdown).topNode;
  const ranges = [...blockDecorations(markdown, doc), ...inlineDecorations(markdown, doc)];
  return ranges.sort((a, b) => a.from - b.from || rangeEnd(a) - rangeEnd(b));
}

function rangeEnd(range: PlanDecorationRange): number {
  return range.kind === "line" ? range.from : range.to;
}

function blockDecorations(text: string, doc: PlanSyntaxNode): PlanDecorationRange[] {
  const ranges: PlanDecorationRange[] = [];
  let titleSeen = false;
  let summaryPending = false;
  for (let block = doc.firstChild; block; block = block.nextSibling) {
    const className = blockClass(block.name, { titleSeen, summaryPending });
    if (block.name === "ATXHeading1" && !titleSeen) titleSeen = true;
    summaryPending = className === PLAN_EDITOR_CLASS.title;
    if (className) ranges.push(...lineClasses(text, block.from, block.to, className));
  }
  return ranges;
}

function blockClass(
  name: string,
  position: { titleSeen: boolean; summaryPending: boolean },
): string | null {
  if (name === "ATXHeading1" && !position.titleSeen) return PLAN_EDITOR_CLASS.title;
  if (name === "Paragraph" && position.summaryPending) return PLAN_EDITOR_CLASS.summary;
  if (name === "ATXHeading2") return PLAN_EDITOR_CLASS.label;
  return null;
}

// Line decorations must start at a line start, and a wrapped summary paragraph
// spans several lines that all need the class.
function lineClasses(text: string, from: number, to: number, className: string): PlanDecorationRange[] {
  const ranges: PlanDecorationRange[] = [{ kind: "line", from: text.lastIndexOf("\n", from - 1) + 1, className }];
  for (let newline = text.indexOf("\n", from); newline !== -1 && newline < to; newline = text.indexOf("\n", newline + 1)) {
    ranges.push({ kind: "line", from: newline + 1, className });
  }
  return ranges;
}

function inlineDecorations(text: string, doc: PlanSyntaxNode): PlanDecorationRange[] {
  const ranges: PlanDecorationRange[] = [];
  doc.cursor().iterate((ref) => {
    ranges.push(...nodeDecorations(text, ref.node));
  });
  return ranges;
}

function nodeDecorations(text: string, node: PlanSyntaxNode): PlanDecorationRange[] {
  switch (node.name) {
    case "HeaderMark":
      return [{ kind: "hide", from: node.from, to: skipSpaces(text, node.to) }];
    case "EmphasisMark":
      return [{ kind: "hide", from: node.from, to: node.to }];
    case "InlineCode":
      return inlineCodeDecorations(node);
    case "ListMark":
      return listMarkDecorations(text, node);
    default:
      return [];
  }
}

// Fenced code blocks also use CodeMark, so only inline code backticks are hidden.
function inlineCodeDecorations(node: PlanSyntaxNode): PlanDecorationRange[] {
  const ranges: PlanDecorationRange[] = [{ kind: "mark", from: node.from, to: node.to, className: PLAN_EDITOR_CLASS.code }];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeMark") ranges.push({ kind: "hide", from: child.from, to: child.to });
  }
  return ranges;
}

// The marker column has a fixed width, so the space after the marker is hidden.
function listMarkDecorations(text: string, node: PlanSyntaxNode): PlanDecorationRange[] {
  const ranges: PlanDecorationRange[] = [{ kind: "mark", from: node.from, to: node.to, className: PLAN_EDITOR_CLASS.listMarker }];
  const textStart = skipSpaces(text, node.to);
  if (textStart > node.to) ranges.push({ kind: "hide", from: node.to, to: textStart });
  return ranges;
}

function skipSpaces(text: string, from: number): number {
  let end = from;
  while (text[end] === " ") end += 1;
  return end;
}
