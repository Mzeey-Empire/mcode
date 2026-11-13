import { useEffect } from "react";
import type { Theme } from "@mcode/contracts/models/settings";

/** localStorage key read by `public/theme-boot.js` before the first paint. */
export const THEME_STORAGE_KEY = "mcode-theme";

/**
 * After settings load, apply, report to the desktop host, and cache the theme preference.
 * Waiting matters: until then the store holds the default ("system"), which would undo and overwrite the cache.
 */
export function useAppliedTheme(theme: Theme, loaded: boolean): void {
  useEffect(() => {
    if (!loaded) return;
    const root = document.documentElement;
    const mq = theme === "system" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    root.classList.toggle("dark", mq ? mq.matches : theme === "dark");
    window.desktopBridge?.reportWindowTheme?.(theme);
    cacheTheme(theme);
    if (!mq) return;

    const handler = (e: MediaQueryListEvent) => root.classList.toggle("dark", e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme, loaded]);
}

function cacheTheme(theme: Theme): void {
  // The cache only speeds up the next first frame; full or disabled storage must not stop the app.
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
}
