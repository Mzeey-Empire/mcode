import { prefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/** Marks a sidebar row whose hover fill the shared highlight draws. */
export const HOVER_ROW_ATTRIBUTE = "data-sidebar-hover-row";
/** Spread onto a row element so the list's highlight can land on it. */
export const HOVER_ROW_PROPS = { [HOVER_ROW_ATTRIBUTE]: "" } as const;

/** A row's border box in the scroll content's coordinates, so the highlight scrolls with it. */
export interface HighlightBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/**
 * How the highlight reaches a row. `glide` slides from the previous row, `appear` fades in on the
 * row with no slide, and `snap` follows a row that moved under a still pointer (scroll, collapse).
 */
export type HighlightMove = "glide" | "appear" | "snap";

/** Converts a row's viewport rect into the content's coordinates. */
export function rowBoxInContent(row: DOMRectReadOnly, content: DOMRectReadOnly): HighlightBox {
  return { top: row.top - content.top, left: row.left - content.left, width: row.width, height: row.height };
}

const FADE = "opacity var(--duration-fast) var(--ease-standard)";
// x rides in the transform with y, so moving between a project header and an indented thread row
// slides sideways instead of snapping, and width glides with height for the same reason.
const GLIDE = `transform var(--duration-fast) var(--ease-standard), width var(--duration-fast) var(--ease-standard), height var(--duration-fast) var(--ease-standard), ${FADE}`;

function moveTransition(move: HighlightMove, reducedMotion: boolean): string {
  if (reducedMotion || move === "snap") return "none";
  return move === "glide" ? GLIDE : FADE;
}

/** Inline style that places the highlight on `box`; reduced motion makes every move instant. */
export function highlightStyle(box: HighlightBox, move: HighlightMove, reducedMotion: boolean) {
  return {
    transform: `translate(${box.left}px, ${box.top}px)`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    opacity: "1",
    transition: moveTransition(move, reducedMotion),
  };
}

function sameBox(a: HighlightBox | null, b: HighlightBox): boolean {
  return a !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

function hoverRowAt(target: EventTarget | Element | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest<HTMLElement>(`[${HOVER_ROW_ATTRIBUTE}]`);
  // A closing row is inert and no longer takes hover.
  return row && !row.closest("[inert]") ? row : null;
}

/**
 * One hover fill per list that glides between rows. It is positioned imperatively from pointer
 * events, so hovering never re-renders React, and it sits first in the scroll content so rows
 * paint over it and a selected row's opaque fill covers it as it did the old per-row hover.
 */
export class HoverGlide {
  readonly element: HTMLDivElement;
  private row: HTMLElement | null = null;
  private box: HighlightBox | null = null;
  private pointer: { x: number; y: number } | null = null;
  private readonly detachLayout: () => void;

  constructor(
    private readonly scroller: HTMLElement,
    private readonly content: HTMLElement,
    onLayout: (listener: () => void) => () => void,
  ) {
    this.element = document.createElement("div");
    this.element.setAttribute("aria-hidden", "true");
    this.element.dataset.testid = "sidebar-hover-highlight";
    this.element.className = "pointer-events-none absolute top-0 left-0 rounded-lg bg-selected/40";
    this.element.style.opacity = "0";
    content.prepend(this.element);
    this.element.addEventListener("transitionend", this.onTransitionEnd);
    scroller.addEventListener("pointermove", this.onPointerMove, { passive: true });
    scroller.addEventListener("pointerleave", this.onPointerLeave, { passive: true });
    // Layout listeners run a frame late; scroll events land before paint, so a wheel never shows
    // the fill on the row that just scrolled out from under the pointer.
    scroller.addEventListener("scroll", this.onLayout, { passive: true });
    this.detachLayout = onLayout(this.onLayout);
  }

  destroy(): void {
    this.element.removeEventListener("transitionend", this.onTransitionEnd);
    this.scroller.removeEventListener("pointermove", this.onPointerMove);
    this.scroller.removeEventListener("pointerleave", this.onPointerLeave);
    this.scroller.removeEventListener("scroll", this.onLayout);
    this.detachLayout();
    this.element.remove();
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === "touch") return;
    this.pointer = { x: event.clientX, y: event.clientY };
    const row = hoverRowAt(event.target);
    if (row !== this.row) this.moveTo(row, this.row ? "glide" : "appear");
  };

  private readonly onPointerLeave = (): void => {
    this.pointer = null;
    this.moveTo(null, "appear");
  };

  // Scrolling, collapsing or a row folding away moves rows under a still pointer; follow the row
  // now under it without a slide so the fill never trails or strands on empty space.
  private readonly onLayout = (): void => {
    if (!this.pointer) return;
    const row = hoverRowAt(document.elementFromPoint(this.pointer.x, this.pointer.y));
    this.moveTo(row, this.row ? "snap" : "appear");
  };

  private moveTo(row: HTMLElement | null, move: HighlightMove): void {
    if (!row) {
      this.hide();
      return;
    }
    const box = rowBoxInContent(row.getBoundingClientRect(), this.content.getBoundingClientRect());
    if (row === this.row && sameBox(this.box, box)) return;
    if (row !== this.row) this.element.style.borderRadius = getComputedStyle(row).borderRadius;
    this.row = row;
    this.box = box;
    Object.assign(this.element.style, highlightStyle(box, move, prefersReducedMotion()));
  }

  private readonly onTransitionEnd = (event: TransitionEvent): void => {
    if (event.propertyName === "opacity" && !this.row) this.collapse();
  };

  private hide(): void {
    if (!this.row) return;
    this.row = null;
    this.box = null;
    const reducedMotion = prefersReducedMotion();
    this.element.style.transition = reducedMotion ? "none" : FADE;
    this.element.style.opacity = "0";
    if (reducedMotion) this.collapse();
  }

  // An invisible fill still counts toward the scroller's overflow, so once it has faded it drops
  // its box: a list that then gets shorter, or a narrower sidebar, keeps no blank scroll space.
  // The next show is an `appear`, which fades opacity only, so the box jumps into place unseen.
  private collapse(): void {
    Object.assign(this.element.style, { transform: "none", width: "0px", height: "0px" });
  }
}
