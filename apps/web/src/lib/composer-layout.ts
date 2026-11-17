import { COMPOSER_MIN_WIDTH, PANEL_MIN_WIDTH, PANEL_SPLIT_GAP_PX } from "@/stores/diffStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useSidebarWidthStore } from "@/components/sidebar/sidebarWidthStore";

/** Live measurements from App layout refs; updated by {@link setLayoutMeasurements}. */
let measuredContentRowWidth = 0;

/** Publishes the current content-row width for layout decisions outside React render (panel open). */
export function setLayoutMeasurements(contentRowWidth: number): void {
  measuredContentRowWidth = contentRowWidth;
  useLayoutStore.getState().setContentRowWidth(contentRowWidth);
}

/** Width of the chat + right-panel split row, or a conservative fallback before mount. */
export function getContentRowWidth(): number {
  if (measuredContentRowWidth > 0) return measuredContentRowWidth;
  return Math.max(COMPOSER_MIN_WIDTH, window.innerWidth - useSidebarWidthStore.getState().width);
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

/**
 * Narrowest content row that still shows the conversation beside a floating panel. Below it, one primary surface
 * shows at a time.
 */
export const RIGHT_PANEL_NARROW_POSTURE_WIDTH = 760;

/** Narrowest content row that docks the panel and still leaves the composer its minimum width. */
const DOCKED_PANEL_MIN_CONTENT_WIDTH = COMPOSER_MIN_WIDTH + PANEL_SPLIT_GAP_PX + PANEL_MIN_WIDTH;

/**
 * How the right panel sits beside the conversation. `docked` shares the content row, `floating` overlays the
 * conversation's right edge and leaves its width alone, and `full-surface` replaces the conversation.
 */
export type RightPanelPosture = "docked" | "floating" | "full-surface";

/**
 * Picks the panel's posture from the content row's width: dock while the composer and the panel both keep their
 * minimum widths, float rather than squeeze either one, and take the full surface only when the row is too narrow
 * to show both.
 */
export function rightPanelPosture(contentRowWidth: number): RightPanelPosture {
  if (contentRowWidth >= DOCKED_PANEL_MIN_CONTENT_WIDTH) return "docked";
  if (contentRowWidth >= RIGHT_PANEL_NARROW_POSTURE_WIDTH) return "floating";
  return "full-surface";
}

/** Overview card width, from the Paper board. */
export const OVERVIEW_CARD_WIDTH = 280;

/** Overview card offset from the top of the chat canvas, clearing the header. */
export const OVERVIEW_CARD_TOP = 56;

/** Overview card offset from the right edge of the chat canvas. */
export const OVERVIEW_CARD_INSET = 16;

/** The docked card's column at the canvas's right edge, card and gap, from the Paper board. */
export const OVERVIEW_CANVAS_RESERVE = 328;

/** The reading rail's width in px: `--container-reading` (76rem) at the app's 10px root. */
export const READING_RAIL_WIDTH = 760;

/**
 * Right padding the conversation takes beside the docked card. It is zero while the centred reading rail clears the
 * card's column, and otherwise just enough to pull the rail's right edge out of it. Padding moves a centred rail by
 * half its width, hence twice the column.
 */
export function overviewCanvasReserve(canvasWidth: number): number {
  const needed = READING_RAIL_WIDTH + 2 * OVERVIEW_CANVAS_RESERVE - canvasWidth;
  return Math.min(OVERVIEW_CANVAS_RESERVE, Math.max(0, needed));
}

/**
 * {@link overviewCanvasReserve} as CSS, for an element inside a canvas marked `@container` so `100cqw` is the canvas
 * width. Layout resolves it in the frame the canvas resizes. A reserve computed from a measured width lands a frame
 * late and slides the composer under the card while the sidebar animates.
 */
export const OVERVIEW_CANVAS_RESERVE_CSS = `clamp(0px, calc(var(--container-reading) + ${2 * OVERVIEW_CANVAS_RESERVE}px - 100cqw), ${OVERVIEW_CANVAS_RESERVE}px)`;

/** Narrowest chat canvas that docks the card and still leaves the composer its minimum width. */
export const OVERVIEW_DOCK_MIN_CANVAS = 896;
