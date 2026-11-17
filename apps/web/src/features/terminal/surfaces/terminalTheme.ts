import type { ITheme } from "@xterm/xterm";

/** Reads one resolved CSS custom property from the document root. */
export function resolveTerminalColor(token: string): string {
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  if (!color) {
    throw new Error(`Terminal color token ${token} is unavailable`);
  }
  return color;
}

/** The xterm theme slots Mcode fills: the surface colours plus the full ANSI 16. */
export type TerminalThemeSlot =
  | "background"
  | "foreground"
  | "cursor"
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

/**
 * CSS token for every terminal slot, per app theme. Any slot left unset falls back
 * to xterm's Tango palette, whose pale yellows and whites vanish on the light page,
 * so all sixteen ANSI colours are named here. Every foreground holds 4.5:1 against
 * `--page` in its theme (terminalTheme.test.ts). The ANSI "white" slots are
 * mapped to legible greys in light and "black" to a light grey in dark, because
 * prompts print status text in them and DESIGN.md exempts no readable text.
 * Ramp steps are used where the semantic roles stop at one step per hue; cyan
 * has no ramp, so it takes the theme-aware --file-reference role.
 */
export const TERMINAL_THEME_TOKENS: Readonly<Record<"light" | "dark", Readonly<Record<TerminalThemeSlot, string>>>> = {
  light: {
    background: "--page",
    foreground: "--ink",
    cursor: "--ink",
    black: "--neutral-800",
    red: "--clay-700",
    green: "--sage-600",
    yellow: "--amber-700",
    blue: "--blue-700",
    magenta: "--violet-700",
    cyan: "--file-reference",
    white: "--neutral-400",
    brightBlack: "--neutral-400",
    brightRed: "--clay-800",
    brightGreen: "--sage-700",
    brightYellow: "--amber-800",
    brightBlue: "--blue-800",
    brightMagenta: "--violet-800",
    brightCyan: "--file-reference",
    brightWhite: "--neutral-500",
  },
  dark: {
    background: "--page",
    foreground: "--ink",
    cursor: "--ink",
    black: "--neutral-300",
    red: "--clay-400",
    green: "--sage-400",
    yellow: "--amber-500",
    blue: "--blue-400",
    magenta: "--violet-400",
    cyan: "--file-reference",
    white: "--neutral-200",
    brightBlack: "--neutral-300",
    brightRed: "--clay-300",
    brightGreen: "--sage-300",
    brightYellow: "--amber-400",
    brightBlue: "--blue-300",
    brightMagenta: "--violet-300",
    brightCyan: "--file-reference",
    brightWhite: "--neutral-50",
  },
};

/** Builds the xterm theme from the app's current design tokens. */
export function resolveTerminalTheme(): ITheme {
  const tokens = TERMINAL_THEME_TOKENS[document.documentElement.classList.contains("dark") ? "dark" : "light"];
  // xterm resolves these concrete OKLCH values through its canvas colour parser.
  const theme: ITheme = {};
  for (const [slot, token] of Object.entries(tokens) as [TerminalThemeSlot, string][]) {
    theme[slot] = resolveTerminalColor(token);
  }
  return theme;
}

/**
 * Calls `onChange` when the app flips between light and dark. The app switches
 * theme by toggling the `dark` class on the document root, so this is the one
 * signal that covers both an explicit choice and the system preference.
 *
 * @returns A function that stops observing.
 */
export function observeTerminalTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
