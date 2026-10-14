import { create } from "zustand";

/** The page edge a resize handle drags. */
export type ViewportDragEdge = "right" | "bottom";

interface ViewportDragStore {
  /** Edge under the pointer, or null when no handle is being dragged. */
  readonly edge: ViewportDragEdge | null;
  setEdge: (edge: ViewportDragEdge | null) => void;
}

/**
 * Links the canvas handle being dragged to the device row's matching field.
 * The two render in different trees, and a pointer drags one handle at a time,
 * so one app-wide edge is enough.
 */
export const useViewportDragStore = create<ViewportDragStore>((set) => ({
  edge: null,
  setEdge: (edge) => set({ edge }),
}));
