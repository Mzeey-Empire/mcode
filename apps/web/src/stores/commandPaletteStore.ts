import { create } from "zustand";

/**
 * A palette view pushed onto the viewStack.
 *
 * Folder browsing has no view of its own. Any view flips into browse mode when
 * the query starts with a path prefix (see `isBrowseQuery`). `sources` lists the
 * places a project can come from, and its Local folder row sets the query to `~/`.
 */
export type View =
  | { kind: "root" }
  | { kind: "sources" }
  | { kind: "projects" }
  | { kind: "threadSearch" }
  | { kind: "selectionList"; title: string; items: { id: string; title: string }[]; onPick: (id: string) => void };

type OpenIntent = "projects" | "threadSearch" | "addProject";

const INTENT_VIEW_KIND = {
  projects: "projects",
  threadSearch: "threadSearch",
  addProject: "sources",
} as const satisfies Record<OpenIntent, View["kind"]>;

/** Options for {@link State.open}. A starting folder only makes sense when adding a project. */
export type OpenOptions =
  | { intent?: Exclude<OpenIntent, "addProject"> }
  | { intent: "addProject"; path?: string };

/**
 * Browse query that lists the folder at `path` itself: a trailing separator
 * makes `splitBrowseQuery` treat the whole path as the directory, not a leaf filter.
 */
function directoryBrowseQuery(path: string): string {
  if (/[\\/]$/.test(path)) return path;
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  return path + separator;
}

function initialQuery(opts: OpenOptions | undefined): string {
  return opts && "path" in opts && opts.path ? directoryBrowseQuery(opts.path) : "";
}

interface State {
  /** Whether the palette overlay is visible. */
  isOpen: boolean;
  /** Navigation stack of views; the last entry is the active view. */
  viewStack: View[];
  /** Current search query for the active view. */
  query: string;
  /**
   * Optional confirm action registered by the active view (e.g. browse mode's
   * "Add this folder" handler). Called when the user presses Ctrl/Cmd+Enter.
   */
  pendingConfirm: (() => void) | null;
  /** Optional parent-directory action for the active browse view. */
  pendingBack: (() => void) | null;
  /**
   * Open the palette, optionally at a specific intent.
   * - `projects`: open at the projects view.
   * - `threadSearch`: open the cross-project thread finder.
   * - `addProject`: open at the sources view; with a `path`, the query browses that folder.
   */
  open: (opts?: OpenOptions) => void;
  /** Push a new view onto the navigation stack and clear the query. */
  push: (view: View) => void;
  /** Pop the active view. Closes the palette if the stack would become empty. */
  pop: () => void;
  /** Close the palette, empty the stack, and reset the query. */
  close: () => void;
  /** Update the search query for the active view. */
  setQuery: (q: string) => void;
  /** Register a confirm action for the current view. Pass null to clear. */
  setPendingConfirm: (fn: (() => void) | null) => void;
  /** Register the parent-directory action for the current view. Pass null to clear. */
  setPendingBack: (fn: (() => void) | null) => void;
}

/**
 * Zustand store for command palette state.
 * Navigation is stack-based: each sub-view is pushed onto `viewStack` and
 * popped on back. Closing or popping the last view resets everything.
 */
export const useCommandPaletteStore = create<State>((set, get) => ({
  isOpen: false,
  viewStack: [],
  query: "",
  pendingConfirm: null,
  pendingBack: null,
  open: (opts) => {
    const intent = opts?.intent;
    const view: View = intent ? { kind: INTENT_VIEW_KIND[intent] } : { kind: "root" };
    set({ isOpen: true, viewStack: [view], query: initialQuery(opts), pendingConfirm: null, pendingBack: null });
  },
  push: (view) => set({
    viewStack: [...get().viewStack, view],
    query: "",
    pendingConfirm: null,
    pendingBack: null,
  }),
  pop: () => {
    const next = get().viewStack.slice(0, -1);
    if (next.length === 0) {
      set({ isOpen: false, viewStack: [], query: "", pendingConfirm: null, pendingBack: null });
    } else {
      set({ viewStack: next, query: "", pendingConfirm: null, pendingBack: null });
    }
  },
  close: () => set({ isOpen: false, viewStack: [], query: "", pendingConfirm: null, pendingBack: null }),
  setQuery: (q) => set({ query: q }),
  setPendingConfirm: (fn) => set({ pendingConfirm: fn }),
  setPendingBack: (fn) => set({ pendingBack: fn }),
}));
