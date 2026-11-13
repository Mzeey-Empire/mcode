// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { THEME_STORAGE_KEY, useAppliedTheme } from "../use-applied-theme";

describe("useAppliedTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "dark";
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
});
