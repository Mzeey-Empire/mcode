// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  sidebarMaxWidth,
  useSidebarWidthStore,
} from "../sidebarWidthStore";

const STORAGE_KEY = "mcode-sidebar-width";

function storeStoredWidth(width: unknown): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { width }, version: 0 }));
}

beforeEach(() => {
  setViewportWidth(WIDE_VIEWPORT);
});

afterEach(() => {
  setViewportWidth(WIDE_VIEWPORT);
  useSidebarWidthStore.getState().resetWidth();
  localStorage.removeItem(STORAGE_KEY);
});

const WIDE_VIEWPORT = 1920;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

describe("clampSidebarWidth", () => {
  it("keeps widths inside the 220 to 544 range on a wide window", () => {
    expect(clampSidebarWidth(219, WIDE_VIEWPORT)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(220, WIDE_VIEWPORT)).toBe(220);
    expect(clampSidebarWidth(340, WIDE_VIEWPORT)).toBe(340);
    expect(clampSidebarWidth(544, WIDE_VIEWPORT)).toBe(544);
    expect(clampSidebarWidth(545, WIDE_VIEWPORT)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("leaves the composer minimum for the chat column on a narrower window", () => {
    expect(sidebarMaxWidth(1440)).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebarMaxWidth(900)).toBe(420);
    expect(clampSidebarWidth(544, 900)).toBe(420);
  });

  it("never drops the limit below the minimum width on a tiny window", () => {
    expect(sidebarMaxWidth(500)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(304, 500)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("rounds fractional pointer widths to whole pixels", () => {
    expect(clampSidebarWidth(260.6)).toBe(261);
  });

  it("falls back to the default width for non-finite input", () => {
    expect(clampSidebarWidth(Number.NaN, WIDE_VIEWPORT)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, WIDE_VIEWPORT)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe("useSidebarWidthStore", () => {
  it("clamps every write", () => {
    useSidebarWidthStore.getState().setWidth(100);
    expect(useSidebarWidthStore.getState().width).toBe(220);

    useSidebarWidthStore.getState().setWidth(900);
    expect(useSidebarWidthStore.getState().width).toBe(544);
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

    expect(useSidebarWidthStore.getState().width).toBe(544);
  });

  it("loads a width saved under the old 340 limit unchanged", async () => {
    storeStoredWidth(340);

    await useSidebarWidthStore.persist.rehydrate();

    expect(useSidebarWidthStore.getState().width).toBe(340);
  });

  it("clamps a stored wide width to a narrower window on rehydrate", async () => {
    storeStoredWidth(544);
    setViewportWidth(800);

    await useSidebarWidthStore.persist.rehydrate();

    expect(useSidebarWidthStore.getState().width).toBe(320);
  });

  it("re-clamps the width when the window shrinks", () => {
    useSidebarWidthStore.getState().setWidth(520);
    setViewportWidth(900);

    useSidebarWidthStore.getState().fitToViewport();

    expect(useSidebarWidthStore.getState().width).toBe(420);
  });

  it("ignores a stored width that is not a number", async () => {
    useSidebarWidthStore.getState().setWidth(240);
    storeStoredWidth("wide");

    await useSidebarWidthStore.persist.rehydrate();

    expect(useSidebarWidthStore.getState().width).toBe(304);
  });
});
