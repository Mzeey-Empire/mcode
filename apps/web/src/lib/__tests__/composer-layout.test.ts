// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  canFitSideBySidePanel,
  minContentWidthForSideBySidePanel,
  OVERVIEW_CANVAS_RESERVE,
  OVERVIEW_CANVAS_RESERVE_CSS,
  OVERVIEW_DOCK_MIN_CANVAS,
  overviewCanvasReserve,
  preferredSplitPanelWidth,
  READING_RAIL_WIDTH,
} from "@/lib/composer-layout";
import { COMPOSER_MIN_WIDTH, PANEL_MIN_WIDTH, PANEL_SPLIT_GAP_PX } from "@/stores/diffStore";

describe("composer-layout", () => {
  it("computes side-by-side minimum from composer, divider, and panel width", () => {
    expect(minContentWidthForSideBySidePanel(440)).toBe(
      COMPOSER_MIN_WIDTH + PANEL_SPLIT_GAP_PX + 440,
    );
    expect(minContentWidthForSideBySidePanel(100)).toBe(
      COMPOSER_MIN_WIDTH + PANEL_SPLIT_GAP_PX + PANEL_MIN_WIDTH,
    );
  });

  it("reports side-by-side fit from content-row width", () => {
    const need = minContentWidthForSideBySidePanel(440);
    expect(canFitSideBySidePanel(need, 440)).toBe(true);
    expect(canFitSideBySidePanel(need - 1, 440)).toBe(false);
  });

  it("opens the panel at half the content row by default", () => {
    expect(preferredSplitPanelWidth(2000)).toBe(1000);
  });

  it("never lets the default panel width starve the composer", () => {
    // A 900px row can't give half (450) and still leave the composer its min,
    // so the panel is capped to what remains after the composer and gap.
    const width = preferredSplitPanelWidth(900);
    expect(width).toBe(900 - COMPOSER_MIN_WIDTH - PANEL_SPLIT_GAP_PX);
    expect(width).toBeGreaterThanOrEqual(PANEL_MIN_WIDTH);
  });

  it("clamps the default panel width to the panel minimum on narrow rows", () => {
    expect(preferredSplitPanelWidth(600)).toBe(PANEL_MIN_WIDTH);
  });

  it("docks the Overview only where the composer keeps its minimum width beside the reserve", () => {
    expect(OVERVIEW_DOCK_MIN_CANVAS - overviewCanvasReserve(OVERVIEW_DOCK_MIN_CANVAS)).toBeGreaterThanOrEqual(COMPOSER_MIN_WIDTH);
  });

  it("keeps the reading rail centred beside the docked Overview until it would reach the card's column", () => {
    const railRight = (canvas: number) => (canvas - overviewCanvasReserve(canvas) + READING_RAIL_WIDTH) / 2;
    expect(overviewCanvasReserve(2000)).toBe(0);
    for (const canvas of [1232, 1300, 1416]) {
      expect(railRight(canvas), `${canvas}px canvas`).toBe(canvas - OVERVIEW_CANVAS_RESERVE);
    }
    expect(overviewCanvasReserve(OVERVIEW_DOCK_MIN_CANVAS)).toBe(OVERVIEW_CANVAS_RESERVE);
  });

  it("resolves the conversation's CSS reserve to the width the toast lane computes", () => {
    const probe = document.createElement("div");
    for (const canvas of [OVERVIEW_DOCK_MIN_CANVAS, 1088, 1232, 1300, 1416, 2000]) {
      probe.style.paddingRight = OVERVIEW_CANVAS_RESERVE_CSS.replace("var(--container-reading)", `${READING_RAIL_WIDTH}px`).replace("100cqw", `${canvas}px`);
      expect(probe.style.paddingRight, `${canvas}px canvas`).toBe(`calc(${overviewCanvasReserve(canvas)}px)`);
    }
  });

});
