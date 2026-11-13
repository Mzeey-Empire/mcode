// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("reports the resolved theme to the desktop window, following the system", () => {
    const systemScheme = new EventTarget();
    vi.spyOn(window, "matchMedia").mockReturnValue(
      Object.assign(systemScheme, { matches: true }) as unknown as MediaQueryList,
    );
    const reportWindowTheme = vi.fn();
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { reportWindowTheme },
    });

    renderHook(() => useAppliedTheme("system", true));
    systemScheme.dispatchEvent(Object.assign(new Event("change"), { matches: false }));

    expect(reportWindowTheme.mock.calls).toEqual([[true], [false]]);
  });
});
