import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { FrozenOrder } from "./sidebar-model";

/** Which lifecycle set the sidebar lists: active threads or completed ones. */
export type SidebarScope = "active" | "completed";

/** How the sidebar lays threads out: grouped under projects, or one flat list. */
export type SidebarView = "projects" | "threads";

interface SidebarUiState {
  /** The scope the user picked. Read it through {@link effectiveSidebarScope}, never directly. */
  readonly scope: SidebarScope;
  readonly view: SidebarView;
  readonly olderOpen: boolean;
  readonly collapsedProjects: ReadonlySet<string>;
  readonly collapsedOlderProjects: ReadonlySet<string>;
  readonly showMore: ReadonlySet<string>;
  /** Set while the pointer is inside the list, so reorders wait until it leaves. */
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
 * Sidebar UI state the model reads: one global scope (transient, per app session), the persisted
 * view, and the open and collapsed sections. Replaces the per-project lifecycle views that lived
 * in `uiStore`.
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
 * The scope the sidebar shows. With nothing completed the scope bar is hidden, so a stored
 * Completed scope would strand the user on an empty list; it reads as Active instead.
 */
export function effectiveSidebarScope(scope: SidebarScope, completedCount: number): SidebarScope {
  return completedCount === 0 ? "active" : scope;
}
