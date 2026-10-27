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
  /** Projects open in the recent list. Projects start collapsed, as they always have. */
  readonly expandedProjects: ReadonlySet<string>;
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

interface PersistedSidebarUi {
  readonly view?: SidebarView;
  readonly expandedProjects?: readonly string[];
  readonly showMore?: readonly string[];
}

// Keys the per-project tree wrote before this store existed, read once so an upgrade keeps the
// user's open projects and Show more choices.
const LEGACY_EXPANDED_KEY = "mcode-expanded-projects";
const LEGACY_SHOW_MORE_KEY = "mcode-expanded-thread-lists";

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

function readLegacyFlags(key: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return new Set();
    return new Set(Object.entries(parsed).filter(([, on]) => on === true).map(([id]) => id));
  } catch {
    return new Set();
  }
}

function stringSet(value: readonly string[] | undefined, fallback: ReadonlySet<string>): ReadonlySet<string> {
  return Array.isArray(value) ? new Set(value.filter((id) => typeof id === "string")) : fallback;
}

function isSidebarView(value: unknown): value is SidebarView {
  return value === "projects" || value === "threads";
}

function mergePersisted(persisted: unknown, current: SidebarUiState & SidebarUiActions): SidebarUiState & SidebarUiActions {
  const stored: PersistedSidebarUi = typeof persisted === "object" && persisted !== null ? persisted : {};
  return {
    ...current,
    view: isSidebarView(stored.view) ? stored.view : current.view,
    expandedProjects: stringSet(stored.expandedProjects, current.expandedProjects),
    showMore: stringSet(stored.showMore, current.showMore),
  };
}

/**
 * Sidebar scope, view and section state. The view, open projects and Show more choices persist across app sessions.
 */
export const useSidebarUiStore = create<SidebarUiState & SidebarUiActions>()(
  persist(
    (set) => ({
      scope: "active",
      view: "projects",
      olderOpen: false,
      expandedProjects: readLegacyFlags(LEGACY_EXPANDED_KEY),
      collapsedOlderProjects: new Set(),
      showMore: readLegacyFlags(LEGACY_SHOW_MORE_KEY),
      frozen: null,
      setScope: (scope) => set({ scope }),
      toggleView: () => set((state) => ({ view: state.view === "projects" ? "threads" : "projects" })),
      toggleOlder: () => set((state) => ({ olderOpen: !state.olderOpen })),
      toggleProject: (workspaceId, section) =>
        set((state) => section === "older"
          ? { collapsedOlderProjects: toggled(state.collapsedOlderProjects, workspaceId) }
          : { expandedProjects: toggled(state.expandedProjects, workspaceId) }),
      toggleShowMore: (workspaceId) => set((state) => ({ showMore: toggled(state.showMore, workspaceId) })),
      freeze: (snapshot) => set({ frozen: snapshot }),
      unfreeze: () => set({ frozen: null }),
    }),
    {
      name: "mcode-sidebar-ui",
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedSidebarUi => ({
        view: state.view,
        expandedProjects: [...state.expandedProjects],
        showMore: [...state.showMore],
      }),
      merge: mergePersisted,
    },
  ),
);

/**
 * Returns Active when no threads are completed, otherwise the requested scope.
 */
export function effectiveSidebarScope(scope: SidebarScope, completedCount: number): SidebarScope {
  return completedCount === 0 ? "active" : scope;
}

/** Projects in `projectOrder` the user has not opened, which the model reads as collapsed. */
export function collapsedProjectsOf(projectOrder: readonly string[], expanded: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(projectOrder.filter((id) => !expanded.has(id)));
}
