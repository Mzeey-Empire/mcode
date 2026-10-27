import { HTML_VISUAL_THEME_TOKENS } from "@mcode/contracts/models/html-visual";
import type { Appearance } from "@/hooks/useTheme";

/** Message type a visual's page posts with its content height. */
export const HTML_VISUAL_HEIGHT_MESSAGE = "mcode:visual-height";
/** Message type the app posts to a visual's page when light or dark mode changes. */
export const HTML_VISUAL_THEME_MESSAGE = "mcode:visual-theme";

/** Resolved app design tokens handed to a visual's page. */
export interface HtmlVisualTheme {
  readonly colorScheme: Appearance;
  readonly tokens: Readonly<Record<string, string>>;
}

/** Reads the app's current design token values from the document root. */
export function readHtmlVisualTheme(root: HTMLElement = document.documentElement): HtmlVisualTheme {
  const style = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const token of HTML_VISUAL_THEME_TOKENS) tokens[token] = style.getPropertyValue(token).trim();
  return { colorScheme: root.classList.contains("dark") ? "dark" : "light", tokens };
}

// The sandbox already isolates the page from the app; this policy also keeps it self-contained,
// so a page cannot fetch, beacon, or load remote content with whatever data it was given.
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

// Page styles come later in the document, so pages can override these defaults.
const BASE_CSS = "html{background:var(--background);color:var(--ink);font-family:var(--font-sans)}body{margin:0}";

// The script runs before the page's own markup so the tokens exist on first paint.
// It accepts theme updates only from the app window, and reports the html element's
// height because it follows the content, unlike scrollHeight, which never drops below the frame.
function bootstrapScript(theme: HtmlVisualTheme): string {
  // "<" is escaped so no value can close the script element early.
  const initial = JSON.stringify(theme).replace(/</g, "\\u003c");
  return `(function(){
var apply=function(t){var s=document.documentElement.style;s.colorScheme=t.colorScheme;for(var k in t.tokens)s.setProperty(k,t.tokens[k]);};
apply(${initial});
addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;if(d&&d.type==="${HTML_VISUAL_THEME_MESSAGE}")apply(d.theme);});
var report=function(){parent.postMessage({type:"${HTML_VISUAL_HEIGHT_MESSAGE}",height:document.documentElement.getBoundingClientRect().height},"*");};
new ResizeObserver(report).observe(document.documentElement);
})();`;
}

const LEADING_DOCTYPE = /^\s*<!doctype[^>]*>/i;

/**
 * Builds the frame document for a visual: the page with Mcode's theme bootstrap ahead of it.
 * The bootstrap goes after a leading doctype, because markup before it would put the page in quirks mode.
 * It also comes before any page markup, so the policy lands in the head, the only place a meta policy applies.
 */
export function buildHtmlVisualDocument(html: string, theme: HtmlVisualTheme): string {
  const bootstrap = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}"><style>${BASE_CSS}</style><script>${bootstrapScript(theme)}</script>`;
  const doctype = LEADING_DOCTYPE.exec(html)?.[0] ?? "";
  return `${doctype}${bootstrap}${html.slice(doctype.length)}`;
}

/** Returns the content height a message from a visual's page reports, or null for any other message. */
export function readHtmlVisualHeight(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  if (!("type" in data) || data.type !== HTML_VISUAL_HEIGHT_MESSAGE) return null;
  if (!("height" in data) || typeof data.height !== "number" || !Number.isFinite(data.height)) return null;
  return data.height;
}
