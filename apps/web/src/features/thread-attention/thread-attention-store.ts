import { create } from "zustand";
import type { SeenMark, ThreadAttention } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

/** A thread must remain focused and visible this long before its rendered outcome is seen. */
export const ACKNOWLEDGE_SEEN_DWELL_MS = 150;

interface ThreadAttentionState {
  byThreadId: Record<string, ThreadAttention>;
  visitBaselines: Record<string, number | null>;
  /** The active thread while its window is visible and focused; its outcomes count as seen. */
  onScreenThreadId: string | null;
  apply(attention: ThreadAttention): void;
  hydrate(attention: ThreadAttention[], observed: Record<string, ThreadAttention>): void;
  refreshOnScreen(activeThreadId: string | null, renderedSequence: number | null): void;
}

function laterMark(previous: SeenMark | undefined, current: SeenMark): SeenMark {
  return previous && (previous.sequence ?? -1) > (current.sequence ?? -1) ? previous : current;
}

function pauseCompletedThread(threadId: string): void {
  useWorkspaceStore.setState((state) => ({ threads: state.threads.map((thread) =>
    thread.id === threadId && thread.status === "completed" ? { ...thread, status: "paused" } : thread) }));
}

/** Attention facts, optimistic acknowledgements, and the baseline for the current visit. */
export const threadAttentionStore = create<ThreadAttentionState>((set, get) => {
  let activeThread: string | null = null;
  let onScreen: string | null = null;
  let rendered: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visit = 0;

  const applySeen = (threadId: string, mark: SeenMark): void => set((state) => {
    const attention = state.byThreadId[threadId] ?? { threadId, waiting: null, lastTurn: null, seen: { sequence: null, at: null } };
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
    byThreadId: {}, visitBaselines: {}, onScreenThreadId: null,
    apply: (attention) => {
      set((state) => ({ byThreadId: { ...state.byThreadId, [attention.threadId]: {
        ...attention, seen: laterMark(state.byThreadId[attention.threadId]?.seen, attention.seen),
      } } }));
      if (attention.lastTurn?.outcome === "completed" && (attention.seen.sequence ?? -1) >= attention.lastTurn.sequence) {
        pauseCompletedThread(attention.threadId);
      }
    },
    hydrate: (attention, observed) => {
      const received = new Map(attention.map((item) => [item.threadId, item]));
      for (const [threadId, old] of Object.entries(observed)) {
        if (get().byThreadId[threadId] === old && !received.has(threadId)) {
          get().apply({ ...old, waiting: null, lastTurn: null });
        }
      }
      for (const item of attention) {
        if (get().byThreadId[item.threadId] === observed[item.threadId]) get().apply(item);
      }
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
      const visible = document.visibilityState === "visible" && document.hasFocus() ? threadId : null;
      if (onScreen === visible && rendered === sequence) return;
      if (onScreen !== visible) set({ onScreenThreadId: visible });
      onScreen = visible;
      rendered = sequence;
      clearTimeout(timer);
      timer = undefined;
      if (visible === null || sequence === null) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (onScreen === visible && document.visibilityState === "visible" && document.hasFocus()) {
          void acknowledge(visible, sequence);
        }
      }, ACKNOWLEDGE_SEEN_DWELL_MS);
    },
  };
});
