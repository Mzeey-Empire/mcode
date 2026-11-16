import { create } from "zustand";

/** Top-level content surface displayed beside the application sidebar. */
export type PrimarySurface = "chat" | "pullRequests";

/** UI state for cross-component toggles that commands need to control. */
interface UiState {
  /** Top-level content surface displayed beside the application sidebar. */
  primarySurface: PrimarySurface;
  /** Whether the sidebar is collapsed. */
  sidebarCollapsed: boolean;
  /** Whether the shortcut help dialog is open. */
  shortcutHelpOpen: boolean;
  /**
   * Whether the right panel is maximized to fill the content area beside the
   * project tree, hiding the chat/composer. A transient view mode (not persisted):
   * the panel keeps its stored width, so toggling back restores side-by-side.
   */
  rightPanelMaximized: boolean;
  /** Whether cramped layout, not the user, maximized the right panel. */
  rightPanelMaximizedByLayout: boolean;

  /** Select the top-level content surface. */
  setPrimarySurface: (surface: PrimarySurface) => void;

  /** Toggle the docked project tree open or collapsed. */
  toggleSidebar: () => void;
  /** Open the docked project tree; the chat column narrows to make room. */
  expandSidebar: () => void;
  /** Collapse the project tree. */
  collapseSidebar: () => void;
  /** Set shortcut help dialog open state. */
  setShortcutHelpOpen: (open: boolean) => void;
  /** Toggle the right panel between maximized (full content area) and side-by-side. */
  toggleRightPanelMaximized: () => void;
  /** Set the right panel maximized state explicitly. */
  setRightPanelMaximized: (maximized: boolean, source?: "user" | "layout") => void;
}

/** Zustand store for global UI toggle state. Command palette state lives in commandPaletteStore. */
export const useUiStore = create<UiState>((set, get) => ({
  primarySurface: "chat",
  sidebarCollapsed: false,
  shortcutHelpOpen: false,
  rightPanelMaximized: false,
  rightPanelMaximizedByLayout: false,

  setPrimarySurface: (surface) =>
    set({
      primarySurface: surface,
      rightPanelMaximized: surface === "pullRequests" ? false : get().rightPanelMaximized,
      rightPanelMaximizedByLayout:
        surface === "pullRequests" ? false : get().rightPanelMaximizedByLayout,
    }),

  toggleSidebar: () => {
    if (get().sidebarCollapsed) get().expandSidebar();
    else get().collapseSidebar();
  },
  expandSidebar: () => set({ sidebarCollapsed: false }),
  collapseSidebar: () => set({ sidebarCollapsed: true }),
  setShortcutHelpOpen: (open) =>
    set({ shortcutHelpOpen: open }),
  toggleRightPanelMaximized: () =>
    set((s) => ({
      rightPanelMaximized: !s.rightPanelMaximized,
      rightPanelMaximizedByLayout: false,
    })),
  setRightPanelMaximized: (maximized, source = "user") =>
    set({
      rightPanelMaximized: maximized,
      rightPanelMaximizedByLayout: maximized && source === "layout",
    }),
}));
