import { create } from "zustand";

/** A palette view pushed onto the viewStack. */
export type View =
  | { kind: "root" }
  | { kind: "projects" }
  | { kind: "addProject"; path: string }
  | { kind: "selectionList"; title: string; items: { id: string; title: string }[]; onPick: (id: string) => void };

interface State {
  /** Whether the palette overlay is visible. */
  isOpen: boolean;
  /** Navigation stack of views; the last entry is the active view. */
  viewStack: View[];
  /** Current search query for the active view. */
  query: string;
  /**
   * Optional confirm action registered by the active view (e.g. AddProjectView's "Add" button).
   * Called when the user presses Ctrl/Cmd+Enter in the palette input.
   */
  pendingConfirm: (() => void) | null;
  /** Open the palette, optionally at a specific intent view. */
  open: (opts?: { intent?: "projects" | "addProject" }) => void;
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
}

/** Map an open intent to its initial View. */
const intentToView = (intent?: "projects" | "addProject"): View => {
  if (intent === "projects") return { kind: "projects" };
  if (intent === "addProject") return { kind: "addProject", path: "~/" };
  return { kind: "root" };
};

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
  open: (opts) => set({ isOpen: true, viewStack: [intentToView(opts?.intent)], query: "", pendingConfirm: null }),
  push: (view) => set({ viewStack: [...get().viewStack, view], query: "", pendingConfirm: null }),
  pop: () => {
    const next = get().viewStack.slice(0, -1);
    if (next.length === 0) {
      set({ isOpen: false, viewStack: [], query: "", pendingConfirm: null });
    } else {
      set({ viewStack: next, query: "", pendingConfirm: null });
    }
  },
  close: () => set({ isOpen: false, viewStack: [], query: "", pendingConfirm: null }),
  setQuery: (q) => set({ query: q }),
  setPendingConfirm: (fn) => set({ pendingConfirm: fn }),
}));

