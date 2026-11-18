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
  rightPanelMinWidth,
  rightPanelPosture,
  rightPanelPostureForPanel,
} from "@/lib/composer-layout";
import {
  COMPOSER_MIN_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_SPLIT_GAP_PX,
  RIGHT_PANEL_CONVERSATION_MIN_WIDTH,
} from "@/stores/diffStore";

describe("composer-layout", () => {
  it("docks the panel only while the tool and the conversation both keep their minimum widths", () => {
    const input = { toolMinWidth: 560, conversationMinWidth: RIGHT_PANEL_CONVERSATION_MIN_WIDTH };
    expect(rightPanelPosture({ ...input, contentRowWidth: 1080 })).toBe("docked");
    expect(rightPanelPosture({ ...input, contentRowWidth: 1079 })).toBe("floating");
  });

  it("keeps 52rem for the conversation before docking a tool", () => {
    const files = { activeTab: "files", openTabs: ["files"] };
    expect(RIGHT_PANEL_CONVERSATION_MIN_WIDTH).toBe(520);
    expect(rightPanelPostureForPanel(1000, files)).toBe("docked");
    expect(rightPanelPostureForPanel(999, files)).toBe("floating");
  });

  it("sizes the panel for its widest open tool, so switching tools keeps its width and posture", () => {
    const onFiles = { activeTab: "files", openTabs: ["files", "preview"] };
    const onBrowser = { ...onFiles, activeTab: "preview" };
    expect(rightPanelMinWidth(onFiles)).toBe(640);
    expect(rightPanelMinWidth(onBrowser)).toBe(640);
    expect(rightPanelPostureForPanel(1100, onFiles)).toBe("floating");
    expect(rightPanelPostureForPanel(1100, onBrowser)).toBe("floating");
  });

  it("floats the panel down to the narrow posture, then gives it the full surface", () => {
    const input = { toolMinWidth: 400, conversationMinWidth: 480 };
    expect(rightPanelPosture({ ...input, contentRowWidth: RIGHT_PANEL_NARROW_POSTURE_WIDTH })).toBe("floating");
    expect(rightPanelPosture({ ...input, contentRowWidth: RIGHT_PANEL_NARROW_POSTURE_WIDTH - 1 })).toBe("full-surface");
  });

  it("never floats a tool wider than the row it would float over", () => {
    const input = { toolMinWidth: 900, conversationMinWidth: 480 };
    expect(rightPanelPosture({ ...input, contentRowWidth: 900 })).toBe("floating");
    expect(rightPanelPosture({ ...input, contentRowWidth: 899 })).toBe("full-surface");
  });

  it("uses each listed tool's minimum width and never goes below the 48rem panel minimum", () => {
    const only = (tool: string) => rightPanelMinWidth({ activeTab: tool, openTabs: [tool] });
    expect(PANEL_MIN_WIDTH).toBe(480);
    expect(only("tasks")).toBe(480);
    expect(only("terminal")).toBe(480);
    expect(only("changes")).toBe(560);
    expect(only("preview")).toBe(640);
    expect(only("files")).toBe(480);
    expect(rightPanelMinWidth({ activeTab: null, openTabs: [] })).toBe(480);
  });

  it("opens the panel at half the content row by default", () => {
    expect(preferredSplitPanelWidth(2000)).toBe(1000);
  });

  it("never lets the default panel width starve the conversation", () => {
    // A 1000px row can't give half (500) and still leave the conversation its min,
    // so the panel is capped to what remains after the conversation and gap.
    const width = preferredSplitPanelWidth(1000);
    expect(width).toBe(1000 - RIGHT_PANEL_CONVERSATION_MIN_WIDTH - PANEL_SPLIT_GAP_PX);
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
