import { create } from "zustand";

/** Edge the dev dock attaches to within the preview surface. */
export type PreviewDockEdge = "bottom" | "right";

/** Per-thread dock state: whether it is open and which edge it occupies. */
export interface PreviewDockState {
  readonly open: boolean;
  readonly edge: PreviewDockEdge;
}

const DEFAULT_DOCK: PreviewDockState = { open: false, edge: "bottom" };

interface PreviewDockStore {
  /** Map of threadId -> per-thread dock state. Threads without entries fall back to {@link DEFAULT_DOCK}. */
  readonly docks: Record<string, PreviewDockState>;
  /** Returns the current dock state for a thread, falling back to the default when absent. */
  getDock: (threadId: string) => PreviewDockState;
  /** Flip open/closed for the thread. Creates an entry on first use. */
  toggle: (threadId: string) => void;
  /** Explicitly set the open flag (used by the close button and the mod+shift+d shortcut). */
  setOpen: (threadId: string, open: boolean) => void;
  /** Switch the persisted edge the dock attaches to. */
  setEdge: (threadId: string, edge: PreviewDockEdge) => void;
}

/**
 * Per-thread persistence for the preview dev dock chrome. The dock houses
 * power-user surfaces (region crop, page-context dump, future debug rows) that
 * the primary toolbar deliberately omits, so this state is scoped to the thread
 * the user is currently working in — mirrors how URL memory lives in
 * usePreviewBridge.
 */
export const usePreviewDockStore = create<PreviewDockStore>((set, get) => ({
  docks: {},
  getDock: (threadId) => get().docks[threadId] ?? DEFAULT_DOCK,
  toggle: (threadId) => {
    const current = get().docks[threadId] ?? DEFAULT_DOCK;
    set({
      docks: {
        ...get().docks,
        [threadId]: { ...current, open: !current.open },
      },
    });
  },
  setOpen: (threadId, open) => {
    const current = get().docks[threadId] ?? DEFAULT_DOCK;
    if (current.open === open) return;
    set({
      docks: {
        ...get().docks,
        [threadId]: { ...current, open },
      },
    });
  },
  setEdge: (threadId, edge) => {
    const current = get().docks[threadId] ?? DEFAULT_DOCK;
    if (current.edge === edge) return;
    set({
      docks: {
        ...get().docks,
        [threadId]: { ...current, edge },
      },
    });
  },
}));
