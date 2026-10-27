import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Which lifecycle set the sidebar lists: active threads or completed ones. */
export type SidebarScope = "active" | "completed";

/** How the sidebar lays threads out: grouped under projects, or one flat list. */
export type SidebarView = "projects" | "threads";

interface SidebarUiState {
  /** The scope the user picked. Read it through {@link effectiveSidebarScope}, never directly. */
  readonly scope: SidebarScope;
  readonly view: SidebarView;
}

interface SidebarUiActions {
  setScope(scope: SidebarScope): void;
  toggleView(): void;
}

/**
 * Sidebar UI state shared by every project: one global scope (transient, per app session) and the
 * persisted view. Replaces the per-project lifecycle views that lived in `uiStore`.
 */
export const useSidebarUiStore = create<SidebarUiState & SidebarUiActions>()(
  persist(
    (set) => ({
      scope: "active",
      view: "projects",
      setScope: (scope) => set({ scope }),
      toggleView: () => set((state) => ({ view: state.view === "projects" ? "threads" : "projects" })),
    }),
    {
      name: "mcode-sidebar-ui",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ view: state.view }),
    },
  ),
);

/**
 * The scope the sidebar shows. With nothing completed the scope bar is hidden, so a stored
 * Completed scope would strand the user on an empty list; it reads as Active instead.
 */
export function effectiveSidebarScope(scope: SidebarScope, completedCount: number): SidebarScope {
  return completedCount === 0 ? "active" : scope;
}
