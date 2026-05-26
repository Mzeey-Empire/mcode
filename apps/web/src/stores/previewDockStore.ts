import { create } from "zustand";

/** Edge the capture dock attaches to within the preview surface. */
export type PreviewDockEdge = "bottom" | "right";

/** Per-thread dock state: open flag, persisted edge, persisted size in px. */
export interface PreviewDockState {
  readonly open: boolean;
  readonly edge: PreviewDockEdge;
  /**
   * Pixel size along the axis perpendicular to the dock's edge: height when
   * the dock is at the bottom, width when at the right. Resizable via the
   * draggable splitter on the surface/dock boundary.
   */
  readonly size: number;
}

/** Lower bound so the dock never collapses to a sliver where rows are unreadable. */
export const MIN_DOCK_SIZE = 120;
/** Upper bound so the surface itself does not get squeezed out. */
export const MAX_DOCK_SIZE = 800;

/** Sensible per-edge defaults (roughly the old hardcoded h-[min(28vh,16rem)] / w-[min(32vw,22rem)]). */
const DEFAULT_SIZE_BY_EDGE: Record<PreviewDockEdge, number> = {
  bottom: 240,
  right: 320,
};

const DEFAULT_DOCK: PreviewDockState = {
  open: false,
  edge: "bottom",
  size: DEFAULT_SIZE_BY_EDGE.bottom,
};

interface PreviewDockStore {
  /** Map of threadId -> per-thread dock state. Threads without entries fall back to {@link DEFAULT_DOCK}. */
  readonly docks: Record<string, PreviewDockState>;
  /** Returns the current dock state for a thread, falling back to the default when absent. */
  getDock: (threadId: string) => PreviewDockState;
  /** Flip open/closed for the thread. Creates an entry on first use. */
  toggle: (threadId: string) => void;
  /** Explicitly set the open flag (used by the close button and the mod+shift+d shortcut). */
  setOpen: (threadId: string, open: boolean) => void;
  /** Switch the persisted edge the dock attaches to. Resets size to the per-edge default. */
  setEdge: (threadId: string, edge: PreviewDockEdge) => void;
  /** Update the persisted size (clamped between MIN_DOCK_SIZE and MAX_DOCK_SIZE). */
  setSize: (threadId: string, size: number) => void;
}

/**
 * Per-thread persistence for the preview capture dock chrome. The dock houses
 * capture utilities (region crop, page-context dump) that the primary toolbar
 * deliberately omits, so this state is scoped to the thread the user is
 * currently working in. Mirrors how URL memory lives in usePreviewBridge.
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
        [threadId]: { ...current, edge, size: DEFAULT_SIZE_BY_EDGE[edge] },
      },
    });
  },
  setSize: (threadId, size) => {
    const current = get().docks[threadId] ?? DEFAULT_DOCK;
    const clamped = Math.max(MIN_DOCK_SIZE, Math.min(MAX_DOCK_SIZE, Math.round(size)));
    if (current.size === clamped) return;
    set({
      docks: {
        ...get().docks,
        [threadId]: { ...current, size: clamped },
      },
    });
  },
}));
