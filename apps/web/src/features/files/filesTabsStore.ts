import { create } from "zustand";

/** Default docked tree width in px. */
export const FILES_TREE_DEFAULT_WIDTH = 280;
/** Narrowest the docked tree can be dragged. */
export const FILES_TREE_MIN_WIDTH = 220;
/** Widest the docked tree can be dragged. */
export const FILES_TREE_MAX_WIDTH = 480;

/** How a markdown or SVG tab shows: rendered (the default) or as highlighted source. */
export type FileViewMode = "rendered" | "source";
/** Image zoom: fit the body (the default), natural size, or twice natural size. */
export type ImageScale = "fit" | "100" | "200";

/** Files tool state for one panel scope (thread id, or workspace id when threadless). */
export interface FilesScopeState {
  readonly openPaths: readonly string[];
  readonly activePath: string | null;
  readonly treeOpen: boolean;
  readonly expandedFolders: ReadonlySet<string>;
  readonly revealPath: string | null;
  readonly treeWidth: number;
  /** Whether Go to file is open; stored here because `files.goToFile` can fire before the tool mounts. */
  readonly goToFileOpen: boolean;
  /** Whether the find bar is open; stored here for the same reason as `goToFileOpen`. */
  readonly findOpen: boolean;
  /** Per-path view mode; absent means "rendered". */
  readonly viewModes: Readonly<Record<string, FileViewMode>>;
  /** Per-path image scale; absent means "fit". */
  readonly imageScales: Readonly<Record<string, ImageScale>>;
}

export const FILES_SCOPE_DEFAULTS: FilesScopeState = {
  openPaths: [],
  activePath: null,
  treeOpen: true,
  expandedFolders: new Set(),
  revealPath: null,
  treeWidth: FILES_TREE_DEFAULT_WIDTH,
  goToFileOpen: false,
  findOpen: false,
  viewModes: {},
  imageScales: {},
};

interface FilesTabsStore {
  readonly scopes: Readonly<Record<string, FilesScopeState>>;
  /** Opens `path` as a tab after the active one, or focuses it if already open. */
  openFile(scopeId: string, path: string, options?: { readonly activate?: boolean }): void;
  /** Closes a tab; the neighbor to its left becomes active. */
  closeFile(scopeId: string, path: string): void;
  setActiveFile(scopeId: string, path: string): void;
  setTreeOpen(scopeId: string, open: boolean): void;
  toggleFolder(scopeId: string, path: string): void;
  reveal(scopeId: string, folders: readonly string[], target: string): void;
  clearReveal(scopeId: string): void;
  setTreeWidth(scopeId: string, width: number): void;
  setGoToFileOpen(scopeId: string, open: boolean): void;
  setFindOpen(scopeId: string, open: boolean): void;
  setViewMode(scopeId: string, path: string, mode: FileViewMode): void;
  setImageScale(scopeId: string, path: string, scale: ImageScale): void;
}

/** Clamps a dragged tree width into the allowed range. */
export function clampTreeWidth(width: number): number {
  return Math.min(FILES_TREE_MAX_WIDTH, Math.max(FILES_TREE_MIN_WIDTH, Math.round(width)));
}

function insertAfterActive(state: FilesScopeState, path: string): readonly string[] {
  const activeIndex = state.activePath ? state.openPaths.indexOf(state.activePath) : -1;
  const next = [...state.openPaths];
  next.splice(activeIndex + 1, 0, path);
  return next;
}

function withOpened(state: FilesScopeState, path: string, activate: boolean): FilesScopeState {
  const alreadyOpen = state.openPaths.includes(path);
  const openPaths = alreadyOpen ? state.openPaths : insertAfterActive(state, path);
  const activePath = activate || state.activePath === null ? path : state.activePath;
  return { ...state, openPaths, activePath };
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function withClosed(state: FilesScopeState, path: string): FilesScopeState {
  const index = state.openPaths.indexOf(path);
  if (index < 0) return state;
  const openPaths = state.openPaths.filter((open) => open !== path);
  const viewModes = without(state.viewModes, path);
  const imageScales = without(state.imageScales, path);
  const activePath = state.activePath === path ? (openPaths[Math.max(0, index - 1)] ?? null) : state.activePath;
  return { ...state, openPaths, activePath, viewModes, imageScales };
}

/**
 * In-memory Files tool state keyed per panel scope, like the terminal store:
 * each thread (or the threadless workspace) keeps its own tabs and tree.
 */
export const useFilesTabsStore = create<FilesTabsStore>((set) => {
  const update = (scopeId: string, change: (state: FilesScopeState) => FilesScopeState) =>
    set((store) => {
      const current = store.scopes[scopeId] ?? FILES_SCOPE_DEFAULTS;
      const next = change(current);
      return next === current ? store : { scopes: { ...store.scopes, [scopeId]: next } };
    });
  return {
    scopes: {},
    openFile: (scopeId, path, options) => update(scopeId, (state) => withOpened(state, path, options?.activate ?? true)),
    closeFile: (scopeId, path) => update(scopeId, (state) => withClosed(state, path)),
    setActiveFile: (scopeId, path) => update(scopeId, (state) => ({ ...state, activePath: path })),
    setTreeOpen: (scopeId, open) => update(scopeId, (state) => ({ ...state, treeOpen: open })),
    toggleFolder: (scopeId, path) =>
      update(scopeId, (state) => {
        const expandedFolders = new Set(state.expandedFolders);
        if (!expandedFolders.delete(path)) expandedFolders.add(path);
        return { ...state, expandedFolders };
      }),
    reveal: (scopeId, folders, target) =>
      update(scopeId, (state) => ({
        ...state,
        treeOpen: true,
        expandedFolders: new Set([...state.expandedFolders, ...folders]),
        revealPath: target,
      })),
    clearReveal: (scopeId) => update(scopeId, (state) => (state.revealPath === null ? state : { ...state, revealPath: null })),
    setTreeWidth: (scopeId, width) => update(scopeId, (state) => ({ ...state, treeWidth: clampTreeWidth(width) })),
    setGoToFileOpen: (scopeId, open) =>
      update(scopeId, (state) => (state.goToFileOpen === open ? state : { ...state, goToFileOpen: open })),
    setFindOpen: (scopeId, open) =>
      update(scopeId, (state) => (state.findOpen === open ? state : { ...state, findOpen: open })),
    setViewMode: (scopeId, path, mode) =>
      update(scopeId, (state) => ({ ...state, viewModes: { ...state.viewModes, [path]: mode } })),
    setImageScale: (scopeId, path, scale) =>
      update(scopeId, (state) => ({ ...state, imageScales: { ...state.imageScales, [path]: scale } })),
  };
});

/** Reads one scope's Files state, falling back to defaults. */
export function getFilesScope(scopeId: string): FilesScopeState {
  return useFilesTabsStore.getState().scopes[scopeId] ?? FILES_SCOPE_DEFAULTS;
}
