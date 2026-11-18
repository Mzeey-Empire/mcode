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

// A row whose thread menu is open keeps the fill, so the user can see which thread the menu acts on.
const MENU_OPEN_ROW = `[${HOVER_ROW_ATTRIBUTE}][data-menu-open]`;

function hoverRowAt(target: EventTarget | Element | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest<HTMLElement>(`[${HOVER_ROW_ATTRIBUTE}]`);
  // A closing row is inert and no longer takes hover.
  return row && !row.closest("[inert]") ? row : null;
}

/**
 * One hover fill per list that glides between rows. It is positioned imperatively from pointer
 * events, so hovering never re-renders React, and its layer sits first in the scroll content so
 * rows paint over it and a selected row's opaque fill covers it as it did the old per-row hover.
 */
export class HoverGlide {
  readonly element: HTMLDivElement;
  private readonly layer: HTMLDivElement;
  private row: HTMLElement | null = null;
  private box: HighlightBox | null = null;
  private pointer: { x: number; y: number } | null = null;
  private readonly detachLayout: () => void;
  private readonly menuObserver: MutationObserver;

  constructor(
    private readonly scroller: HTMLElement,
    private readonly content: HTMLElement,
    onLayout: (listener: () => void) => () => void,
  ) {
    // The fill keeps its last box while hidden. Clipping it to a layer that exactly fills the
    // content means no box it holds can add scroll space, whether or not a fade ever ran. The layer
    // has no data-index, so the virtual list's recycling leaves it alone.
    this.layer = document.createElement("div");
    this.layer.setAttribute("aria-hidden", "true");
    this.layer.style.cssText = "position:absolute;top:0;right:0;bottom:0;left:0;overflow:hidden;pointer-events:none";
    this.element = document.createElement("div");
    this.element.dataset.testid = "sidebar-hover-highlight";
    this.element.className = "absolute top-0 left-0 rounded-lg bg-selected/40";
    this.element.style.opacity = "0";
    this.layer.append(this.element);
    content.prepend(this.layer);
    scroller.addEventListener("pointermove", this.onPointerMove, { passive: true });
    scroller.addEventListener("pointerleave", this.onPointerLeave, { passive: true });
    // Layout listeners run a frame late; scroll events land before paint, so a wheel never shows
    // the fill on the row that just scrolled out from under the pointer.
    scroller.addEventListener("scroll", this.onLayout, { passive: true });
    this.detachLayout = onLayout(this.onLayout);
    this.menuObserver = new MutationObserver(this.onMenuChange);
    this.menuObserver.observe(content, { subtree: true, attributeFilter: ["data-menu-open"] });
  }

  destroy(): void {
    this.scroller.removeEventListener("pointermove", this.onPointerMove);
    this.scroller.removeEventListener("pointerleave", this.onPointerLeave);
    this.scroller.removeEventListener("scroll", this.onLayout);
    this.detachLayout();
    this.menuObserver.disconnect();
    this.layer.remove();
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === "touch") return;
    this.pointer = { x: event.clientX, y: event.clientY };
    const row = this.menuRow() ?? hoverRowAt(event.target);
    if (row !== this.row) this.moveTo(row, this.row ? "glide" : "appear");
  };

  private readonly onPointerLeave = (): void => {
    this.pointer = null;
    this.moveTo(this.menuRow(), "appear");
  };

  // Scrolling, collapsing or a row folding away moves rows under a still pointer; follow the row
  // now under it without a slide so the fill never trails or strands on empty space.
  private readonly onLayout = (): void => {
    const held = this.menuRow();
    if (!this.pointer && !held) return;
    const row = held ?? (this.pointer ? hoverRowAt(document.elementFromPoint(this.pointer.x, this.pointer.y)) : null);
    this.moveTo(row, this.row ? "snap" : "appear");
  };

  // A menu opening holds the fill on its row; closing returns it to the row under the pointer.
  private readonly onMenuChange = (): void => {
    const row = this.menuRow() ?? (this.pointer ? hoverRowAt(document.elementFromPoint(this.pointer.x, this.pointer.y)) : null);
    if (row !== this.row) this.moveTo(row, this.row && row ? "glide" : "appear");
  };

  private menuRow(): HTMLElement | null {
    return this.content.querySelector<HTMLElement>(MENU_OPEN_ROW);
  }

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

  private hide(): void {
    if (!this.row) return;
    this.row = null;
    this.box = null;
    this.element.style.transition = prefersReducedMotion() ? "none" : FADE;
    this.element.style.opacity = "0";
  }
}
