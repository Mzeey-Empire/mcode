import { useEffect } from "react";
import type { Theme } from "@mcode/contracts/models/settings";

/** localStorage key read by `public/theme-boot.js` before the first paint. */
export const THEME_STORAGE_KEY = "mcode-theme";

/**
 * Apply the theme preference to `<html>` and remember it for the next launch.
 * Before settings load, the store holds the default ("system"), so acting then
 * would undo the boot script's cached theme and overwrite the stored preference.
 */
export function useAppliedTheme(theme: Theme, loaded: boolean): void {
  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    const root = document.documentElement;
    const applyTheme = (dark: boolean) => root.classList.toggle("dark", dark);

    if (theme !== "system") {
      applyTheme(theme === "dark");
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    applyTheme(mq.matches);
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme, loaded]);
}
