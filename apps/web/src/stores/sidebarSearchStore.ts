import { create } from "zustand";
import { getTransport } from "@/transport";
import type { Thread } from "@/transport/types";

/** Sort field for threads in the sidebar. */
export type ThreadSortField = "updated_at" | "created_at" | "title";

/** Sort direction. */
export type SortDirection = "asc" | "desc";

/** Active filter state. */
export interface ThreadFilters {
  status: string[];
  provider: string[];
}

/** Persisted preferences restored from localStorage. */
interface PersistedPrefs {
  sortField: ThreadSortField;
  sortDirection: SortDirection;
  filters: ThreadFilters;
}

const STORAGE_KEY = "mcode-sidebar-search-prefs";

function loadPrefs(): PersistedPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { sortField: "updated_at", sortDirection: "desc", filters: { status: [], provider: [] } };
    return JSON.parse(raw);
  } catch {
    return { sortField: "updated_at", sortDirection: "desc", filters: { status: [], provider: [] } };
  }
}

function savePrefs(prefs: PersistedPrefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

interface SidebarSearchState {
  /** Current search query text. */
  query: string;
  /** Whether a server-side search is in flight. */
  isSearching: boolean;
  /** Threads returned from the server search (from unloaded workspaces). */
  serverResults: Thread[];
  /** Workspace context for server results (id, name, path). */
  serverWorkspaces: { id: string; name: string; path: string }[];
  /** Active sort field. */
  sortField: ThreadSortField;
  /** Active sort direction. */
  sortDirection: SortDirection;
  /** Active filters. */
  filters: ThreadFilters;
  /** Snapshot of expanded state before search began (for restoring on clear). */
  expandedSnapshot: Record<string, boolean> | null;

  setQuery: (query: string) => void;
  setSortField: (field: ThreadSortField) => void;
  setSortDirection: (dir: SortDirection) => void;
  toggleSortDirection: () => void;
  toggleFilter: (category: "status" | "provider", value: string) => void;
  clearFilters: () => void;
  clearAll: () => void;
  setExpandedSnapshot: (snapshot: Record<string, boolean>) => void;
  /** Debounced server search. Call after query/filter changes. */
  executeServerSearch: () => Promise<void>;
}

/** Sidebar search, filter, and sort state. */
export const useSidebarSearchStore = create<SidebarSearchState>((set, get) => {
  const prefs = loadPrefs();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    query: "",
    isSearching: false,
    serverResults: [],
    serverWorkspaces: [],
    sortField: prefs.sortField,
    sortDirection: prefs.sortDirection,
    filters: prefs.filters,
    expandedSnapshot: null,

    setQuery: (query) => {
      set({ query });
      if (debounceTimer) clearTimeout(debounceTimer);
      if (!query.trim()) {
        set({ serverResults: [], serverWorkspaces: [], isSearching: false });
        return;
      }
      set({ isSearching: true });
      debounceTimer = setTimeout(() => {
        get().executeServerSearch();
      }, 250);
    },

    setSortField: (field) => {
      set({ sortField: field });
      const { sortDirection, filters } = get();
      savePrefs({ sortField: field, sortDirection, filters });
    },

    setSortDirection: (dir) => {
      set({ sortDirection: dir });
      const { sortField, filters } = get();
      savePrefs({ sortField, sortDirection: dir, filters });
    },

    toggleSortDirection: () => {
      const dir = get().sortDirection === "asc" ? "desc" : "asc";
      get().setSortDirection(dir);
    },

    toggleFilter: (category, value) => {
      const filters = { ...get().filters };
      const arr = [...filters[category]];
      const idx = arr.indexOf(value);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(value);
      filters[category] = arr;
      set({ filters });
      const { sortField, sortDirection } = get();
      savePrefs({ sortField, sortDirection, filters });
    },

    clearFilters: () => {
      const filters = { status: [], provider: [] };
      set({ filters });
      const { sortField, sortDirection } = get();
      savePrefs({ sortField, sortDirection, filters });
    },

    clearAll: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      set({
        query: "",
        serverResults: [],
        serverWorkspaces: [],
        isSearching: false,
        expandedSnapshot: null,
      });
    },

    setExpandedSnapshot: (snapshot) => {
      if (!get().expandedSnapshot) {
        set({ expandedSnapshot: snapshot });
      }
    },

    executeServerSearch: async () => {
      const { query, filters, sortField, sortDirection } = get();
      if (!query.trim()) {
        set({ isSearching: false, serverResults: [], serverWorkspaces: [] });
        return;
      }
      try {
        const result = await getTransport().searchThreads({
          query: query.trim(),
          filters: {
            status: filters.status.length > 0 ? filters.status : undefined,
            provider: filters.provider.length > 0 ? filters.provider : undefined,
          },
          sort: { field: sortField, direction: sortDirection },
        });
        // Only apply results if query hasn't changed during the request
        if (get().query.trim() === query.trim()) {
          set({
            serverResults: result.threads,
            serverWorkspaces: result.workspaces,
            isSearching: false,
          });
        }
      } catch {
        set({ isSearching: false });
      }
    },
  };
});
