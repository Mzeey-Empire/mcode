import { create } from "zustand";
import type { Thread } from "@mcode/contracts/models/thread";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "../state/workspaceStore";
import { HOLD_MS, transitionCompletion, type CompletionEntry, type CompletionEvent } from "./completion-machine";

interface CompletionStoreState {
  readonly entries: ReadonlyMap<string, CompletionEntry>;
  readonly hoveredThreadId: string | null;
  /** The thread this client or auto-completion last completed, offered for Undo under the scope bar. */
  readonly undoLineThreadId: string | null;
}

interface CompletionStoreActions {
  complete(threadId: string): void;
  undo(threadId: string): void;
  retry(threadId: string): void;
  pointerEntered(threadId: string): void;
  pointerLeft(threadId: string): void;
  /** Applies a lifecycle push; an automatic completion offers the Undo line like a local one. */
  observeServerLifecycle(threadId: string, completed: boolean, completedAutomatically?: boolean): void;
  /** Applies an activity push; it clears a refusal whose reason is now stale. */
  observeServerActivity(threadId: string): void;
  /** Reopens the Undo line's completed thread. */
  undoFromLine(): void;
  hideUndoLine(): void;
}

type CompletionStore = CompletionStoreState & CompletionStoreActions;

let nextAttempt = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The Undo line takes over from the row when a confirmed completion's row is released.
function leftActive(previous: CompletionEntry | undefined, next: CompletionEntry | undefined, event: CompletionEvent): boolean {
  if (next !== undefined) return false;
  if (event.type === "confirmed") return true;
  return event.type === "pointer-left" && previous?.phase === "lingering";
}

/**
 * Holds optimistic completions across row unmounts. Undo cancels the server hold; confirmed
 * completions apply the server lifecycle and release resources.
 */
export const useCompletionStore = create<CompletionStore>((set, get) => {
  const confirmedThreads = new Map<string, Thread>();

  const dispatch = (threadId: string, event: CompletionEvent): void => {
    const previous = get().entries.get(threadId);
    const { next, effects } = transitionCompletion(previous, event);
    if (next !== previous) {
      const entries = new Map(get().entries);
      if (next) entries.set(threadId, next);
      else entries.delete(threadId);
      set({ entries, ...(leftActive(previous, next, event) ? { undoLineThreadId: threadId } : {}) });
    }
    for (const effect of effects) {
      if (effect.type === "send-complete") sendComplete(threadId, effect.attempt);
      else if (effect.type === "send-reopen") void useWorkspaceStore.getState().reopenThread(threadId).catch(() => undefined);
      else applyConfirmed(threadId);
    }
  };

  const applyConfirmed = (threadId: string): void => {
    const thread = confirmedThreads.get(threadId);
    confirmedThreads.delete(threadId);
    if (thread) useWorkspaceStore.getState().applyThreadLifecycle(thread);
  };

  const sendComplete = (threadId: string, attempt: number): void => {
    getTransport().completeThread(threadId, HOLD_MS).then(
      (result) => {
        if (!result.ok) {
          dispatch(threadId, { type: "refused", attempt, refusal: result.refusal });
          return;
        }
        confirmedThreads.set(threadId, result.thread);
        dispatch(threadId, { type: "confirmed", attempt, pointerOnRow: get().hoveredThreadId === threadId });
        confirmedThreads.delete(threadId);
      },
      (error: unknown) => dispatch(threadId, { type: "connection-failed", attempt, message: errorMessage(error) }),
    );
  };

  return {
    entries: new Map(),
    hoveredThreadId: null,
    undoLineThreadId: null,
    complete: (threadId) => dispatch(threadId, { type: "complete", attempt: ++nextAttempt }),
    undo: (threadId) => dispatch(threadId, { type: "undo" }),
    retry: (threadId) => dispatch(threadId, { type: "retry", attempt: ++nextAttempt }),
    pointerEntered: (threadId) => set({ hoveredThreadId: threadId }),
    pointerLeft: (threadId) => {
      if (get().hoveredThreadId === threadId) set({ hoveredThreadId: null });
      dispatch(threadId, { type: "pointer-left" });
    },
    observeServerLifecycle: (threadId, completed, completedAutomatically = false) => {
      if (!completed && get().undoLineThreadId === threadId) set({ undoLineThreadId: null });
      if (completed && completedAutomatically) set({ undoLineThreadId: threadId });
      dispatch(threadId, { type: "server-lifecycle", completed });
    },
    observeServerActivity: (threadId) => dispatch(threadId, { type: "server-activity" }),
    undoFromLine: () => {
      const threadId = get().undoLineThreadId;
      if (threadId === null) return;
      set({ undoLineThreadId: null });
      void useWorkspaceStore.getState().reopenThread(threadId).catch(() => undefined);
    },
    hideUndoLine: () => set({ undoLineThreadId: null }),
  };
});
