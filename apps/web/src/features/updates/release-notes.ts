import { stripInlineMarkdown } from "@/lib/inline-markdown";

/** Release notes reduced to plain text the update card can render safely. */
export interface ParsedReleaseNotes {
  /** Up to {@link MAX_RELEASE_NOTE_ITEMS} list items, as plain text. */
  readonly items: string[];
  /** The first paragraph when the notes have no list items, otherwise null. */
  readonly fallback: string | null;
}

/** The card shows a short digest; the full notes live on GitHub. */
export const MAX_RELEASE_NOTE_ITEMS = 5;

const HTML_LIST_ITEM = /<li\b[^>]*>([\s\S]*?)(?=<\/li\s*>|<li\b|<\/[ou]l\s*>|$)/gi;
const MARKDOWN_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;
const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s/;
// Script and style bodies are code, not prose, so they are dropped with their tags.
const EXECUTABLE_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const HTML_HEADING_BLOCK = /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/gi;
const BLOCK_BOUNDARY = /<\/?(?:p|div|ul|ol|li|br|hr|h[1-6]|blockquote|pre|table|tr)\b[^>]*>/gi;
const ANY_TAG = /<\/?[a-z!][^>]*>/gi;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith("#")) {
      const codePoint = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

/** Reduces one fragment of HTML or markdown to a single line of plain text. */
function toPlainText(fragment: string): string {
  const withoutTags = fragment.replace(EXECUTABLE_BLOCK, " ").replace(BLOCK_BOUNDARY, " ").replace(ANY_TAG, "");
  return decodeEntities(stripInlineMarkdown(withoutTags)).replace(/\s+/g, " ").trim();
}

function htmlListItems(notes: string): string[] {
  return Array.from(notes.replace(EXECUTABLE_BLOCK, " ").matchAll(HTML_LIST_ITEM), (match) => toPlainText(match[1] ?? ""));
}

function markdownListItems(notes: string): string[] {
  return notes.split(/\r?\n/).flatMap((line) => {
    const match = MARKDOWN_LIST_ITEM.exec(line);
    return match?.[1] ? [toPlainText(match[1])] : [];
  });
}

function firstParagraph(notes: string): string | null {
  const blocks = notes
    .replace(EXECUTABLE_BLOCK, " ")
    .replace(HTML_HEADING_BLOCK, "\n\n")
    .replace(BLOCK_BOUNDARY, "\n\n")
    .split(/\r?\n\s*\r?\n/);
  for (const block of blocks) {
    const prose = block
      .split(/\r?\n/)
      .filter((line) => !MARKDOWN_HEADING.test(line))
      .join(" ");
    const text = toPlainText(prose);
    if (text) return text;
  }
  return null;
}

/**
 * Parses electron-updater release notes, which arrive as HTML or markdown from
 * an untrusted GitHub release body, into plain text for the update card.
 *
 * List items win over prose. Every markup construct is stripped, so callers
 * render the result as text and never as HTML.
 */
export function parseReleaseNotes(notes: string): ParsedReleaseNotes {
  const htmlItems = htmlListItems(notes).filter(Boolean);
  const items = (htmlItems.length > 0 ? htmlItems : markdownListItems(notes).filter(Boolean)).slice(0, MAX_RELEASE_NOTE_ITEMS);
  if (items.length > 0) return { items, fallback: null };
  return { items: [], fallback: firstParagraph(notes) };
}
