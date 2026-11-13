// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { THEME_STORAGE_KEY } from "../use-applied-theme";

const BOOT_SCRIPT = "../../../public/theme-boot.js";

async function runBootScript(systemDark: boolean): Promise<void> {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) => ({ matches: systemDark, media: query }) as MediaQueryList,
  );
  vi.resetModules();
  await import(/* @vite-ignore */ BOOT_SCRIPT);
}

describe("theme boot script", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "dark";
  });
  afterEach(() => vi.restoreAllMocks());

  it("paints dark with no cached preference", async () => {
    document.documentElement.className = "";
    await runBootScript(false);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("paints light for a cached light preference", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    await runBootScript(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("paints dark for a cached dark preference on a light system", async () => {
    document.documentElement.className = "";
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    await runBootScript(false);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it.each([
    [true, true],
    [false, false],
  ])("follows the system for a cached system preference (system dark: %s)", async (systemDark, dark) => {
    localStorage.setItem(THEME_STORAGE_KEY, "system");
    await runBootScript(systemDark);
    expect(document.documentElement.classList.contains("dark")).toBe(dark);
  });
});
