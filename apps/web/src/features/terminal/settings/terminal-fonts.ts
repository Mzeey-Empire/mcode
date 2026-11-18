import { TERMINAL_DEFAULT_FONT_FAMILY } from "@mcode/contracts/models/terminal-settings";

/** A font the Terminal font picker offers. */
export interface TerminalFontChoice {
  readonly name: string;
  /** Monospace faces list first, because a terminal almost always wants one. */
  readonly mono: boolean;
}

/**
 * Common faces across Windows, macOS and Linux. The app has no installed-font list:
 * `queryLocalFonts()` asks for a permission, so the picker filters this list to the faces this machine renders.
 */
const COMMON_FONTS: readonly TerminalFontChoice[] = [
  { name: "JetBrains Mono", mono: true },
  { name: "Cascadia Code", mono: true },
  { name: "Cascadia Mono", mono: true },
  { name: "Consolas", mono: true },
  { name: "Fira Code", mono: true },
  { name: "Iosevka", mono: true },
  { name: "Source Code Pro", mono: true },
  { name: "SF Mono", mono: true },
  { name: "Menlo", mono: true },
  { name: "Monaco", mono: true },
  { name: "Ubuntu Mono", mono: true },
  { name: "DejaVu Sans Mono", mono: true },
  { name: "Liberation Mono", mono: true },
  { name: "Courier New", mono: true },
  { name: "Lucida Console", mono: true },
  { name: "Segoe UI", mono: false },
  { name: "Arial", mono: false },
  { name: "Calibri", mono: false },
  { name: "Helvetica", mono: false },
  { name: "Georgia", mono: false },
  { name: "Verdana", mono: false },
];

const PROBE_TEXT = "mmmmmmmmmmlli10OO";
const PROBE_FALLBACKS = ["monospace", "serif"] as const;

/** A face renders when text set in it, with a generic fallback behind it, measures differently from the fallback alone. */
function measureWith(probe: HTMLSpanElement, family: string): number {
  probe.style.fontFamily = family;
  return probe.getBoundingClientRect().width;
}

/** Fonts from the common list that this machine renders, in list order. */
export function detectRenderableFonts(): readonly TerminalFontChoice[] {
  const probe = document.createElement("span");
  probe.textContent = PROBE_TEXT;
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font-size:48px;left:-9999px;top:0";
  document.body.append(probe);
  try {
    const baselines = PROBE_FALLBACKS.map((fallback) => measureWith(probe, fallback));
    // Without layout (jsdom in tests) every width is 0, so nothing can be ruled out.
    if (baselines.every((width) => width === 0)) return COMMON_FONTS;
    return COMMON_FONTS.filter((font) =>
      PROBE_FALLBACKS.some((fallback, index) => measureWith(probe, `"${font.name}", ${fallback}`) !== baselines[index]),
    );
  } finally {
    probe.remove();
  }
}

function familyNames(stack: string): string[] {
  return stack.split(",").map((part) => part.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** The face a stored font-family list asks for first, which the picker shows as the current font. */
export function primaryFontFamily(stack: string): string {
  return familyNames(stack)[0] ?? stack;
}

const STORED_FONT_FAMILY_MAX = 128;

/**
 * The stored font-family list for a chosen face: the face first, then the default list behind it,
 * so a face missing on another machine still falls back to the bundled mono font.
 */
export function fontStackFor(family: string): string {
  const name = family.replace(/["']/g, "").trim();
  const quoted = `"${name}"`;
  const rest = familyNames(TERMINAL_DEFAULT_FONT_FAMILY)
    .filter((candidate) => candidate !== name)
    .map((candidate) => (candidate === "monospace" ? candidate : `"${candidate}"`));
  const stack = [quoted, ...rest].join(", ");
  return stack.length <= STORED_FONT_FAMILY_MAX ? stack : `${quoted}, monospace`;
}
