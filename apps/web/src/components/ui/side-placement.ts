import type { RefObject } from "react";

type Side = "left" | "right";

interface VirtualAnchor {
  getBoundingClientRect: () => DOMRect;
}

/** Positioner props that open a surface beside a boundary element, top-aligned to a trigger row. */
export interface SidePlacementProps {
  anchor: VirtualAnchor;
  side: Side;
  align: "start";
  sideOffset: number;
  alignOffset: (data: { side: string }) => number;
  collisionAvoidance: { side: "flip"; align: "shift"; fallbackAxisSide: "end" };
}

const SIDE_GAP_PX = 8;
const FLOATING_CARD_SELECTOR = "[data-slot='popover-content']";
const ROW_TOP_INSET_PX = 4;

/**
 * Builds Base UI positioner props for a surface opened from a row inside a floating card.
 *
 * The anchor spans the card that contains the row horizontally and the row vertically, so the
 * surface clears the card instead of covering it, and its top sits 4px above the row. Base UI
 * flips to the other side at the window edge and falls back below the row only when neither
 * side fits.
 */
export function sidePlacement(rowRef: RefObject<Element | null>, side: Side = "left"): SidePlacementProps {
  return {
    anchor: {
      getBoundingClientRect: () => {
        const row = rowRef.current;
        return sidePlacementAnchorRect(
          row?.closest(FLOATING_CARD_SELECTOR)?.getBoundingClientRect(),
          row?.getBoundingClientRect(),
        );
      },
    },
    side,
    align: "start",
    sideOffset: SIDE_GAP_PX,
    alignOffset: ({ side: placedSide }) =>
      placedSide === "left" || placedSide === "right" ? -ROW_TOP_INSET_PX : 0,
    collisionAvoidance: { side: "flip", align: "shift", fallbackAxisSide: "end" },
  };
}

/** The boundary's horizontal extent crossed with the row's vertical extent. */
export function sidePlacementAnchorRect(boundary: DOMRect | undefined, row: DOMRect | undefined): DOMRect {
  if (!row) return new DOMRect();
  if (!boundary) return row;
  return new DOMRect(boundary.left, row.top, boundary.width, row.height);
}
