/**
 * Names the glyph a status mark draws: `spinner` for a running mark, else the lucide icon's name,
 * read from the class lucide puts on its svg, since jsdom cannot show the drawing itself.
 */
export function statusGlyph(mark: HTMLElement): string | null {
  if (mark.getAttribute("data-status-mark") === "running") return "spinner";
  return mark.querySelector("svg")?.getAttribute("class")?.match(/\blucide-([a-z-]+)/)?.[1] ?? null;
}
