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

/** Read the last reported resolved theme; return dark if the hint is missing, unreadable, or invalid. */
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
  } catch {}
  return true;
}

let previousWrite: Promise<void> = Promise.resolve();

/** Persist the resolved theme hint for subsequent window creation. */
export function writeWindowThemeHint(path: string, dark: boolean): Promise<void> {
  // Writes run one at a time: overlapping renames onto one file fail on Windows (EPERM),
  // and a shared temporary file would let one write rename another's away.
  const write = previousWrite.then(() => replaceWindowThemeHint(path, dark));
  previousWrite = write.catch(() => {});
  return write;
}

async function replaceWindowThemeHint(path: string, dark: boolean): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await NodeFS.promises.writeFile(temporaryPath, JSON.stringify({ dark }), "utf8");
  await NodeFS.promises.rename(temporaryPath, path);
}
