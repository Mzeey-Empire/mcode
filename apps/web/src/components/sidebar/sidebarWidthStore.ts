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

/** Rounds `width` into the drag limits without regard to the window; non-finite input yields the default. */
function clampPreferredWidth(width: number): number {
  return clampSidebarWidth(width, Number.POSITIVE_INFINITY);
}

// The key stays `width` so a width saved before the preference split loads as the preference.
function readPersistedPreference(persisted: unknown): number {
  if (typeof persisted !== "object" || persisted === null || !("width" in persisted)) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  return typeof persisted.width === "number" ? clampPreferredWidth(persisted.width) : SIDEBAR_DEFAULT_WIDTH;
}

function widthState(preferredWidth: number): Pick<SidebarWidthState, "preferredWidth" | "width"> {
  return { preferredWidth, width: clampSidebarWidth(preferredWidth) };
}

interface SidebarWidthState {
  /** Width the user chose, kept apart from the window so a narrow window does not overwrite it. */
  preferredWidth: number;
  /** Displayed sidebar width in px: the preference fitted to the current window. */
  width: number;
  /** Sets the preferred width, clamped to the drag limits. */
  setWidth: (width: number) => void;
  /** Returns the preferred width to {@link SIDEBAR_DEFAULT_WIDTH}. */
  resetWidth: () => void;
  /** Refits the displayed width to the preference after the window resizes. */
  fitToViewport: () => void;
}

/** User-chosen sidebar width, persisted to localStorage across reloads. */
export const useSidebarWidthStore = create<SidebarWidthState>()(
  persist(
    (set, get) => ({
      ...widthState(SIDEBAR_DEFAULT_WIDTH),
      setWidth: (width) => set(widthState(clampPreferredWidth(width))),
      resetWidth: () => set(widthState(SIDEBAR_DEFAULT_WIDTH)),
      fitToViewport: () => {
        const width = clampSidebarWidth(get().preferredWidth);
        if (width !== get().width) set({ width });
      },
    }),
    {
      name: "mcode-sidebar-width",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ width: state.preferredWidth }),
      // Stored data is untrusted: a hand-edited or older value must not size the sidebar.
      merge: (persisted, current) => ({ ...current, ...widthState(readPersistedPreference(persisted)) }),
    },
  ),
);
