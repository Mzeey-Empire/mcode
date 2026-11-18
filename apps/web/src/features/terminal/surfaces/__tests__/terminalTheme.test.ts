import { describe, expect, it } from "vitest";
import { contrast, resolveToken, themeTokens } from "@/__tests__/token-contrast";
import { TERMINAL_THEME_TOKENS, type TerminalThemeSlot } from "../terminalTheme";

const SURFACE_SLOTS = new Set<TerminalThemeSlot>(["background"]);

describe("terminal theme contrast", () => {
  for (const themeName of ["light", "dark"] as const) {
    const tokens = TERMINAL_THEME_TOKENS[themeName];
    const page = resolveToken(themeTokens[themeName], tokens.background);
    const foregrounds = (Object.keys(tokens) as TerminalThemeSlot[]).filter((slot) => !SURFACE_SLOTS.has(slot));

    it.each(foregrounds)(`${themeName} %s reads at 4.5:1 on the terminal background`, (slot) => {
      const color = resolveToken(themeTokens[themeName], tokens[slot]);
      expect(contrast(color, page)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
