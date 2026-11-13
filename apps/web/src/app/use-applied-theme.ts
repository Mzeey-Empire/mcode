import { useEffect } from "react";
import type { Theme } from "@mcode/contracts/models/settings";

/** localStorage key read by `public/theme-boot.js` before the first paint. */
export const THEME_STORAGE_KEY = "mcode-theme";

/**
 * After settings load, apply and cache the theme preference and report the resolved theme to the desktop host.
 * Waiting matters: until then the store holds the default ("system"), which would undo and overwrite the cache.
 */
export function useAppliedTheme(theme: Theme, loaded: boolean): void {
  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    const root = document.documentElement;
    const applyTheme = (dark: boolean) => {
      root.classList.toggle("dark", dark);
      window.desktopBridge?.reportWindowTheme?.(dark);
    };

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
