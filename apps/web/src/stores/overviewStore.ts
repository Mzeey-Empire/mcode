import { create } from "zustand";

/** How the Overview card shows for one subject: beside the conversation, floating over it, or not at all. */
export type OverviewPresentation = "docked" | "overlay" | "hidden";

/**
 * Store key for one Overview subject: `thread:<id>` for a thread, `new-thread:<workspaceId>` for a
 * new thread.
 */
export type OverviewSubjectKey = `thread:${string}` | `new-thread:${string}`;

/** Store key for a thread's Overview. */
export function threadOverviewKey(threadId: string): OverviewSubjectKey {
  return `thread:${threadId}`;
}

interface OverviewState {
  /** Subjects whose docked card the user closed. The choice lasts for the session. */
  closedSubjects: ReadonlySet<OverviewSubjectKey>;
  /** The one subject whose card floats over a canvas that cannot dock it. */
  overlaySubject: OverviewSubjectKey | null;
  /** Subject whose Overview should show once its chat surface mounts. */
  requestedSubject: OverviewSubjectKey | null;
  /** The header button: closes or reopens the docked card, or shows and hides the overlay. */
  toggle: (key: OverviewSubjectKey, dockable: boolean) => void;
  /** Closes the overlay after Esc, an outside press, or the canvas regaining room to dock. */
  dismissOverlay: (key: OverviewSubjectKey) => void;
  /** Request that one thread's Overview show after navigation. */
  requestOpen: (threadId: string) => void;
  /** Shows a requested Overview the way the canvas allows, then clears the request. */
  consumeOpenRequest: (key: OverviewSubjectKey, dockable: boolean) => void;
}

function withoutKey(set: ReadonlySet<OverviewSubjectKey>, key: OverviewSubjectKey): ReadonlySet<OverviewSubjectKey> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

/** Session-scoped Overview visibility, shared by the header button, the chat pane and the toast lane. */
export const useOverviewStore = create<OverviewState>((set) => ({
  closedSubjects: new Set(),
  overlaySubject: null,
  requestedSubject: null,
  toggle: (key, dockable) =>
    set((state) => {
      if (!dockable) return { overlaySubject: state.overlaySubject === key ? null : key };
      const closedSubjects = state.closedSubjects.has(key)
        ? withoutKey(state.closedSubjects, key)
        : new Set([...state.closedSubjects, key]);
      return { closedSubjects, overlaySubject: null };
    }),
  dismissOverlay: (key) =>
    set((state) => (state.overlaySubject === key ? { overlaySubject: null } : state)),
  requestOpen: (threadId) => set({ requestedSubject: threadOverviewKey(threadId) }),
  consumeOpenRequest: (key, dockable) =>
    set((state) =>
      state.requestedSubject === key
        ? {
            requestedSubject: null,
            closedSubjects: withoutKey(state.closedSubjects, key),
            overlaySubject: dockable ? state.overlaySubject : key,
          }
        : state,
    ),
}));

/**
 * Resolves the card's presentation. A canvas that can dock shows the card unless the user closed
 * it; one that cannot (right panel open, or narrower than the dock minimum) shows it only as the
 * overlay the header button opened.
 */
export function overviewPresentation(args: {
  closed: boolean;
  overlay: boolean;
  dockable: boolean;
}): OverviewPresentation {
  if (args.dockable) return args.closed ? "hidden" : "docked";
  return args.overlay ? "overlay" : "hidden";
}
