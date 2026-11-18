// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  OVERVIEW_CANVAS_RESERVE,
  OVERVIEW_CANVAS_RESERVE_CSS,
  OVERVIEW_DOCK_MIN_CANVAS,
  overviewCanvasReserve,
  preferredSplitPanelWidth,
  READING_RAIL_WIDTH,
  RIGHT_PANEL_NARROW_POSTURE_WIDTH,
  rightPanelPosture,
} from "@/lib/composer-layout";
import { COMPOSER_MIN_WIDTH, PANEL_MIN_WIDTH, PANEL_SPLIT_GAP_PX } from "@/stores/diffStore";

describe("composer-layout", () => {
  it("docks the panel beside the conversation in the default window with the sidebar open", () => {
    // 1200px window minus the 304px sidebar. A floating panel here would cover the composer's send button.
    expect(rightPanelPosture(1200 - 304)).toBe("docked");
  });

  it("docks the panel only while the composer and the panel both keep their minimum widths", () => {
    const docked = COMPOSER_MIN_WIDTH + PANEL_SPLIT_GAP_PX + PANEL_MIN_WIDTH;
    expect(rightPanelPosture(docked)).toBe("docked");
    expect(rightPanelPosture(docked - 1)).toBe("floating");
  });

  it("floats the panel down to the narrow posture, then gives it the full surface", () => {
    expect(rightPanelPosture(RIGHT_PANEL_NARROW_POSTURE_WIDTH)).toBe("floating");
    expect(rightPanelPosture(RIGHT_PANEL_NARROW_POSTURE_WIDTH - 1)).toBe("full-surface");
  });

  it("opens the panel at half the content row by default", () => {
    expect(preferredSplitPanelWidth(2000)).toBe(1000);
  });

  it("never lets the default panel width starve the conversation", () => {
    // A 896px row can't give half (448) and still leave the composer its min,
    // so the panel is capped to what remains after the composer and gap.
    const width = preferredSplitPanelWidth(896);
    expect(width).toBe(896 - COMPOSER_MIN_WIDTH - PANEL_SPLIT_GAP_PX);
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
