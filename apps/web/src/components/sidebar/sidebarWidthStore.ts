import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { COMPOSER_MIN_WIDTH } from "@/stores/diffStore";

/** Narrowest the sidebar may be dragged, from the Paper board. */
export const SIDEBAR_MIN_WIDTH = 220;
/**
 * Widest the sidebar may be dragged on a large window. A 1440px window minus
 * this leaves 896px, the canvas width the thread overview needs to stay docked.
 */
export const SIDEBAR_MAX_WIDTH = 544;
/** Width the sidebar opens at and returns to on a double-click of the seam. */
export const SIDEBAR_DEFAULT_WIDTH = 304;
/** Pixels one arrow-key press on the focused seam moves the edge. */
export const SIDEBAR_RESIZE_STEP = 8;

/**
 * Widest the sidebar may be in a window `viewportWidth` px wide. The layout
 * guard floats the sidebar once the chat column drops below the composer
 * minimum, so a wider drag would make the sidebar jump out of the dock.
 */
export function sidebarMaxWidth(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - COMPOSER_MIN_WIDTH));
}

/** Rounds `width` to a whole pixel inside the sidebar limits for the window; non-finite input yields the default. */
export function clampSidebarWidth(width: number, viewportWidth: number = window.innerWidth): number {
  const max = sidebarMaxWidth(viewportWidth);
  if (!Number.isFinite(width)) return Math.min(SIDEBAR_DEFAULT_WIDTH, max);
  return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function readPersistedWidth(persisted: unknown): number {
  if (typeof persisted !== "object" || persisted === null || !("width" in persisted)) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  return typeof persisted.width === "number" ? clampSidebarWidth(persisted.width) : SIDEBAR_DEFAULT_WIDTH;
}

interface SidebarWidthState {
  /** Current sidebar width in px, always inside the limits. */
  width: number;
  /** Sets the width, clamped to the limits. */
  setWidth: (width: number) => void;
  /** Returns the width to {@link SIDEBAR_DEFAULT_WIDTH}. */
  resetWidth: () => void;
  /** Re-clamps the current width after the window resizes. */
  fitToViewport: () => void;
}

/** User-chosen sidebar width, persisted to localStorage across reloads. */
export const useSidebarWidthStore = create<SidebarWidthState>()(
  persist(
    (set, get) => ({
      width: SIDEBAR_DEFAULT_WIDTH,
      setWidth: (width) => set({ width: clampSidebarWidth(width) }),
      resetWidth: () => set({ width: clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH) }),
      fitToViewport: () => {
        const width = clampSidebarWidth(get().width);
        if (width !== get().width) set({ width });
      },
    }),
    {
      name: "mcode-sidebar-width",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ width: state.width }),
      // Stored data is untrusted: a hand-edited or older value must not size the sidebar.
      merge: (persisted, current) => ({ ...current, width: readPersistedWidth(persisted) }),
    },
  ),
);
