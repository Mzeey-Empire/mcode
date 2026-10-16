/** A validated absolute Terminal file target. */
export interface TerminalLinkTarget {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

/** A validated link and its character range within one Terminal line. */
export interface TerminalLinkMatch {
  readonly target: TerminalLinkTarget;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A validated `http(s)` URL and its character range within one Terminal line. */
export interface TerminalUrlMatch {
  readonly url: string;
  readonly loopback: boolean;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A minimal xterm cell view used to translate text offsets to cell columns. */
export interface TerminalLinkCell {
  readonly getChars: () => string;
  readonly getWidth: () => number;
}

/** A minimal xterm buffer line used by the link range adapter. */
export interface TerminalLinkCellLine {
  readonly length: number;
  readonly getCell: (index: number) => TerminalLinkCell | undefined;
}

/** An inclusive-start, exclusive-end range measured in xterm cell columns. */
export interface TerminalLinkCellRange {
  readonly start: number;
  readonly end: number;
}

const LOCATION_LIMIT = 1_000_000;
const TRAILING_PUNCTUATION = /[\])}>,.;!?]+$/;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/** Parses one Terminal file link without accepting URLs or traversal paths. */
export function parseTerminalLink(value: string): TerminalLinkTarget | null {
  const location = parseTerminalLinkLocation(value);
  if (!location) return null;

  const path = location[1];
  if (!isSafeTerminalPath(path)) return null;

  const line = parseTerminalLocationNumber(location[2]);
  const column = parseTerminalLocationNumber(location[3]);
  if (line === null || column === null) return null;
  return {
    path,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  };
}

function parseTerminalLinkLocation(value: string): RegExpExecArray | null {
  const candidate = value.trim().replace(TRAILING_PUNCTUATION, "");
  return /^(.*?)(?::([0-9]+))?(?::([0-9]+))?$/.exec(candidate);
}

function isSafeTerminalPath(path: string): boolean {
  if (!path || path.length > 2_048 || containsControlCharacter(path)) return false;
  if (path.includes("://") || path.split(/[\\/]/).includes("..")) return false;
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
}

function parseTerminalLocationNumber(value: string | undefined): number | undefined | null {
  if (!value) return undefined;
  const location = Number(value);
  if (!Number.isSafeInteger(location) || location < 1 || location > LOCATION_LIMIT) {
    return null;
  }
  return location;
}

/** Finds all safe absolute file targets in one Terminal line. */
export function findTerminalLinks(value: string): readonly TerminalLinkMatch[] {
  const candidatePattern = /(?:^|\s)((?:[A-Za-z]:[\\/]|\/)[^\s<>"'`]+)/g;
  const links: TerminalLinkMatch[] = [];
  for (const match of value.matchAll(candidatePattern)) {
    const text = match[1];
    const target = parseTerminalLink(text);
    if (!target || match.index === undefined) continue;
    const start = match.index + (match[0].length - text.length);
    links.push({ target, text, start, end: start + text.length });
  }
  return links;
}

const URL_LENGTH_LIMIT = 2_048;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

const URL_CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

function occurrences(value: string, char: string): number {
  return value.split(char).length - 1;
}

/** Drops sentence punctuation after a URL, keeping a closing bracket that pairs with one inside it. */
function trimUrlTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0) {
    const last = value[end - 1]!;
    const opener = URL_CLOSERS[last];
    const closesOwnBracket = opener !== undefined &&
      occurrences(value.slice(0, end), last) <= occurrences(value.slice(0, end), opener);
    if (!TRAILING_PUNCTUATION.test(last) || closesOwnBracket) break;
    end -= 1;
  }
  return value.slice(0, end);
}

function parseTerminalUrl(candidate: string): Pick<TerminalUrlMatch, "url" | "loopback"> | null {
  if (candidate.length > URL_LENGTH_LIMIT || containsControlCharacter(candidate)) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { url: parsed.href, loopback: LOOPBACK_HOSTNAMES.has(parsed.hostname) };
  } catch {
    return null;
  }
}

/** Whether a Terminal row continues the previous row or runs on into the next one. */
export interface TerminalRowWrap {
  readonly continuesPreviousRow: boolean;
  readonly continuesOnNextRow: boolean;
}

/**
 * Finds `http(s)://` URLs in one Terminal line. Terminal output is untrusted, so
 * other schemes (`javascript:`, `file:`) never become links.
 *
 * A URL that touches a wrapped edge of the row is skipped: only part of it is
 * on this row, and opening the partial address would send the user somewhere
 * else.
 */
export function findTerminalUrlLinks(
  value: string,
  wrap: TerminalRowWrap = { continuesPreviousRow: false, continuesOnNextRow: false },
): readonly TerminalUrlMatch[] {
  const links: TerminalUrlMatch[] = [];
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    if (match.index === undefined) continue;
    const runsPastRowStart = wrap.continuesPreviousRow && match.index === 0;
    const runsPastRowEnd = wrap.continuesOnNextRow && match.index + match[0].length === value.length;
    if (runsPastRowStart || runsPastRowEnd) continue;
    const text = trimUrlTrailingPunctuation(match[0]);
    const parsed = parseTerminalUrl(text);
    if (!parsed) continue;
    links.push({ ...parsed, text, start: match.index, end: match.index + text.length });
  }
  return links;
}

/** Maps one text range onto xterm cell columns, preserving wide characters. */
export function terminalLinkCellRange(
  line: TerminalLinkCellLine,
  match: Pick<TerminalLinkMatch, "start" | "end">,
): TerminalLinkCellRange | null {
  let textOffset = 0;
  let startColumn: number | null = null;
  let endColumn: number | null = null;
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell) continue;
    const chars = cell.getChars();
    if (!chars) continue;
    const cellEnd = textOffset + chars.length;
    if (match.start < cellEnd && match.end > textOffset) {
      startColumn ??= column;
      endColumn = column + Math.max(1, cell.getWidth());
    }
    textOffset = cellEnd;
  }
  if (startColumn === null || endColumn === null) return null;
  return { start: startColumn, end: endColumn };
}
