import { create } from "zustand";

/** UI state for cross-component toggles that commands need to control. */
interface UiState {
  /** Whether the sidebar is collapsed. */
  sidebarCollapsed: boolean;
  /** Whether the shortcut help dialog is open. */
  shortcutHelpOpen: boolean;

  /** Toggle sidebar collapsed state. */
  toggleSidebar: () => void;
  /** Set shortcut help dialog open state. */
  setShortcutHelpOpen: (open: boolean) => void;
}

/** Zustand store for global UI toggle state. Command palette state lives in commandPaletteStore. */
export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  shortcutHelpOpen: false,

  toggleSidebar: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setShortcutHelpOpen: (open) =>
    set({ shortcutHelpOpen: open }),
}));
