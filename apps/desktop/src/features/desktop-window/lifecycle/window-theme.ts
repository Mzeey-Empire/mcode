import * as NodeFS from "node:fs";

import { ThemeSchema, type Theme } from "@mcode/contracts/models/settings";

/** Renderer-to-main channel carrying the user's theme preference. */
export const WINDOW_THEME_CHANNEL = "window:theme";

/** Dark theme `--background` (`--neutral-900`, oklch(16% 0.005 260)) as sRGB hex. */
export const DARK_WINDOW_BACKGROUND = "#0c0d0f";
/** Light theme `--background` (`--neutral-50`, oklch(99% 0.005 260)) as sRGB hex. */
export const LIGHT_WINDOW_BACKGROUND = "#fafcff";

/** Return the window background for a theme preference under the current system appearance. */
export function windowBackgroundColor(theme: Theme, systemDark: boolean): string {
  const dark = theme === "system" ? systemDark : theme === "dark";
  return dark ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND;
}

/** Read the last reported theme preference; return dark if the hint is missing, unreadable, or invalid. */
export function readWindowThemeHint(path: string): Theme {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "theme" in parsed) {
      const theme = ThemeSchema.safeParse(parsed.theme);
      if (theme.success) return theme.data;
    }
  } catch {}
  return "dark";
}

let previousWrite: Promise<void> = Promise.resolve();

/** Persist the theme preference for window creation in later launches. */
export function writeWindowThemeHint(path: string, theme: Theme): Promise<void> {
  // Writes run one at a time: overlapping renames onto one file fail on Windows (EPERM),
  // and a shared temporary file would let one write rename another's away.
  const write = previousWrite.then(() => replaceWindowThemeHint(path, theme));
  previousWrite = write.catch(() => {});
  return write;
}

async function replaceWindowThemeHint(path: string, theme: Theme): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await NodeFS.promises.writeFile(temporaryPath, JSON.stringify({ theme }), "utf8");
  await NodeFS.promises.rename(temporaryPath, path);
}
