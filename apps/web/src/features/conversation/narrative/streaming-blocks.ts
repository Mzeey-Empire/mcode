/** One display-ready slice of streamed response text. */
export type StreamingBlockPart =
  | { kind: "text"; text: string }
  | { kind: "fence"; lang: string; code: string; closed: boolean }
  | { kind: "table"; header: string[]; rows: string[][]; closed: boolean };

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// A GFM separator row: only pipes, dashes, colons and whitespace, and it must
// contain both a pipe and a dash so a bare "---" horizontal rule is not one.
const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/;

interface Line {
  text: string;
  start: number;
  end: number;
}

interface OpenFence {
  char: string;
  length: number;
  lang: string;
}

/**
 * Matches a CommonMark fence opener: up to three leading spaces plus a run of
 * backticks or tildes and an info string. A backtick fence whose info string
 * contains a backtick is not a fence at all; tilde fences have no such rule.
 */
function matchFenceOpen(line: string): OpenFence | null {
  const open = FENCE_OPEN_RE.exec(line);
  if (!open) return null;
  const marker = open[1]!;
  const info = open[2]!.trim();
  if (marker[0] === "`" && info.includes("`")) return null;
  return { char: marker[0]!, length: marker.length, lang: info.split(/\s+/)[0] ?? "" };
}

/** A closer repeats the opener's character at least as many times, with no info string. */
function isFenceClose(line: string, fence: OpenFence): boolean {
  const close = FENCE_CLOSE_RE.exec(line);
  return close !== null && close[1]![0] === fence.char && close[1]!.length >= fence.length;
}

/** Pipe rows indented four spaces or a tab are code blocks, not table rows. */
function isTableRow(line: string): boolean {
  return /^ {0,3}\|/.test(line);
}

/** A table starts at a pipe row whose next line is a separator row. */
function isTableStart(lines: Line[], index: number): boolean {
  return index + 1 < lines.length
    && isTableRow(lines[index]!.text)
    && TABLE_SEPARATOR_RE.test(lines[index + 1]!.text);
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function toLines(text: string): Line[] {
  const lines: Line[] = [];
  let pos = 0;
  while (pos < text.length) {
    const newline = text.indexOf("\n", pos);
    const end = newline === -1 ? text.length : newline;
    lines.push({ text: text.slice(pos, end).replace(/\r$/, ""), start: pos, end });
    pos = end + 1;
  }
  return lines;
}

/** Emits the pending text run plus a fence part; returns where scanning resumes. */
function emitFence(lines: Line[], index: number, open: OpenFence, text: string, parts: StreamingBlockPart[], textStart: number) {
  const opener = lines[index]!;
  if (opener.start > textStart) parts.push({ kind: "text", text: text.slice(textStart, opener.start) });
  let cursor = index + 1;
  while (cursor < lines.length && !isFenceClose(lines[cursor]!.text, open)) cursor += 1;
  const closed = cursor < lines.length;
  const code = text
    .slice(opener.end + 1, closed ? lines[cursor]!.start : text.length)
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "");
  parts.push({ kind: "fence", lang: open.lang, code, closed });
  return { index: closed ? cursor + 1 : lines.length, textStart: closed ? lines[cursor]!.end + 1 : text.length };
}

/** Emits the pending text run plus a table part; returns where scanning resumes. */
function emitTable(lines: Line[], index: number, parts: StreamingBlockPart[], text: string, textStart: number) {
  const header = lines[index]!;
  if (header.start > textStart) parts.push({ kind: "text", text: text.slice(textStart, header.start) });
  let cursor = index + 2;
  while (cursor < lines.length && isTableRow(lines[cursor]!.text)) cursor += 1;
  const closed = cursor < lines.length;
  parts.push({
    kind: "table",
    header: tableCells(header.text),
    rows: lines.slice(index + 2, cursor).map((line) => tableCells(line.text)),
    closed,
  });
  return { index: cursor, textStart: closed ? lines[cursor]!.start : text.length };
}

/**
 * Splits streamed markdown into plain-text runs, fenced blocks, and tables so
 * completed constructs can render before the turn settles.
 *
 * A fence whose closing marker has not arrived yet is emitted with
 * `closed: false`, and a table still receiving rows (no following non-table
 * line) likewise, so callers can show assembling placeholders instead of
 * rendering partial structure. A fence-looking or table-looking line nested
 * inside an open fence is consumed as fence source, never promoted.
 */
export function splitStreamingBlocks(text: string): StreamingBlockPart[] {
  const lines = toLines(text);
  const parts: StreamingBlockPart[] = [];
  let textStart = 0;
  let index = 0;
  while (index < lines.length) {
    const open = matchFenceOpen(lines[index]!.text);
    if (open) {
      ({ index, textStart } = emitFence(lines, index, open, text, parts, textStart));
      continue;
    }
    if (isTableStart(lines, index)) {
      ({ index, textStart } = emitTable(lines, index, parts, text, textStart));
      continue;
    }
    index += 1;
  }
  if (textStart < text.length) {
    parts.push({ kind: "text", text: text.slice(textStart) });
  }
  return parts;
}
