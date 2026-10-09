import {
  COMPOSER_MIN_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_SPLIT_GAP_PX,
} from "@/stores/diffStore";
import { useLayoutStore } from "@/stores/layoutStore";

/** Inline project-tree width in px; mirrors `--container-sidebar` (`w-sidebar`) in index.css. */
export const SIDEBAR_WIDTH_PX = 304;

/** Gap between the project tree and the chat/panel row in App.tsx. */
export const LAYOUT_COLUMN_GAP_PX = 0;

/** Live measurements from App layout refs; updated by {@link setLayoutMeasurements}. */
let measuredContentRowWidth = 0;
let measuredOuterRowWidth = 0;

/**
 * Publishes the current content-row and outer-row widths for layout decisions
 * outside React render (panel open, sidebar expand).
 */
export function setLayoutMeasurements(contentRowWidth: number, outerRowWidth: number): void {
  measuredContentRowWidth = contentRowWidth;
  measuredOuterRowWidth = outerRowWidth;
  useLayoutStore.getState().setContentRowWidth(contentRowWidth);
}

/** Width of the chat + right-panel split row, or a conservative fallback before mount. */
export function getContentRowWidth(): number {
  if (measuredContentRowWidth > 0) return measuredContentRowWidth;
  return Math.max(COMPOSER_MIN_WIDTH, window.innerWidth - SIDEBAR_WIDTH_PX);
}

/** Width of the row that may include an inline project tree, or a fallback before mount. */
export function getOuterRowWidth(): number {
  if (measuredOuterRowWidth > 0) return measuredOuterRowWidth;
  return window.innerWidth;
}

/**
 * Minimum content-row width for composer + inline panel at the given stored width.
 */
export function minContentWidthForSideBySidePanel(panelWidth: number): number {
  return COMPOSER_MIN_WIDTH + PANEL_SPLIT_GAP_PX + Math.max(PANEL_MIN_WIDTH, panelWidth);
}

/**
 * Minimum outer-row width to dock the project tree inline while reserving
 * `contentNeed` pixels for the chat/panel row.
 */
export function minOuterWidthForInlineSidebar(contentNeed: number): number {
  return contentNeed + LAYOUT_COLUMN_GAP_PX + SIDEBAR_WIDTH_PX;
}

/** Whether the content row can host composer and an inline panel side by side. */
export function canFitSideBySidePanel(contentRowWidth: number, panelWidth: number): boolean {
  return contentRowWidth >= minContentWidthForSideBySidePanel(panelWidth);
}

/**
 * Preferred panel width when it first opens: a fraction (default half) of the
 * content row, clamped so the panel never drops below its minimum and always
 * leaves the composer its minimum width. Lets the panel open to ~50% of the
 * thread view instead of a fixed size, while still degrading to a sane width on
 * narrow viewports.
 */
export function preferredSplitPanelWidth(contentRowWidth: number, fraction = 0.5): number {
  const target = Math.round(contentRowWidth * fraction);
  const max = Math.max(PANEL_MIN_WIDTH, contentRowWidth - COMPOSER_MIN_WIDTH - PANEL_SPLIT_GAP_PX);
  return Math.max(PANEL_MIN_WIDTH, Math.min(target, max));
}

/** Overview card width, from the Paper board. */
export const OVERVIEW_CARD_WIDTH = 280;

/** Overview card offset from the top of the chat canvas, clearing the header. */
export const OVERVIEW_CARD_TOP = 56;

/** Overview card offset from the right edge of the chat canvas. */
export const OVERVIEW_CARD_INSET = 16;

/** Right padding the conversation reserves while the card is docked, from the Paper board. */
export const OVERVIEW_CANVAS_RESERVE = 328;

/** Narrowest chat canvas that docks the card and still leaves the composer its minimum width. */
export const OVERVIEW_DOCK_MIN_CANVAS = 896;

/** Whether the project tree can dock inline beside a content row of `contentNeed` px. */
export function canFitInlineSidebar(outerRowWidth: number, contentNeed: number): boolean {
  return outerRowWidth >= minOuterWidthForInlineSidebar(contentNeed);
}
