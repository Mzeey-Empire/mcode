import { parser } from "@lezer/markdown";

type PlanSyntaxNode = ReturnType<typeof parser.parse>["topNode"];

/** CSS classes the Plan editor theme styles. */
export const PLAN_EDITOR_CLASS = {
  title: "cm-plan-title",
  summary: "cm-plan-summary",
  label: "cm-plan-label",
  listMarker: "cm-plan-list-marker",
  code: "cm-plan-code",
  // `text-fade` is the app's 24px right-edge fade utility; a path line never wraps.
  pathItem: "cm-plan-path-item text-fade",
  pathName: "cm-plan-path-name",
  pathFolder: "cm-plan-path-folder",
} as const;

/** One decoration the Plan editor applies, in document offsets. */
export type PlanDecorationRange =
  | { readonly kind: "line"; readonly from: number; readonly className: string }
  | { readonly kind: "mark"; readonly from: number; readonly to: number; readonly className: string }
  | { readonly kind: "hide"; readonly from: number; readonly to: number }
  | { readonly kind: "widget"; readonly from: number; readonly text: string; readonly className: string };

/** A document span covering whole lines, in document offsets. */
export interface PlanLineSpan {
  readonly from: number;
  readonly to: number;
}

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
  return range.kind === "line" || range.kind === "widget" ? range.from : range.to;
}

const PREVIEW_ONLY_CLASSES: ReadonlySet<string> = new Set([
  PLAN_EDITOR_CLASS.listMarker,
  PLAN_EDITOR_CLASS.pathItem,
  PLAN_EDITOR_CLASS.pathName,
  PLAN_EDITOR_CLASS.pathFolder,
]);

function isPreviewOnly(range: PlanDecorationRange): boolean {
  return range.kind === "hide" || range.kind === "widget" || PREVIEW_ONLY_CLASSES.has(range.className);
}

/**
 * Drops the decorations that hide or rearrange markdown on the focused lines,
 * so the line being edited shows its raw source. Type styles stay.
 */
export function visibleDecorations(
  ranges: readonly PlanDecorationRange[],
  focusedLines: readonly PlanLineSpan[],
): readonly PlanDecorationRange[] {
  if (focusedLines.length === 0) return ranges;
  return ranges.filter(
    (range) => !isPreviewOnly(range) || !focusedLines.some((line) => range.from >= line.from && range.from <= line.to),
  );
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
    case "ListItem":
      return pathItemDecorations(text, node);
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

const PATH_TOKEN = /^[^\s`]*[^\s`/]$/;
const FILE_EXTENSION = /\.[A-Za-z0-9]+$/;

// A Files list item names one path: the whole item is inline code holding a
// path or file name, or a bare token with a folder separator.
function pathSpan(text: string, paragraph: PlanSyntaxNode): PlanLineSpan | null {
  const code = paragraph.firstChild;
  return code ? codedPathSpan(text, paragraph, code) : barePathSpan(text, paragraph);
}

function barePathSpan(text: string, paragraph: PlanSyntaxNode): PlanLineSpan | null {
  const bare = text.slice(paragraph.from, paragraph.to);
  return PATH_TOKEN.test(bare) && bare.includes("/") ? { from: paragraph.from, to: paragraph.to } : null;
}

function codedPathSpan(text: string, paragraph: PlanSyntaxNode, code: PlanSyntaxNode): PlanLineSpan | null {
  const wholeItem = code.name === "InlineCode" && code.from === paragraph.from && code.to === paragraph.to;
  if (!wholeItem || code.nextSibling || !code.firstChild || !code.lastChild) return null;
  const span = { from: code.firstChild.to, to: code.lastChild.from };
  const path = text.slice(span.from, span.to);
  return PATH_TOKEN.test(path) && (path.includes("/") || FILE_EXTENSION.test(path)) ? span : null;
}

// The board reads name first, then folder, so the folder is hidden in place
// and drawn again after the name.
function pathItemDecorations(text: string, item: PlanSyntaxNode): PlanDecorationRange[] {
  const paragraph = item.getChild("Paragraph");
  if (!paragraph || paragraph.nextSibling) return [];
  const span = pathSpan(text, paragraph);
  if (!span) return [];
  const slash = text.lastIndexOf("/", span.to - 1);
  const nameFrom = slash >= span.from ? slash + 1 : span.from;
  const ranges: PlanDecorationRange[] = [
    { kind: "line", from: text.lastIndexOf("\n", item.from - 1) + 1, className: PLAN_EDITOR_CLASS.pathItem },
    { kind: "mark", from: nameFrom, to: span.to, className: PLAN_EDITOR_CLASS.pathName },
  ];
  if (nameFrom > span.from) {
    ranges.push(
      { kind: "hide", from: span.from, to: nameFrom },
      { kind: "widget", from: span.to, text: text.slice(span.from, nameFrom - 1), className: PLAN_EDITOR_CLASS.pathFolder },
    );
  }
  return ranges;
}

function skipSpaces(text: string, from: number): number {
  let end = from;
  while (text[end] === " ") end += 1;
  return end;
}
