import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/**
 * Largest page an HTML visual may carry, in UTF-8 bytes. Inlined images count toward it.
 * Even fully JSON-escaped, a page this size fits one conversation history page budget.
 */
export const HTML_VISUAL_MAX_HTML_BYTES = 512 * 1024;
/** Smallest frame height, in CSS pixels, a visual may request or be drawn at. */
export const HTML_VISUAL_MIN_HEIGHT = 80;
/** Largest frame height, in CSS pixels, a visual may request. Taller pages scroll inside the frame. */
export const HTML_VISUAL_MAX_HEIGHT = 2000;
/** Longest title, used as the frame's accessible name and the plain-text fallback. */
export const HTML_VISUAL_MAX_TITLE_LENGTH = 200;

/**
 * App design tokens injected into every visual's `:root` as CSS custom properties.
 * They follow the user's light or dark mode live, so pages can match the thread without hardcoded colours.
 */
export const HTML_VISUAL_THEME_TOKENS = [
  "--background", "--ink", "--muted", "--panel", "--hover", "--selected", "--field",
  "--border", "--control-border", "--focus", "--link", "--primary", "--primary-ink",
  "--destructive", "--destructive-ink", "--success", "--error", "--warning", "--info",
  "--font-sans", "--font-mono",
] as const;

/** A self-contained HTML page shown in a sandboxed frame in the thread timeline. */
export const HtmlVisualSchema = lazySchema(() => z.object({
  title: z.string().trim().min(1).max(HTML_VISUAL_MAX_TITLE_LENGTH),
  html: z.string().min(1).max(HTML_VISUAL_MAX_HTML_BYTES)
    .refine((html) => new TextEncoder().encode(html).length <= HTML_VISUAL_MAX_HTML_BYTES, {
      message: `HTML visual exceeds ${HTML_VISUAL_MAX_HTML_BYTES} UTF-8 bytes`,
    }),
  /** The frame grows with its content up to this height, then scrolls. */
  maxHeight: z.number().int().min(HTML_VISUAL_MIN_HEIGHT).max(HTML_VISUAL_MAX_HEIGHT),
}).strict());

/** A self-contained HTML page shown in a sandboxed frame in the thread timeline. */
export type HtmlVisual = z.infer<ReturnType<typeof HtmlVisualSchema>>;
