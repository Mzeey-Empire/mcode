// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  useSidebarWidthStore,
} from "../sidebarWidthStore";

const STORAGE_KEY = "mcode-sidebar-width";

function storeStoredWidth(width: unknown): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { width }, version: 0 }));
}

afterEach(() => {
  useSidebarWidthStore.getState().resetWidth();
  localStorage.removeItem(STORAGE_KEY);
});

describe("clampSidebarWidth", () => {
  it("keeps widths inside the 220 to 340 range", () => {
    expect(clampSidebarWidth(219)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(220)).toBe(220);
    expect(clampSidebarWidth(340)).toBe(340);
    expect(clampSidebarWidth(341)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("rounds fractional pointer widths to whole pixels", () => {
    expect(clampSidebarWidth(260.6)).toBe(261);
  });

  it("falls back to the default width for non-finite input", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe("useSidebarWidthStore", () => {
  it("clamps every write", () => {
    useSidebarWidthStore.getState().setWidth(100);
    expect(useSidebarWidthStore.getState().width).toBe(220);

    useSidebarWidthStore.getState().setWidth(900);
    expect(useSidebarWidthStore.getState().width).toBe(340);
  });

  it("persists the width to localStorage", () => {
    useSidebarWidthStore.getState().setWidth(256);

    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    expect(stored).toMatchObject({ state: { width: 256 } });
  });

  it("restores a stored width on rehydrate", async () => {
    storeStoredWidth(280);

    await useSidebarWidthStore.persist.rehydrate();

    expect(useSidebarWidthStore.getState().width).toBe(280);
  });

  it("clamps an out-of-range stored width on rehydrate", async () => {
    storeStoredWidth(9000);

    await useSidebarWidthStore.persist.rehydrate();

    expect(useSidebarWidthStore.getState().width).toBe(340);
  });

  it("ignores a stored width that is not a number", async () => {
    useSidebarWidthStore.getState().setWidth(240);
    storeStoredWidth("wide");

    await useSidebarWidthStore.persist.rehydrate();

    expect(useSidebarWidthStore.getState().width).toBe(304);
  });
});
