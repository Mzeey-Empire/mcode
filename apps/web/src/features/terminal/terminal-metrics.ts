import type { TerminalSettings } from "@mcode/contracts/models/terminal-settings";

/** Pixel font size for each stored Terminal font size, shared by the terminal and its Settings preview. */
export const TERMINAL_FONT_SIZES: Record<TerminalSettings["presentation"]["fontSize"], number> = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 19,
};

/** Line height multiplier for each stored Terminal line height, shared by the terminal and its Settings preview. */
export const TERMINAL_LINE_HEIGHTS: Record<TerminalSettings["presentation"]["lineHeight"], number> = {
  compact: 1.1,
  normal: 1.2,
  relaxed: 1.4,
};
