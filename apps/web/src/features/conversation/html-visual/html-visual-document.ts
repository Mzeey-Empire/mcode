import { HTML_VISUAL_THEME_TOKENS } from "@mcode/contracts/models/html-visual";
import type { HtmlVisualTheme } from "@mcode/shared/html-visual-document";

/** Reads the app's current design token values from the document root. */
export function readHtmlVisualTheme(root: HTMLElement = document.documentElement): HtmlVisualTheme {
  const style = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const token of HTML_VISUAL_THEME_TOKENS) tokens[token] = style.getPropertyValue(token).trim();
  return { colorScheme: root.classList.contains("dark") ? "dark" : "light", tokens };
}
