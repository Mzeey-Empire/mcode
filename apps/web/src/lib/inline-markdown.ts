const CODE_SPAN = /(`+)([\s\S]*?)\1/g;
// Link targets may hold one level of parentheses, as in javascript:alert(1).
const INLINE_LINK = /!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g;
const REFERENCE_LINK = /\[([^\]]*)\]\[[^\]]*\]/g;
// Delimiters only count when they hug non-space text, so `2 * 3 * 4` keeps its stars.
const STRONG_STARS = /\*\*(?=\S)([\s\S]*?\S)\*\*/g;
const EMPHASIS_STAR = /\*(?=[^\s*])([^*]*?[^\s*])\*/g;
// Underscores never open or close inside a word, so `snake_case` stays intact.
const STRONG_UNDERSCORES = /(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/g;
const EMPHASIS_UNDERSCORE = /(?<!\w)_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g;
const STRIKETHROUGH = /~~(?=\S)([\s\S]*?\S)~~/g;

function stripDelimiters(prose: string): string {
  return prose
    .replace(INLINE_LINK, "$1")
    .replace(REFERENCE_LINK, "$1")
    .replace(STRONG_STARS, "$1")
    .replace(STRONG_UNDERSCORES, "$1")
    .replace(EMPHASIS_STAR, "$1")
    .replace(EMPHASIS_UNDERSCORE, "$1")
    .replace(STRIKETHROUGH, "$1");
}

/**
 * Removes inline Markdown syntax (links, emphasis, strikethrough, code-span
 * backticks) and keeps every other character. Code span contents are kept
 * verbatim because their underscores and brackets are literal.
 */
export function stripInlineMarkdown(text: string): string {
  let plain = "";
  let proseStart = 0;
  for (const match of text.matchAll(CODE_SPAN)) {
    plain += stripDelimiters(text.slice(proseStart, match.index)) + (match[2] ?? "");
    proseStart = match.index + match[0].length;
  }
  return plain + stripDelimiters(text.slice(proseStart));
}
