import { HTML_VISUAL_MIN_HEIGHT, type HTML_VISUAL_THEME_TOKENS } from "@mcode/contracts/models/html-visual";

/** Colour scheme applied inside an HTML visual. */
export type HtmlVisualAppearance = "light" | "dark";

/** Resolved app design tokens handed to a visual's page. */
export interface HtmlVisualTheme {
  readonly colorScheme: HtmlVisualAppearance;
  readonly tokens: Readonly<Record<string, string>>;
}

/** Message type a visual's page posts with its content height. */
export const HTML_VISUAL_HEIGHT_MESSAGE = "mcode:visual-height";
/** Message type the app posts to a visual's page when light or dark mode changes. */
export const HTML_VISUAL_THEME_MESSAGE = "mcode:visual-theme";

const fonts = {
  "--font-sans": '"Public Sans Variable", "Public Sans", ui-sans-serif, system-ui, -apple-system, sans-serif',
  "--font-mono": '"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Code", Consolas, monospace',
};

/** Values from the web app's index.css for renderers without access to the live app document. */
export const HTML_VISUAL_DEFAULT_THEMES = {
  light: {
    colorScheme: "light",
    tokens: {
      "--background": "oklch(99% 0.005 260)",
      "--ink": "oklch(19% 0.005 260)",
      "--muted": "oklch(47% 0.010 260)",
      "--panel": "oklch(99% 0.005 260)",
      "--hover": "oklch(95.5% 0.005 260)",
      "--selected": "oklch(90% 0.005 260)",
      "--field": "oklch(95.5% 0.005 260)",
      "--border": "oklch(92.5% 0.005 260)",
      "--control-border": "oklch(65% 0.005 260)",
      "--focus": "oklch(52% 0.170 264)",
      "--link": "oklch(50% 0.160 260)",
      "--primary": "oklch(52% 0.170 75)",
      "--primary-ink": "oklch(99% 0.005 260)",
      "--destructive": "oklch(57.7% 0.190 27.3)",
      "--destructive-ink": "oklch(99% 0.005 260)",
      "--success": "oklch(52% 0.120 145)",
      "--error": "oklch(52% 0.140 25)",
      "--warning": "oklch(46% 0.100 92)",
      "--info": "oklch(50% 0.160 260)",
      ...fonts,
    },
  },
  dark: {
    colorScheme: "dark",
    tokens: {
      "--background": "oklch(0% 0 0)",
      "--ink": "oklch(95.5% 0.005 260)",
      "--muted": "oklch(65% 0.005 260)",
      "--panel": "oklch(13% 0.003 260)",
      "--hover": "color-mix(in oklch, oklch(95.5% 0.005 260) 5%, transparent)",
      "--selected": "color-mix(in oklch, oklch(95.5% 0.005 260) 12%, transparent)",
      "--field": "oklch(24% 0.005 260)",
      "--border": "oklch(19% 0.003 260)",
      "--control-border": "oklch(50% 0.010 260)",
      "--focus": "oklch(62% 0.190 264)",
      "--link": "oklch(70% 0.140 260)",
      "--primary": "oklch(72% 0.170 75)",
      "--primary-ink": "oklch(16% 0.005 260)",
      "--destructive": "oklch(65% 0.200 25)",
      "--destructive-ink": "oklch(16% 0.005 260)",
      "--success": "oklch(78% 0.130 145)",
      "--error": "oklch(78% 0.130 25)",
      "--warning": "oklch(82% 0.110 92)",
      "--info": "oklch(70% 0.140 260)",
      ...fonts,
    },
  },
} as const satisfies Readonly<Record<HtmlVisualAppearance, HtmlVisualTheme & {
  readonly tokens: Readonly<Record<typeof HTML_VISUAL_THEME_TOKENS[number], string>>;
}>>;

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

// Page styles come later in the document, so pages can override these defaults.
const BASE_CSS = "html{background:var(--background);color:var(--ink);font-family:var(--font-sans)}body{margin:0}";

function bootstrapScript(theme: HtmlVisualTheme): string {
  // "<" is escaped so no value can close the script element early.
  const initial = JSON.stringify(theme).replace(/</g, "\\u003c");
  // Keep the bootstrap on one line so browser diagnostics retain the page's line numbers.
  return [
    "(function(){",
    "var apply=function(t){var s=document.documentElement.style;s.colorScheme=t.colorScheme;for(var k in t.tokens)s.setProperty(k,t.tokens[k]);};",
    `apply(${initial});`,
    `addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;if(d&&d.type==="${HTML_VISUAL_THEME_MESSAGE}")apply(d.theme);});`,
    // Unlike scrollHeight, the html element's bounding box can shrink below the frame.
    `var report=function(){parent.postMessage({type:"${HTML_VISUAL_HEIGHT_MESSAGE}",height:document.documentElement.getBoundingClientRect().height},"*");};`,
    "new ResizeObserver(report).observe(document.documentElement);",
    "})();",
  ].join("");
}

const LEADING_DOCTYPE = /^\s*<!doctype[^>]*>/i;

/**
 * Builds the document with the theme and policy before the page's markup.
 * A leading doctype goes first so the browser stays in standards mode.
 */
export function buildHtmlVisualDocument(html: string, theme: HtmlVisualTheme): string {
  const bootstrap = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}"><style>${BASE_CSS}</style><script>${bootstrapScript(theme)}</script>`;
  const doctype = LEADING_DOCTYPE.exec(html)?.[0] ?? "";
  return `${doctype}${bootstrap}${html.slice(doctype.length)}`;
}

/** Maps a browser's zero-based frame position to a one-based position in the visual's HTML. */
export function toHtmlVisualPageLocation(
  frameDocument: string, page: string, line: number, column: number,
): { line: number; column: number } | undefined {
  const bootstrapLength = frameDocument.length - page.length;
  const doctypeLines = (LEADING_DOCTYPE.exec(page)?.[0] ?? "").split(/\r\n|\r|\n/);
  if (line !== doctypeLines.length - 1) return { line: line + 1, column: column + 1 };
  const bootstrapStart = doctypeLines.at(-1)?.length ?? 0;
  if (column < bootstrapStart) return { line: line + 1, column: column + 1 };
  if (column < bootstrapStart + bootstrapLength) return undefined;
  return { line: line + 1, column: column - bootstrapLength + 1 };
}

/** Returns the content height a message from a visual's page reports, or null for any other message. */
export function readHtmlVisualHeight(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  if (!("type" in data) || data.type !== HTML_VISUAL_HEIGHT_MESSAGE) return null;
  if (!("height" in data) || typeof data.height !== "number" || !Number.isFinite(data.height)) return null;
  return data.height;
}

/** Rounds the content up to a whole pixel and clamps it to the frame's allowed height. */
export function htmlVisualFrameHeight(contentHeight: number, maxHeight: number): number {
  return Math.min(maxHeight, Math.max(HTML_VISUAL_MIN_HEIGHT, Math.ceil(contentHeight)));
}
