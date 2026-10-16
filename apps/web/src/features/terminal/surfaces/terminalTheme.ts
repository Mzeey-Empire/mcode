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

/** Builds the xterm theme from the app's current design tokens. */
export function resolveTerminalTheme(): ITheme {
  // xterm resolves these concrete OKLCH values through its canvas colour parser.
  return {
    background: resolveTerminalColor("--page"),
    foreground: resolveTerminalColor("--ink"),
    cursor: resolveTerminalColor("--ink"),
    green: resolveTerminalColor("--success"),
    brightGreen: resolveTerminalColor("--success"),
    yellow: resolveTerminalColor("--primary"),
    brightYellow: resolveTerminalColor("--primary"),
    red: resolveTerminalColor("--error"),
    brightRed: resolveTerminalColor("--error"),
    blue: resolveTerminalColor("--link"),
    brightBlue: resolveTerminalColor("--link"),
  };
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
