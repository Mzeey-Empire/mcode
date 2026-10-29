import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { FrozenOrder } from "./sidebar-model";

/** Which lifecycle set the sidebar lists: active threads or completed ones. */
export type SidebarScope = "active" | "completed";

/** How the sidebar lays threads out: grouped under projects, or one flat list. */
export type SidebarView = "projects" | "threads";

interface SidebarUiState {
  readonly scope: SidebarScope;
  readonly view: SidebarView;
  readonly olderOpen: boolean;
  readonly collapsedProjects: ReadonlySet<string>;
  readonly collapsedOlderProjects: ReadonlySet<string>;
  readonly showMore: ReadonlySet<string>;
  readonly frozen: FrozenOrder | null;
}

interface SidebarUiActions {
  setScope(scope: SidebarScope): void;
  toggleView(): void;
  toggleOlder(): void;
  toggleProject(workspaceId: string, section: "recent" | "older"): void;
  toggleShowMore(workspaceId: string): void;
  freeze(snapshot: FrozenOrder): void;
  unfreeze(): void;
}

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Sidebar scope, view and section state. Only the view persists across app sessions.
 */
export const useSidebarUiStore = create<SidebarUiState & SidebarUiActions>()(
  persist(
    (set) => ({
      scope: "active",
      view: "projects",
      olderOpen: false,
      collapsedProjects: new Set(),
      collapsedOlderProjects: new Set(),
      showMore: new Set(),
      frozen: null,
      setScope: (scope) => set({ scope }),
      toggleView: () => set((state) => ({ view: state.view === "projects" ? "threads" : "projects" })),
      toggleOlder: () => set((state) => ({ olderOpen: !state.olderOpen })),
      toggleProject: (workspaceId, section) =>
        set((state) => section === "older"
          ? { collapsedOlderProjects: toggled(state.collapsedOlderProjects, workspaceId) }
          : { collapsedProjects: toggled(state.collapsedProjects, workspaceId) }),
      toggleShowMore: (workspaceId) => set((state) => ({ showMore: toggled(state.showMore, workspaceId) })),
      freeze: (snapshot) => set({ frozen: snapshot }),
      unfreeze: () => set({ frozen: null }),
    }),
    {
      name: "mcode-sidebar-ui",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ view: state.view }),
    },
  ),
);

/**
 * Returns Active when no threads are completed, otherwise the requested scope.
 */
export function effectiveSidebarScope(scope: SidebarScope, completedCount: number): SidebarScope {
  return completedCount === 0 ? "active" : scope;
}
