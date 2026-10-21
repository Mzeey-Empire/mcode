import { create } from "zustand";
import type { SeenMark, ThreadAttention } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

/** A thread must remain focused and visible this long before its rendered outcome is seen. */
export const ACKNOWLEDGE_SEEN_DWELL_MS = 150;

/** Whether the user is looking at this Mcode window: visible and holding focus. */
export function isWindowFocused(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

interface ThreadAttentionState {
  byThreadId: Record<string, ThreadAttention>;
  visitBaselines: Record<string, number | null>;
  /** The active thread while its window is visible and focused; its outcomes count as seen. */
  onScreenThreadId: string | null;
  /** Counts snapshot hydrations, so observers can tell a reconnect replay from a live change. */
  hydrations: number;
  apply(attention: ThreadAttention): void;
  hydrate(attention: ThreadAttention[], observed: Record<string, ThreadAttention>): void;
  refreshOnScreen(activeThreadId: string | null, renderedSequence: number | null): void;
}

function laterMark(previous: SeenMark | undefined, current: SeenMark): SeenMark {
  return previous && (previous.sequence ?? -1) > (current.sequence ?? -1) ? previous : current;
}

function withAttention(byThreadId: Record<string, ThreadAttention>, attention: ThreadAttention): Record<string, ThreadAttention> {
  return { ...byThreadId, [attention.threadId]: {
    ...attention, seen: laterMark(byThreadId[attention.threadId]?.seen, attention.seen),
  } };
}

function pauseCompletedThread(threadId: string): void {
  useWorkspaceStore.setState((state) => ({ threads: state.threads.map((thread) =>
    thread.id === threadId && thread.status === "completed" ? { ...thread, status: "paused" } : thread) }));
}

function pauseIfSeenCompleted(attention: ThreadAttention): void {
  if (attention.lastTurn?.outcome === "completed" && (attention.seen.sequence ?? -1) >= attention.lastTurn.sequence) {
    pauseCompletedThread(attention.threadId);
  }
}

/**
 * This visit's Since you looked baseline for a thread: null when the visit has none yet, and a
 * null seen sequence (nothing seen before) counts as 0 so every settled turn is after it.
 */
export function sinceLookedBaseline(
  state: { readonly visitBaselines: Readonly<Record<string, number | null>> },
  threadId: string | null,
): number | null {
  if (threadId === null || !(threadId in state.visitBaselines)) return null;
  return state.visitBaselines[threadId] ?? 0;
}

/** Attention facts, optimistic acknowledgements, and the baseline for the current visit. */
export const threadAttentionStore = create<ThreadAttentionState>((set, get) => {
  let activeThread: string | null = null;
  let onScreen: string | null = null;
  let rendered: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visit = 0;

  const applySeen = (threadId: string, mark: SeenMark): void => set((state) => {
    const attention = state.byThreadId[threadId] ?? { threadId, waiting: null, lastTurn: null, seen: { sequence: null, at: null }, hasUnfinishedDelegatedTasks: false };
    return { byThreadId: { ...state.byThreadId, [threadId]: { ...attention, seen: laterMark(attention.seen, mark) } } };
  });

  const recordVisitBaseline = (threadId: string, sequence: number | null, acknowledgedVisit: number): void => {
    if (visit === acknowledgedVisit && activeThread === threadId && !(threadId in get().visitBaselines)) {
      set((state) => ({ visitBaselines: { ...state.visitBaselines, [threadId]: sequence } }));
    }
  };

  const acknowledge = async (threadId: string, sequence: number): Promise<void> => {
    if ((get().byThreadId[threadId]?.seen.sequence ?? -1) >= sequence) return;
    const acknowledgedVisit = visit;
    applySeen(threadId, { sequence, at: new Date().toISOString() });
    try {
      const { previous, current } = await getTransport().acknowledgeSeen(threadId, sequence);
      if ((previous.sequence ?? -1) < (current.sequence ?? -1)) {
        recordVisitBaseline(threadId, previous.sequence, acknowledgedVisit);
        pauseCompletedThread(threadId);
      }
      applySeen(threadId, current);
    } catch (error) {
      console.warn("[thread-attention] acknowledgement failed", { threadId, sequence, error });
    }
  };

  return {
    byThreadId: {}, visitBaselines: {}, onScreenThreadId: null, hydrations: 0,
    apply: (attention) => {
      set((state) => ({ byThreadId: withAttention(state.byThreadId, attention) }));
      pauseIfSeenCompleted(attention);
    },
    hydrate: (attention, observed) => {
      const current = get().byThreadId;
      const received = new Set(attention.map((item) => item.threadId));
      const cleared = Object.entries(observed).flatMap(([threadId, old]) =>
        current[threadId] === old && !received.has(threadId) ? [{ ...old, waiting: null, lastTurn: null, hasUnfinishedDelegatedTasks: false }] : []);
      const updates = [...cleared, ...attention.filter((item) => current[item.threadId] === observed[item.threadId])];
      // One set per snapshot, so the counter and the facts it replays land together.
      set((state) => ({ hydrations: state.hydrations + 1, byThreadId: updates.reduce(withAttention, state.byThreadId) }));
      updates.forEach(pauseIfSeenCompleted);
    },
    refreshOnScreen: (threadId, sequence) => {
      if (activeThread !== threadId) {
        activeThread = threadId;
        visit += 1;
        if (threadId) set((state) => {
          const visitBaselines = { ...state.visitBaselines };
          delete visitBaselines[threadId];
          return { visitBaselines };
        });
      }
      const visible = isWindowFocused() ? threadId : null;
      if (onScreen === visible && rendered === sequence) return;
      if (onScreen !== visible) set({ onScreenThreadId: visible });
      onScreen = visible;
      rendered = sequence;
      clearTimeout(timer);
      timer = undefined;
      if (visible === null || sequence === null) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (onScreen === visible && isWindowFocused()) {
          void acknowledge(visible, sequence);
        }
      }, ACKNOWLEDGE_SEEN_DWELL_MS);
    },
  };
});
