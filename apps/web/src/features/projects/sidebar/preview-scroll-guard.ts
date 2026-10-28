import { createContext } from "react";

/** How long the list must stay still after its last scroll event before hover may open a preview. */
export const PREVIEW_SCROLL_SETTLE_MS = 150;

interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Keeps hover previews shut while the sidebar scrolls. Rows slide under a resting pointer during a
 * scroll, and each one they pass fires a hover that would mount and position a preview. A scroll
 * closes previews that hover opened and rejects new hover opens until the list settles and the
 * pointer itself moves. Focus opens are never blocked, so keyboard previews keep working.
 */
export class PreviewScrollGuard {
  private blocked = false;
  private settled = true;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private pointer: PointerPoint | undefined;
  private pointerAtScroll: PointerPoint | undefined;
  private readonly hoverOpenClosers = new Set<() => void>();

  /** Listens to the scroller and the pointer. Returns a function that removes every listener. */
  attach(scroller: HTMLElement): () => void {
    const ownerWindow = scroller.ownerDocument.defaultView ?? window;
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    scroller.addEventListener("wheel", this.onScroll, { passive: true });
    scroller.addEventListener("touchstart", this.onScroll, { passive: true });
    ownerWindow.addEventListener("pointermove", this.onPointerMove, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", this.onScroll);
      scroller.removeEventListener("wheel", this.onScroll);
      scroller.removeEventListener("touchstart", this.onScroll);
      ownerWindow.removeEventListener("pointermove", this.onPointerMove);
      clearTimeout(this.settleTimer);
    };
  }

  /** Whether a preview may open for a Base UI open-change reason. */
  allowsOpen(reason: string): boolean {
    return reason !== "trigger-hover" || !this.blocked;
  }

  /** Registers a close callback for a preview that hover opened. Returns the unregister function. */
  trackHoverOpen(close: () => void): () => void {
    this.hoverOpenClosers.add(close);
    return () => this.hoverOpenClosers.delete(close);
  }

  private readonly onScroll = (): void => {
    if (!this.blocked) {
      this.blocked = true;
      for (const close of this.hoverOpenClosers) close();
      this.hoverOpenClosers.clear();
    }
    this.settled = false;
    this.pointerAtScroll = this.pointer;
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settled = true;
    }, PREVIEW_SCROLL_SETTLE_MS);
  };

  // Chromium sends a synthetic pointer move after a scroll with the pointer where it was, so only
  // a move to a new position counts as the user moving the pointer.
  private readonly onPointerMove = (event: PointerEvent): void => {
    const point = { x: event.clientX, y: event.clientY };
    this.pointer = point;
    if (!this.blocked || !this.settled) return;
    const anchor = this.pointerAtScroll;
    if (anchor && anchor.x === point.x && anchor.y === point.y) return;
    this.blocked = false;
  };
}

/** The sidebar list's guard. Null outside a list, where nothing scrolls the rows. */
export const PreviewScrollGuardContext = createContext<PreviewScrollGuard | null>(null);
