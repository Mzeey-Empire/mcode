import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/** Narrowest the sidebar may be dragged, from the Paper board. */
export const SIDEBAR_MIN_WIDTH = 220;
/** Widest the sidebar may be dragged, from the Paper board. */
export const SIDEBAR_MAX_WIDTH = 340;
/** Width the sidebar opens at and returns to on a double-click of the seam. */
export const SIDEBAR_DEFAULT_WIDTH = 304;
/** Pixels one arrow-key press on the focused seam moves the edge. */
export const SIDEBAR_RESIZE_STEP = 8;

/** Rounds `width` to a whole pixel inside the sidebar limits; non-finite input yields the default. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
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
}

/** User-chosen sidebar width, persisted to localStorage across reloads. */
export const useSidebarWidthStore = create<SidebarWidthState>()(
  persist(
    (set) => ({
      width: SIDEBAR_DEFAULT_WIDTH,
      setWidth: (width) => set({ width: clampSidebarWidth(width) }),
      resetWidth: () => set({ width: SIDEBAR_DEFAULT_WIDTH }),
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
