import * as NodeFS from "node:fs";

/** Renderer-to-main channel carrying whether the resolved theme is dark. */
export const WINDOW_THEME_CHANNEL = "window:theme";

/** Window background before the page paints in the dark theme. */
export const DARK_WINDOW_BACKGROUND = "#0a0a0f";
/** Light theme `--background` (`--neutral-50`, oklch(99% 0.005 260)) as sRGB hex. */
export const LIGHT_WINDOW_BACKGROUND = "#fafcff";

/** Return the window background for the resolved theme. */
export function windowBackgroundColor(dark: boolean): string {
  return dark ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND;
}

/**
 * Read whether the last launch ended in a dark theme. Synchronous because the
 * window needs it at construction and the file is a few bytes. A missing or
 * invalid file means dark, the default before any theme was reported.
 */
export function readWindowThemeHint(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "dark" in parsed &&
      typeof parsed.dark === "boolean"
    ) {
      return parsed.dark;
    }
  } catch {
    // Missing or malformed: fall through to the dark default.
  }
  return true;
}

/** Persist the theme hint atomically so a crash mid-write cannot leave a torn file. */
export async function writeWindowThemeHint(path: string, dark: boolean): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await NodeFS.promises.writeFile(temporaryPath, JSON.stringify({ dark }), "utf8");
  await NodeFS.promises.rename(temporaryPath, path);
}
