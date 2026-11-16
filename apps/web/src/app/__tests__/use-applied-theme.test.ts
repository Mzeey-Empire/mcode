// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Theme } from "@mcode/contracts/models/settings";

import { THEME_STORAGE_KEY, useAppliedTheme } from "../use-applied-theme";

describe("useAppliedTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "dark";
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "desktopBridge");
    vi.restoreAllMocks();
  });

  it("leaves the boot theme and stored preference alone until settings load", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderHook(() => useAppliedTheme("system", false));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("applies and stores the preference once settings load", () => {
    const { rerender } = renderHook(({ loaded }) => useAppliedTheme("light", loaded), {
      initialProps: { loaded: false },
    });
    rerender({ loaded: true });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("follows the system in system mode and stops following once the preference changes", () => {
    const systemScheme = mockSystemScheme(true);
    const reportWindowTheme = vi.fn();
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { reportWindowTheme },
    });

    const { rerender } = renderHook(({ theme }) => useAppliedTheme(theme, true), {
      initialProps: { theme: "system" as Theme },
    });
    systemScheme.dispatchEvent(Object.assign(new Event("change"), { matches: false }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    rerender({ theme: "dark" });
    systemScheme.dispatchEvent(Object.assign(new Event("change"), { matches: false }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(reportWindowTheme.mock.calls).toEqual([["system"], ["dark"]]);
  });

  it("still applies the theme when storage rejects the cache write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    renderHook(() => useAppliedTheme("light", true));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

function mockSystemScheme(dark: boolean): EventTarget {
  const systemScheme = new EventTarget();
  vi.spyOn(window, "matchMedia").mockReturnValue(
    Object.assign(systemScheme, { matches: dark }) as unknown as MediaQueryList,
  );
  return systemScheme;
}
