// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  SIDEBAR_WIDTH_PX,
  LAYOUT_COLUMN_GAP_PX,
  canFitInlineSidebar,
  canFitSideBySidePanel,
  minContentWidthForSideBySidePanel,
  minOuterWidthForInlineSidebar,
  OVERVIEW_CANVAS_RESERVE,
  OVERVIEW_DOCK_MIN_CANVAS,
  preferredSplitPanelWidth,
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

  it("computes inline sidebar minimum from content need and column divider", () => {
    expect(minOuterWidthForInlineSidebar(COMPOSER_MIN_WIDTH)).toBe(
      COMPOSER_MIN_WIDTH + LAYOUT_COLUMN_GAP_PX + SIDEBAR_WIDTH_PX,
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
    expect(OVERVIEW_CANVAS_RESERVE).toBe(328);
    expect(OVERVIEW_DOCK_MIN_CANVAS - OVERVIEW_CANVAS_RESERVE).toBeGreaterThanOrEqual(COMPOSER_MIN_WIDTH);
  });

  it("reports inline sidebar fit from outer-row width", () => {
    const need = minOuterWidthForInlineSidebar(COMPOSER_MIN_WIDTH);
    expect(canFitInlineSidebar(need, COMPOSER_MIN_WIDTH)).toBe(true);
    expect(canFitInlineSidebar(need - 1, COMPOSER_MIN_WIDTH)).toBe(false);
  });
});
